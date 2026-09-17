import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { prepareDependenciesInWorktree } from "./dependencyBootstrap.ts";
import {
  assertDisposableVerifierRoot,
  buildTrustedVitestConfig,
  type HostVerifierRequest,
  type HostVerifierStaticPlan,
} from "./hostVerifier.ts";
import { buildHostVerifierSandboxPlan } from "./hostVerifierSandbox.ts";
import type { Layout } from "./layout.ts";
import type { HostToolchainIdentity } from "./outerTestReceipt.ts";
import { capturePackageManagerIdentity } from "./packageManagerIdentity.ts";
import { resolveRepoPath } from "./paths.ts";
import { loadDepDirs } from "./profiles.ts";
import { registeredIds } from "./registry.ts";
import { safeGit } from "./gitExec.ts";
import { getTask } from "./tasks.ts";

export { createHostVerifierLauncher, type HostVerifierLauncherOptions } from "./hostVerifierLauncher.ts";

export interface HostVerifierPreparedRun {
  disposableRoot: string;
  sourceRoot: string;
  jobTmp: string;
  loopbackPorts: number[];
  hostToolchain: HostToolchainIdentity;
}

export interface HostVerifierExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  killedBy: null | "timeout" | "rss";
  durationMs: number;
  peakRssMb: number;
}

export interface HostVerifierRuntimeAdapter {
  prepare(input: {
    request: HostVerifierRequest;
    plan: HostVerifierStaticPlan;
    jobId: string;
    disposableRoot: string;
  }): Promise<HostVerifierPreparedRun>;
  execute(
    prepared: HostVerifierPreparedRun,
    onSpawn: (pgid: number) => void,
  ): Promise<HostVerifierExecutionResult>;
  readCurrentHeads(request: HostVerifierRequest): Promise<{ taskHead: string | null; prHead: string | null }>;
  cleanup(prepared: HostVerifierPreparedRun): Promise<void>;
}

export interface HostVerifierRuntimeDeps {
  db: DatabaseSync;
  layout: Layout;
}

interface DefaultPreparedDetails {
  request: HostVerifierRequest;
  plan: HostVerifierStaticPlan;
  canonicalRepo: string;
  taskWorktree: string;
  sourceRoot: string;
  jobTmp: string;
  profilePath: string;
  configPath: string;
  nodePath: string;
  vitestEntry: string;
  env: Readonly<Record<string, string>>;
}

export interface DefaultHostVerifierAdapterOptions {
  /** Trusted PR state reader supplied by the PR lifecycle layer; never candidate code. */
  readPrHead(request: HostVerifierRequest): Promise<string | null>;
}

