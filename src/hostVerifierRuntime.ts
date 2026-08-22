import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assertDisposableVerifierRoot,
  buildTrustedVitestConfig,
  type HostVerifierLaunchResult,
  type HostVerifierRequest,
  type HostVerifierStaticPlan,
} from "./hostVerifier.ts";
import { buildHostVerifierSandboxPlan } from "./hostVerifierSandbox.ts";
import {
  createJob,
  finishJob,
  getJob,
  setRunningJobPgid,
  setRunningJobSummary,
  TERMINAL,
  type JobState,
} from "./jobs.ts";
import type { Layout } from "./layout.ts";
import {
  persistTrustedOuterTestPassV2,
  type HostToolchainIdentity,
  type TrustedHostVerifierSummary,
} from "./outerTestReceipt.ts";
import { resolveRepoPath } from "./paths.ts";
import { loadDepDirs } from "./profiles.ts";
import { registeredIds } from "./registry.ts";
import { safeGit } from "./gitExec.ts";
import { getTask } from "./tasks.ts";

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

/** Trusted launcher policy selected only by control-plane code, never by HostVerifierRequest. */
export interface HostVerifierLauncherOptions {
  receiptMode?: "auto" | "manual";
  requirePrHead?: boolean;
}

function executionState(result: HostVerifierExecutionResult): Exclude<JobState, "running"> {
  if (result.killedBy === "timeout") return "timeout";
  if (result.killedBy === "rss") return "killed";
  return result.exitCode === 0 ? "passed" : "failed";
}

function artifactBody(result: HostVerifierExecutionResult): string {
  return `${result.stdout}\n--- stderr ---\n${result.stderr}\n`;
}

function failureSummary(
  request: HostVerifierRequest,
  prepared: HostVerifierPreparedRun | undefined,
  detail: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "host-verifier-failure",
    repoId: request.repoId,
    commit: request.commit,
    level: request.level,
    disposableRoot: prepared?.disposableRoot ?? null,
    ...detail,
  };
}

function trustedSummary(
  request: HostVerifierRequest,
  plan: HostVerifierStaticPlan,
  prepared: HostVerifierPreparedRun,
  mode: "auto" | "manual",
): TrustedHostVerifierSummary {
  return {
    kind: "host-verifier-v2",
    mode,
    repoId: request.repoId,
    commit: request.commit,
    level: request.level,
    files: [...plan.files],
    policyVersion: plan.policyVersion,
    resourceLimits: { ...plan.resourceLimits },
    loopbackPorts: [...prepared.loopbackPorts],
    hostToolchain: { ...prepared.hostToolchain },
  };
}

/**
 * Trusted one-shot launcher. Its caller can choose only task/repo/exact-SHA/level;
 * argv/cwd/env/Seatbelt/receipt fields remain behind the runtime adapter boundary.
 * The optional receipt policy is also trusted control-plane configuration, not request data.
 */
