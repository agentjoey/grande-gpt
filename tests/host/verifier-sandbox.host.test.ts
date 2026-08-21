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
import { createServer } from "node:net";
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

function nonLoopbackIpv4(): string | undefined {
  for (const values of Object.values(networkInterfaces())) {
    for (const entry of values ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
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
        okText: ok.stdout.trim(),
        deniedStatus: denied.status,
        deniedPermission: /Operation not permitted|Permission denied/.test(denied.stderr),
      }));
    `;
    const result = runVerifierNode(fixture, "nested.cjs", script, [allowed, blocked]);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout) as {
      okStatus: number | null;
      okText: string;
      deniedStatus: number | null;
      deniedPermission: boolean;
    };
    expect(observed.okStatus).toBe(0);
    expect(observed.okText).toBe("allowed");
    expect(observed.deniedStatus).not.toBe(0);
    expect(observed.deniedPermission).toBe(true);
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

  it("allows ephemeral loopback but denies LAN/non-loopback and the production Gateway port", async () => {
    const lanAddress = nonLoopbackIpv4();
    expect(lanAddress, "real-host LAN address is required for the load-bearing deny probe").toBeDefined();

    const lanServer = createServer((socket) => socket.end("lan"));
    await new Promise<void>((resolve, reject) => {
      lanServer.once("error", reject);
      lanServer.listen(0, "0.0.0.0", () => resolve());
    });
    try {
      const address = lanServer.address();
      if (address === null || typeof address === "string") throw new Error("LAN probe did not get a TCP port");
      const fixture = makeVerifierFixture();
      const productionPort = Number(process.env.PORT ?? "8787");
      const script = String.raw`
        const net = require('node:net');
        const [lanHost, lanPort, productionPort] = process.argv.slice(2);
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
          const lan = await connect(lanHost, lanPort);
          const production = await connect('127.0.0.1', productionPort);
          process.stdout.write(JSON.stringify({loopback, lan, production}));
        })().catch((error) => { console.error(error && error.stack || error); process.exit(2); });
      `;
      const result = runVerifierNode(fixture, "network.cjs", script, [
        lanAddress!, String(address.port), String(productionPort),
      ]);
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout) as { loopback: string; lan: string; production: string };
      expect(observed.loopback).toBe("CONNECTED");
      expect(permissionDenied(observed.lan), `LAN result was ${observed.lan}`).toBe(true);
      expect(permissionDenied(observed.production), `production-port result was ${observed.production}`).toBe(true);
    } finally {
      lanServer.close();
    }
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