function exactGitExecutable(): string {
  try {
    const found = execFileSync("/usr/bin/xcrun", ["--find", "git"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (found) return realpathSync(found);
  } catch {
    // Some sandboxed unit environments cannot ask xcrun; fall through to PATH resolution.
  }
  const found = execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!found) throw new Error("trusted git executable not found");
  return realpathSync(found);
}

function assertTrustedDepPath(relative: string): void {
  if (!relative || isAbsolute(relative) || relative.split(/[\\/]/u).includes("..")) {
    throw new Error(`invalid trusted dependency path: ${relative}`);
  }
}

async function prepareTrustedDependencies(
  layout: Layout,
  repoId: string,
  canonicalRepo: string,
  sourceRoot: string,
  jobTmp: string,
): Promise<string[]> {
  const depDirs = [...loadDepDirs(layout, repoId)];
  if (depDirs.length === 0) throw new Error(`host verifier has no trusted dependency roots for ${repoId}`);
  const roots: string[] = [];
  for (const relative of depDirs) {
    assertTrustedDepPath(relative);
    const destination = join(sourceRoot, relative);
    if (relative === "node_modules") {
      await prepareDependenciesInWorktree({
        layout,
        repoId,
        worktreePath: sourceRoot,
        jobTmp: join(jobTmp, "dependency-bootstrap"),
      });
      if (!existsSync(destination)) throw new Error("dependency bootstrap completed without node_modules");
      roots.push(realpathSync(destination));
      continue;
    }

    const source = join(canonicalRepo, relative);
    if (!existsSync(source)) throw new Error(`trusted dependency root is missing: ${relative}`);
    mkdirSync(dirname(destination), { recursive: true });
    execFileSync("/bin/cp", ["-Rc", source, destination], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    roots.push(realpathSync(destination));
  }
  return roots;
}

function captureHostToolchain(sourceRoot: string): HostToolchainIdentity {
  return capturePackageManagerIdentity(sourceRoot);
}

async function allocateLoopbackPort(productionPort: number): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("failed to allocate trusted loopback port"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (port !== productionPort) return port;
  }
  throw new Error("could not allocate a verifier loopback port distinct from production");
}

function cleanTaskHead(taskWorktree: string): string | null {
  const dirty = safeGit.local(taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty.trim().length > 0) return null;
  return safeGit.local(taskWorktree, ["rev-parse", "HEAD"]).trim();
}

function groupRssMb(pgid: number): number {
  if (!Number.isInteger(pgid) || pgid <= 0) return 0;
  try {
    const out = execFileSync("/bin/ps", ["-o", "rss=", "-g", String(pgid)], { encoding: "utf8" });
    const kb = out.split("\n").reduce((sum, line) => sum + (Number(line.trim()) || 0), 0);
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

async function executePreparedVerifier(
  details: DefaultPreparedDetails,
  onSpawn: (pgid: number) => void,
): Promise<HostVerifierExecutionResult> {
  const started = Date.now();
  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-f", details.profilePath, details.nodePath, details.vitestEntry, "run", "--config", details.configPath],
    {
      cwd: details.sourceRoot,
      env: details.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const pgid = child.pid ?? 0;
  if (!pgid) throw new Error("host verifier spawn produced no process group id");
  try {
    onSpawn(pgid);
  } catch (error) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* already exited */ }
    throw error;
  }

  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let truncated = false;
  let killedBy: HostVerifierExecutionResult["killedBy"] = null;
  let peakRssMb = 0;
  let hardKillTimer: NodeJS.Timeout | undefined;

  const killGroup = (reason: NonNullable<HostVerifierExecutionResult["killedBy"]>) => {
    if (killedBy !== null) return;
    killedBy = reason;
    try { process.kill(-pgid, "SIGTERM"); } catch { /* already exited */ }
    hardKillTimer = setTimeout(() => {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* already exited */ }
    }, 5000);
    hardKillTimer.unref?.();
  };

  const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
    if (truncated) return;
    const remaining = details.plan.resourceLimits.maxOutputBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const slice = chunk.subarray(0, remaining);
    bytes += slice.byteLength;
    if (target === "stdout") stdout += slice.toString("utf8");
    else stderr += slice.toString("utf8");
    if (bytes >= details.plan.resourceLimits.maxOutputBytes) truncated = true;
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));

  const timeout = setTimeout(() => killGroup("timeout"), details.plan.resourceLimits.wallTimeoutMs);
  const rssPoll = setInterval(() => {
    const current = groupRssMb(pgid);
    if (current > peakRssMb) peakRssMb = current;
    if (current > details.plan.resourceLimits.maxRssMb) killGroup("rss");
  }, 2000);

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("close", (code) => done(code));
    child.once("error", () => done(null));
  });
  clearTimeout(timeout);
  clearInterval(rssPoll);
  if (hardKillTimer) clearTimeout(hardKillTimer);

  return { exitCode, stdout, stderr, truncated, killedBy, durationMs: Date.now() - started, peakRssMb };
}