export function createHostVerifierLauncher(
  deps: HostVerifierRuntimeDeps,
  adapter: HostVerifierRuntimeAdapter,
  options: HostVerifierLauncherOptions = {},
): (request: HostVerifierRequest, plan: HostVerifierStaticPlan) => HostVerifierLaunchResult {
  const receiptMode = options.receiptMode ?? "auto";
  const requirePrHead = options.requirePrHead ?? true;
  return (request, plan) => {
    if (request.repoId !== "grande-gpt") {
      throw new Error(`host verifier is scoped to grande-gpt, received repo ${request.repoId}`);
    }
    if (!/^[0-9a-f]{40}$/u.test(request.commit)) throw new Error("host verifier requires an exact 40-hex commit");
    const task = getTask(deps.db, request.taskId);
    if (!task) throw new Error(`host verifier task does not exist: ${request.taskId}`);
    if (task.repoId !== request.repoId) throw new Error("host verifier task/repo binding mismatch");

    const disposableRoot = realpathSync(mkdtempSync(join(tmpdir(), "grande-host-verifier-")));
    assertDisposableVerifierRoot(disposableRoot, {
      workspaceRoot: deps.layout.workspaceRoot,
      controlRoot: deps.layout.controlRoot,
      taskWorktree: task.worktreePath,
    });

    const jobId = `job_${randomUUID()}`;
    try {
      createJob(deps.db, {
        jobId,
        taskId: request.taskId,
        profile: "host-verifier",
        argv: ["trusted-host-verifier", request.level, request.commit],
        pgid: null,
      });
      setRunningJobSummary(deps.db, jobId, {
        kind: "host-verifier-preparing",
        repoId: request.repoId,
        commit: request.commit,
        level: request.level,
        receiptMode,
        staticPlanDigest: plan.staticPlanDigest,
        disposableRoot,
      });
    } catch (error) {
      rmSync(disposableRoot, { recursive: true, force: true });
      throw error;
    }

    const artifactDir = join(deps.layout.artifactsDir, request.taskId, jobId);
    const artifactPath = join(artifactDir, "output.log");
    mkdirSync(artifactDir, { recursive: true });

    const settled = (async () => {
      let prepared: HostVerifierPreparedRun | undefined;
      let cleaned = false;
      let result: HostVerifierExecutionResult | undefined;
      let phase: "prepare" | "execute" | "cleanup" | "head_check" = "prepare";
      try {
        prepared = await adapter.prepare({ request, plan, jobId, disposableRoot });
        if (prepared.disposableRoot !== disposableRoot) {
          throw new Error("runtime adapter changed the trusted disposable root");
        }
        assertDisposableVerifierRoot(prepared.disposableRoot, {
          workspaceRoot: deps.layout.workspaceRoot,
          controlRoot: deps.layout.controlRoot,
          taskWorktree: task.worktreePath,
        });
        setRunningJobSummary(deps.db, jobId, {
          kind: "host-verifier-running",
          repoId: request.repoId,
          commit: request.commit,
          level: request.level,
          receiptMode,
          staticPlanDigest: plan.staticPlanDigest,
          disposableRoot,
          loopbackPorts: [...prepared.loopbackPorts],
        });

        phase = "execute";
        result = await adapter.execute(prepared, (pgid) => {
          if (!setRunningJobPgid(deps.db, jobId, pgid)) {
            throw new Error("verifier pgid arrived after job stopped or was already attached");
          }
        });
        writeFileSync(artifactPath, artifactBody(result), "utf8");

        phase = "cleanup";
        await adapter.cleanup(prepared);
        cleaned = true;

        const state = executionState(result);
        if (state !== "passed") {
          const failureClass = state === "failed" ? "candidate" : "infrastructure";
          const reason = state === "failed"
            ? "test_failed"
            : result.killedBy === "timeout" ? "timeout" : "rss_limit";
          finishJob(deps.db, jobId, {
            state,
            exitCode: result.exitCode,
            artifactPath,
            summary: failureSummary(request, prepared, {
              failureClass,
              reason,
              testFailure: state === "failed",
              infrastructureFailure: state !== "failed",
              killedBy: result.killedBy,
              truncated: result.truncated,
              durationMs: result.durationMs,
              peakRssMb: result.peakRssMb,
              cleaned: true,
            }),
          });
          return;
        }

        phase = "head_check";
        const heads = await adapter.readCurrentHeads(request);
        const exactHeadStillCurrent = heads.taskHead === request.commit
          && (!requirePrHead || heads.prHead === request.commit);
        const baseSummary = trustedSummary(request, plan, prepared, receiptMode);
        const summary = exactHeadStillCurrent
          ? baseSummary
          : {
              ...baseSummary,
              kind: "host-verifier-v2-stale",
              staleReason: requirePrHead ? "task-or-pr-sha-drift" : "task-sha-drift",
              observedTaskHead: heads.taskHead,
              observedPrHead: heads.prHead,
            };
        finishJob(deps.db, jobId, {
          state: "passed",
          exitCode: 0,
          artifactPath,
          summary,
        });
        if (exactHeadStillCurrent) persistTrustedOuterTestPassV2(deps.db, request.taskId, jobId);
      } catch (error) {
        if (prepared && !cleaned) {
          try {
            await adapter.cleanup(prepared);
            cleaned = true;
          } catch {
            cleaned = false;
          }
        } else if (!prepared) {
          try {
            rmSync(disposableRoot, { recursive: true, force: true });
            cleaned = true;
          } catch {
            cleaned = false;
          }
        }
        const current = getJob(deps.db, jobId);
        if (current && !TERMINAL.has(current.state)) {
          try {
            writeFileSync(artifactPath, `host verifier infrastructure error: ${(error as Error).message}\n`, "utf8");
          } catch {
            // Artifact failure must not leave the job forever running.
          }
          finishJob(deps.db, jobId, {
            state: "failed",
            exitCode: result?.exitCode ?? null,
            artifactPath,
            summary: failureSummary(request, prepared, {
              failureClass: "infrastructure",
              reason: `${phase}_failed`,
              infrastructureFailure: true,
              error: error instanceof Error ? error.message : String(error),
              cleaned,
            }),
          });
        }
      }
    })();

    return { jobId, settled };
  };
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

function cloneTrustedDependencies(layout: Layout, repoId: string, canonicalRepo: string, sourceRoot: string): string[] {
  const depDirs = [...loadDepDirs(layout, repoId)];
  if (depDirs.length === 0) throw new Error(`host verifier has no trusted dependency roots for ${repoId}`);
  const roots: string[] = [];
  for (const relative of depDirs) {
    assertTrustedDepPath(relative);
    const source = join(canonicalRepo, relative);
    if (!existsSync(source)) throw new Error(`trusted dependency root is missing: ${relative}`);
    const destination = join(sourceRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    execFileSync("/bin/cp", ["-Rc", source, destination], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    roots.push(realpathSync(destination));
  }
  return roots;
}

function captureHostToolchain(sourceRoot: string): HostToolchainIdentity {
  const lockfile = readFileSync(join(sourceRoot, "pnpm-lock.yaml"));
  const pnpm = execFileSync("pnpm", ["--version"], {
    cwd: sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!pnpm) throw new Error("trusted pnpm version is empty");
  return {
    node: process.version,
    pnpm,
    lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
  };
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

  return {
    exitCode,
    stdout,
    stderr,
    truncated,
    killedBy,
    durationMs: Date.now() - started,
    peakRssMb,
  };
}

/**
 * Real host adapter. The only variable request is task/repo/exact SHA/level; all
 * filesystem targets, executable files, Vitest argv, environment and Seatbelt
 * policy are derived by trusted parent code.
 */
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

        const dependencyRoots = cloneTrustedDependencies(deps.layout, request.repoId, canonicalRepo, sourceRoot);
        const jobTmp = join(root, "job");
        for (const dir of [jobTmp, join(jobTmp, "home"), join(jobTmp, "tmp"), join(jobTmp, "cache")]) {
          mkdirSync(dir, { recursive: true });
        }
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
          nodePath,
          gitPath,
          shPath,
          bashPath,
          ...(plan.files.includes("tests/host/git-hook.host.test.ts") ? [hookPath] : []),
        ])];
        const toolchainReadRoots = [...new Set([
          dirname(nodePath),
          dirname(gitPath),
          realpathSync("/usr/bin"),
          realpathSync("/bin"),
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
        const prepared: HostVerifierPreparedRun = {
          disposableRoot: root,
          sourceRoot: canonicalSource,
          jobTmp: canonicalJobTmp,
          loopbackPorts,
          hostToolchain,
        };
        detailsByRoot.set(root, {
          request,
          plan,
          canonicalRepo: realpathSync(canonicalRepo),
          taskWorktree,
          sourceRoot: canonicalSource,
          jobTmp: canonicalJobTmp,
          profilePath,
          configPath,
          nodePath,
          vitestEntry,
          env: policy.env,
        });
        return prepared;
      } catch (error) {
        if (worktreeAdded) {
          try { safeGit.local(canonicalRepo, ["worktree", "remove", "--force", sourceRoot]); } catch { /* surfaced by original error */ }
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
      assertDisposableVerifierRoot(prepared.disposableRoot, {
        workspaceRoot: deps.layout.workspaceRoot,
        controlRoot: deps.layout.controlRoot,
        taskWorktree: details.taskWorktree,
      });
      safeGit.local(details.canonicalRepo, ["worktree", "remove", "--force", details.sourceRoot]);
      rmSync(prepared.disposableRoot, { recursive: true, force: true });
      detailsByRoot.delete(prepared.disposableRoot);
    },
  };
}
