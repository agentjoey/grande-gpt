import { spawnSync } from "node:child_process";
import {
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

function makeVerifierFixture(loopbackPorts: readonly number[] = []) {
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
  const productionPort = Number(process.env.PORT ?? "8787");
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
    productionPort,
    loopbackPorts,
  });
  const profilePath = join(jobTmp, "verifier.sb");
  writeFileSync(profilePath, plan.profile, "utf8");
  return { layout, source, deps, jobTmp, node, plan, profilePath, productionPort };
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
    if (broadcast <= network + 2) continue;
    for (const candidate of [network + 1, network + 2, broadcast - 1]) {
      if (candidate <= network || candidate >= broadcast) continue;
      const address = uint32ToIpv4(candidate);
      if (!local.has(address)) return address;
    }
  }
  return undefined;
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("trusted parent loopback allocation did not produce a TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
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
  it("proves ordinary child processes inherit the one outer Seatbelt boundary and cannot escape it", async () => {
    const lanPeer = nonLoopbackLanPeer();
    expect(lanPeer, "a distinct same-subnet LAN peer is required for child non-escape proof").toBeDefined();
    const loopbackPort = await allocateLoopbackPort();
    const fixture = makeVerifierFixture([loopbackPort]);
    const allowed = join(fixture.source, "child-allowed.txt");
    const marker = join(fixture.jobTmp, "child-marker.txt");
    const childPath = join(fixture.source, "inheritance-child.cjs");
    writeFileSync(allowed, "allowed", "utf8");
    writeFileSync(childPath, String.raw`
      const fs = require('node:fs');
      const net = require('node:net');
      const [allowed, marker, deniedDb, lanHost, lanPort] = process.argv.slice(2);
      const deniedRead = () => {
        try { fs.readFileSync(deniedDb); return 'READABLE'; }
        catch (error) { return error && error.code || 'ERROR'; }
      };
      const connect = (host, port) => new Promise((resolve) => {
        const socket = net.connect({host, port: Number(port)});
        const timer = setTimeout(() => { socket.destroy(); resolve('TIMEOUT'); }, 1200);
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('CONNECTED'); });
        socket.once('error', (error) => { clearTimeout(timer); resolve(error.code || 'ERROR'); });
      });
      (async () => {
        const allowedText = fs.readFileSync(allowed, 'utf8').trim();
        fs.writeFileSync(marker, 'child');
        const db = deniedRead();
        const lan = await connect(lanHost, lanPort);
        process.stdout.write(JSON.stringify({allowedText, markerWritten: fs.readFileSync(marker, 'utf8'), db, lan}));
      })().catch((error) => { console.error(error && error.stack || error); process.exit(2); });
    `, "utf8");

    const parentScript = String.raw`
      const { spawnSync } = require('node:child_process');
      const [childPath, allowed, marker, deniedDb, lanHost, lanPort] = process.argv.slice(2);
      const child = spawnSync(process.execPath, [childPath, allowed, marker, deniedDb, lanHost, lanPort], {encoding:'utf8'});
      process.stdout.write(JSON.stringify({status: child.status, stdout: child.stdout || '', stderr: child.stderr || '', error: child.error && child.error.code || null}));
    `;
    const result = runVerifierNode(fixture, "inheritance-parent.cjs", parentScript, [
      childPath,
      allowed,
      marker,
      fixture.layout.stateDb,
      lanPeer!,
      String(loopbackPort),
    ]);
    expect(result.status, result.stderr).toBe(0);
    const child = JSON.parse(result.stdout) as { status: number | null; stdout: string; stderr: string; error: string | null };
    expect(child.status, JSON.stringify(child)).toBe(0);
    expect(child.error).toBeNull();
    const observed = JSON.parse(child.stdout) as { allowedText: string; markerWritten: string; db: string; lan: string };
    expect(observed.allowedText).toBe("allowed");
    expect(observed.markerWritten).toBe("child");
    expect(permissionDenied(observed.db), `DB result was ${observed.db}`).toBe(true);
    expect(permissionDenied(observed.lan), `LAN peer ${lanPeer} result was ${observed.lan}`).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("child");
  });

  it("allows only the trusted exact loopback port and denies LAN/non-loopback plus production Gateway port", async () => {
    const lanPeer = nonLoopbackLanPeer();
    expect(lanPeer, "a distinct same-subnet LAN peer address is required for the load-bearing deny probe").toBeDefined();
    const loopbackPort = await allocateLoopbackPort();
    const fixture = makeVerifierFixture([loopbackPort]);
    const script = String.raw`
      const net = require('node:net');
      const [trustedPort, lanHost, productionPort] = process.argv.slice(2);
      const connect = (host, port) => new Promise((resolve) => {
        const socket = net.connect({host, port: Number(port)});
        const timer = setTimeout(() => { socket.destroy(); resolve('TIMEOUT'); }, 1500);
        socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('CONNECTED'); });
        socket.once('error', (error) => { clearTimeout(timer); resolve(error.code || 'ERROR'); });
      });
      (async () => {
        const server = net.createServer((socket) => socket.end('loopback'));
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(trustedPort), '127.0.0.1', resolve); });
        const loopback = await connect('127.0.0.1', trustedPort);
        const lan = await connect(lanHost, trustedPort);
        const production = await connect('127.0.0.1', productionPort);
        server.close();
        process.stdout.write(JSON.stringify({loopback, lan, production}));
      })().catch((error) => { console.error(error && error.stack || error); process.exit(2); });
    `;
    const result = runVerifierNode(fixture, "network.cjs", script, [
      String(loopbackPort),
      lanPeer!,
      String(fixture.productionPort),
    ]);
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