/** Real host adapter. All executable and filesystem choices remain behind the trusted boundary. */
export function createDefaultHostVerifierRuntimeAdapter(
  deps: HostVerifierRuntimeDeps,
  options: DefaultHostVerifierAdapterOptions,
): HostVerifierRuntimeAdapter {
  const detailsByRoot = new Map<string, DefaultPreparedDetails>();

  return {
    async prepare({ request, plan, disposableRoot }) {
      const task = getTask(deps.db, request.taskId);
      if (!task || task.repoId !== request.repoId) throw new Error("host verifier task/repo binding changed");
      const taskWorktree = realpathSync(task.worktreePath);
      const initialTaskHead = cleanTaskHead(taskWorktree);
      if (initialTaskHead !== request.commit) throw new Error("host verifier request no longer matches a clean task HEAD");

      const canonicalRepo = resolveRepoPath(deps.layout, request.repoId, registeredIds(deps.layout));
      const resolved = safeGit.local(canonicalRepo, ["rev-parse", "--verify", `${request.commit}^{commit}`]).trim();
      if (resolved !== request.commit) throw new Error("requested verifier SHA is not the exact local commit object");

      const root = realpathSync(disposableRoot);
      assertDisposableVerifierRoot(root, {
        workspaceRoot: deps.layout.workspaceRoot,
        controlRoot: deps.layout.controlRoot,
        taskWorktree,
      });
      const sourceRoot = join(root, "source");
      let worktreeAdded = false;
      try {
        safeGit.local(canonicalRepo, ["worktree", "add", "--detach", sourceRoot, request.commit]);
        worktreeAdded = true;
        const checkedOut = safeGit.local(sourceRoot, ["rev-parse", "HEAD"]).trim();
        if (checkedOut !== request.commit) throw new Error("disposable verifier worktree HEAD mismatch");

        const jobTmp = join(root, "job");
        for (const dir of [jobTmp, join(jobTmp, "home"), join(jobTmp, "tmp"), join(jobTmp, "cache")]) {
          mkdirSync(dir, { recursive: true });
        }
        const dependencyRoots = await prepareTrustedDependencies(
          deps.layout, request.repoId, canonicalRepo, sourceRoot, jobTmp,
        );
        const canonicalSource = realpathSync(sourceRoot);
        const canonicalJobTmp = realpathSync(jobTmp);
        const productionPort = Number(process.env.PORT ?? "8787");
        const loopbackPorts = [await allocateLoopbackPort(productionPort)];
        const nodePath = realpathSync(process.execPath);
        const gitPath = exactGitExecutable();
        const shPath = realpathSync("/bin/sh");
        const bashPath = realpathSync("/bin/bash");
        const vitestEntry = realpathSync(join(canonicalSource, "node_modules", "vitest", "vitest.mjs"));
        const hookPath = join(canonicalJobTmp, "tmp", "git-hook-probe", "repo", ".git", "hooks", "pre-commit");
        const executableFiles = [...new Set([
          nodePath, gitPath, shPath, bashPath,
          ...(plan.files.includes("tests/host/git-hook.host.test.ts") ? [hookPath] : []),
        ])];
        const toolchainReadRoots = [...new Set([
          dirname(nodePath), dirname(gitPath), realpathSync("/usr/bin"), realpathSync("/bin"),
        ])];
        const policy = buildHostVerifierSandboxPlan({
          verifierWorktree: canonicalSource,
          dependencyRoots,
          jobTmp: canonicalJobTmp,
          controlRoot: deps.layout.controlRoot,
          workspaceRoot: deps.layout.workspaceRoot,
          canonicalRepo: realpathSync(canonicalRepo),
          taskWorktree,
          databasePath: deps.layout.stateDb,
          toolchainReadRoots,
          executableFiles,
          productionPort,
          loopbackPorts,
        });
        const configPath = join(canonicalJobTmp, "verifier.vitest.config.mjs");
        const profilePath = join(canonicalJobTmp, "verifier.sb");
        writeFileSync(configPath, buildTrustedVitestConfig(plan.files), "utf8");
        writeFileSync(profilePath, policy.profile, "utf8");
        const hostToolchain = captureHostToolchain(canonicalSource);
        const prepared: HostVerifierPreparedRun = { disposableRoot: root, sourceRoot: canonicalSource,
          jobTmp: canonicalJobTmp, loopbackPorts, hostToolchain };
        detailsByRoot.set(root, { request, plan, canonicalRepo: realpathSync(canonicalRepo), taskWorktree,
          sourceRoot: canonicalSource, jobTmp: canonicalJobTmp, profilePath, configPath,
          nodePath, vitestEntry, env: policy.env });
        return prepared;
      } catch (error) {
        if (worktreeAdded) {
          try { safeGit.local(canonicalRepo, ["worktree", "remove", "--force", sourceRoot]); }
          catch { /* surfaced by original error */ }
        }
        throw error;
      }
    },

    async execute(prepared, onSpawn) {
      const details = detailsByRoot.get(prepared.disposableRoot);
      if (!details) throw new Error("unknown trusted prepared verifier run");
      return executePreparedVerifier(details, onSpawn);
    },

    async readCurrentHeads(request) {
      const task = getTask(deps.db, request.taskId);
      if (!task || task.repoId !== request.repoId) return { taskHead: null, prHead: null };
      let taskHead: string | null = null;
      try { taskHead = cleanTaskHead(realpathSync(task.worktreePath)); } catch { taskHead = null; }
      const prHead = await options.readPrHead(request);
      return { taskHead, prHead };
    },

    async cleanup(prepared) {
      const details = detailsByRoot.get(prepared.disposableRoot);
      if (!details) throw new Error("unknown trusted prepared verifier cleanup");
      assertDisposableVerifierRoot(prepared.disposableRoot, { workspaceRoot: deps.layout.workspaceRoot,
        controlRoot: deps.layout.controlRoot, taskWorktree: details.taskWorktree });
      safeGit.local(details.canonicalRepo, ["worktree", "remove", "--force", details.sourceRoot]);
      rmSync(prepared.disposableRoot, { recursive: true, force: true });
      detailsByRoot.delete(prepared.disposableRoot);
    },
  };
}
