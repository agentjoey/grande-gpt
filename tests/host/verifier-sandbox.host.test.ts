import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeGit } from "../../src/gitExec.ts";
import { buildHostVerifierSandboxPlan } from "../../src/hostVerifierSandbox.ts";
import { loadLayout } from "../../src/layout.ts";
import { defaultExecRoots, runSandboxed } from "../../src/sandbox.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grande-host-verifier-probe-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function permissionDenied(code: unknown): boolean {
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}

function makeVerifierFixture() {
  const layout = loadLayout();
  const rawSource = join(root, "source");
  const rawDeps = join(root, "deps");
  const rawJobTmp = join(root, "job");
  for (const dir of [
    rawSource,
    rawDeps,
    rawJobTmp,
    join(rawJobTmp, "home"),
    join(rawJobTmp, "tmp"),
    join(rawJobTmp, "cache"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // macOS exposes /var and /tmp as symlink aliases of /private/var and /private/tmp.
  // Seatbelt matches the path spelling used at runtime against profile literals/subpaths;
  // the verifier plan is intentionally built from real paths, so the argv/cwd used by
  // the probe must use those same canonical spellings rather than the tmpdir() alias.
  const source = realpathSync(rawSource);
  const deps = realpathSync(rawDeps);
  const jobTmp = realpathSync(rawJobTmp);
  const node = realpathSync(process.execPath);
  const toolchainReadRoots = [...new Set([dirname(node), "/usr/bin", "/bin"])]
    .map((path) => realpathSync(path));
  const executableFiles = [...new Set([
    node,
    realpathSync("/usr/bin/sandbox-exec"),
    realpathSync("/bin/sh"),
    realpathSync("/bin/cat"),
  ])];
  const plan = buildHostVerifierSandboxPlan({
    verifierWorktree: source,
    dependencyRoots: [deps],
    jobTmp,
    controlRoot: layout.controlRoot,
    workspaceRoot: layout.workspaceRoot,
    canonicalRepo: realpathSync(join(layout.workspaceRoot, "grande-gpt")),
    taskWorktree: realpathSync(process.cwd()),
    databasePath: layout.stateDb,
    toolchainReadRoots,
    executableFiles,
    productionPort: Number(process.env.PORT ?? "8787"),
  });
  const profilePath = join(jobTmp, "verifier.sb");
  writeFileSync(profilePath, plan.profile, "utf8");
  return { layout, source, deps, jobTmp, node, plan, profilePath };
}

function runVerifierNode(
  fixture: ReturnType<typeof makeVerifierFixture>,
  scriptName: string,
  source: string,
  args: readonly string[] = [],
) {
  const scriptPath = join(fixture.source, scriptName);
  writeFileSync(scriptPath, source, "utf8");
  return spawnSync(
    "/usr/bin/sandbox-exec",
    ["-f", fixture.profilePath, fixture.node, scriptPath, ...args],
    {
      cwd: fixture.source,
      env: fixture.plan.env,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    },
  );
}

function rawGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ipv4ToUint32(value: string): number | undefined {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function uint32ToIpv4(value: number): string {
  const n = value >>> 0;
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

function nonLoopbackLanPeer(): string | undefined {
  const local = new Set<string>();
  const candidates: Array<{ address: string; netmask: string }> = [];
  for (const values of Object.values(networkInterfaces())) {
    for (const entry of values ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      local.add(entry.address);
      candidates.push({ address: entry.address, netmask: entry.netmask });
    }
  }

  for (const entry of candidates) {
    const ip = ipv4ToUint32(entry.address);
    const mask = ipv4ToUint32(entry.netmask);
    if (ip === undefined || mask === undefined) continue;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | ((~mask) >>> 0)) >>> 0;
    if (broadcast <= network + 2) continue; // /31 and /32 have no distinct ordinary peer address.
    for (const candidate of [network + 1, network + 2, broadcast - 1]) {
      if (candidate <= network || candidate >= broadcast) continue;
      const address = uint32ToIpv4(candidate);
      if (!local.has(address)) return address;
    }
  }
  return undefined;
}

async function waitUntilGone(pid: number, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("load-bearing host verifier feasibility", () => {
  it("proves nested Seatbelt has a real inner allow/deny result", () => {
    const fixture = makeVerifierFixture();
    const allowed = join(fixture.source, "inner-allowed.txt");
    const blocked = join(fixture.source, "inner-blocked.txt");
    writeFileSync(allowed, "allowed", "utf8");
    writeFileSync(blocked, "blocked", "utf8");

    const script = String.raw`
      const { spawnSync } = require("node:child_process");
      const [allowed, blocked] = process.argv.slice(2);
      const q = (v) => v.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      const inner = '(version 1)\n(allow default)\n(deny file-read* (literal "' + q(blocked) + '"))';
      const ok = spawnSync('/usr/bin/sandbox-exec', ['-p', inner, '/bin/cat', allowed], {encoding:'utf8'});
      const denied = spawnSync('/usr/bin/sandbox-exec', ['-p', inner, '/bin/cat', blocked], {encoding:'utf8'});
      process.stdout.write(JSON.stringify({
        okStatus: ok.status,
        okText: (ok.stdout || '').trim(),
        okError: ok.error && ok.error.code || null,
        deniedStatus: denied.status,
        deniedError: denied.error && denied.error.code || null,
        deniedPermission: /Operation not permitted|Permission denied/.test(denied.stderr || ''),
      }));
    `;
    const result = runVerifierNode(fixture, "nested.cjs", script, [allowed, blocked]);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout) as {
      okStatus: number | null;
      okText: string;
      okError: string | null;
      deniedStatus: number | null;
      deniedError: string | null;
      deniedPermission: boolean;
    };
    expect(observed.okStatus, JSON.stringify(observed)).toBe(0);
    expect(observed.okText).toBe("allowed");
    expect(observed.deniedStatus).not.toBe(0);
    expect(observed.deniedPermission, JSON.stringify(observed)).toBe(true);
  });

  it("proves a real Git hook executes normally and Safe Git suppresses it", () => {
    const repo = join(root, "git-hook-probe");
    const marker = join(root, "hook-marker");
    mkdirSync(repo, { recursive: true });
    rawGit(repo, "init", "-q", "-b", "main");
    rawGit(repo, "config", "user.name", "Verifier Probe");
    rawGit(repo, "config", "user.email", "verifier@example.invalid");
    const gitDir = rawGit(repo, "rev-parse", "--git-dir").trim();
    const hook = join(repo, gitDir, "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`, "utf8");
    chmodSync(hook, 0o755);

    rawGit(repo, "commit", "--allow-empty", "-q", "-m", "raw hook");
    expect(readFileSync(marker, "utf8")).toBe("hook");
    rmSync(marker);

    safeGit.local(repo, ["commit", "--allow-empty", "-q", "-m", "safe git"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("allows ephemeral loopback but denies LAN/non-loopback and the production Gateway port", () => {
    const lanPeer = nonLoopbackLanPeer();
    expect(lanPeer, "a distinct same-subnet LAN peer address is required for the load-bearing deny probe").toBeDefined();

    const fixture = makeVerifierFixture();
    const productionPort = Number(process.env.PORT ?? "8787");
    const script = String.raw`
      const net = require('node:net');
      const [lanHost, productionPort] = process.argv.slice(2);
      const connect = (host, port) => new Promise((resolve) => {
        const socket = net.connect({host, port: Number(port)});
        const timer = setTimeout(() => { socket.destroy(); resolve('TIMEOUT'); }, 1500);
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('CONNECTED'); });
        socket.once('error', (error) => { clearTimeout(timer); resolve(error.code || 'ERROR'); });
      });
      (async () => {
        const server = net.createServer((socket) => socket.end('loopback'));
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const localPort = server.address().port;
        const loopback = await connect('127.0.0.1', localPort);
        server.close();
        const lan = await connect(lanHost, localPort);
        const production = await connect('127.0.0.1', productionPort);
        process.stdout.write(JSON.stringify({loopback, lan, production}));
      })().catch((error) => { console.error(error && error.stack || error); process.exit(2); });
    `;
    const result = runVerifierNode(fixture, "network.cjs", script, [lanPeer!, String(productionPort)]);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout) as { loopback: string; lan: string; production: string };
    expect(observed.loopback).toBe("CONNECTED");
    expect(permissionDenied(observed.lan), `LAN peer ${lanPeer} result was ${observed.lan}`).toBe(true);
    expect(permissionDenied(observed.production), `production-port result was ${observed.production}`).toBe(true);
  });

  it("denies real control/workspace/canonical/task/db/credential paths and inherited secret state", () => {
    const fixture = makeVerifierFixture();
    const otherRepo = readdirSync(fixture.layout.workspaceRoot, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "grande-gpt");
    expect(otherRepo, "a second real workspace repo is required for the isolation probe").toBeDefined();
    const credentialTargets = [join(homedir(), ".ssh"), join(homedir(), "Library", "Keychains")]
      .filter((path) => existsSync(path));
    expect(credentialTargets.length, "a real SSH/keychain target is required for the credential-store probe").toBeGreaterThan(0);

    const targets = {
      control: fixture.layout.controlRoot,
      workspace: fixture.layout.workspaceRoot,
      canonical: join(fixture.layout.workspaceRoot, "grande-gpt"),
      task: process.cwd(),
      db: fixture.layout.stateDb,
      otherRepo: join(fixture.layout.workspaceRoot, otherRepo!.name),
      credentials: credentialTargets,
    };
    const script = String.raw`
      const fs = require('node:fs');
      const targets = JSON.parse(process.argv[2]);
      const denied = (path, directory = true) => {
        try {
          if (directory) fs.readdirSync(path);
          else fs.readFileSync(path);
          return false;
        } catch (error) {
          return ['EPERM', 'EACCES', 'ENOTSUP'].includes(error && error.code);
        }
      };
      process.stdout.write(JSON.stringify({
        control: denied(targets.control),
        workspace: denied(targets.workspace),
        canonical: denied(targets.canonical),
        task: denied(targets.task),
        db: denied(targets.db, false),
        otherRepo: denied(targets.otherRepo),
        credentials: targets.credentials.map((path) => denied(path)),
        secretInherited: process.env.GRANDE_VERIFIER_SECRET_MARKER !== undefined,
        proxyInherited: ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'].some((key) => process.env[key] !== undefined),
        sshAgentInherited: process.env.SSH_AUTH_SOCK !== undefined,
      }));
    `;
    const result = runVerifierNode(fixture, "negative-paths.cjs", script, [JSON.stringify(targets)]);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(observed).toMatchObject({
      control: true,
      workspace: true,
      canonical: true,
      task: true,
      db: true,
      otherRepo: true,
      secretInherited: false,
      proxyInherited: false,
      sshAgentInherited: false,
    });
    expect(observed.credentials).toEqual(credentialTargets.map(() => true));
  });

  it("kills the entire sandboxed process group on timeout with no residual orphan", async () => {
    const base = join(root, "runner-probe");
    const paths = {
      worktree: join(base, "worktrees", "demo", "task-probe"),
      canonicalGit: join(base, "canonical", ".git"),
      jobTmp: join(base, "job"),
      controlRoot: join(base, "control"),
      worktreesRoot: join(base, "worktrees"),
      execRoots: defaultExecRoots(),
    };
    for (const dir of [paths.worktree, paths.canonicalGit, paths.jobTmp, paths.controlRoot, paths.worktreesRoot]) {
      mkdirSync(dir, { recursive: true });
    }

    const result = await runSandboxed({
      argv: ["/bin/sh", "-c", "/bin/sleep 30 & echo $! > \"$TMPDIR/orphan.pid\"; wait"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 350,
      maxOutputBytes: 16 * 1024,
    });
    expect(result.killedBy).toBe("timeout");
    expect(result.killSignalSkipped).toBe(false);
    const orphanPid = Number(readFileSync(join(paths.jobTmp, "orphan.pid"), "utf8").trim());
    expect(Number.isInteger(orphanPid) && orphanPid > 1).toBe(true);
    expect(await waitUntilGone(orphanPid)).toBe(true);
  });
});
