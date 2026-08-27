import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beginAudit } from "./audit.ts";
import {
  captureDependencyBootstrapIdentity,
  DependencyBootstrapFailure,
  DependencyBootstrapIdentityDrift,
  dependencyInstallArgv,
  materializePreparedDependencies,
  prepareDependenciesInWorktree,
  preparedDependenciesPresent,
  preparedDependencyCachePresent,
  profileRequiresDependencyBootstrap,
  type DependencyBootstrapSandboxRunner,
  type DependencyBootstrapIdentity,
} from "./dependencyBootstrap.ts";
import { StateError } from "./errors.ts";
import {
  createJob,
  finishJob,
  listJobs,
  setRunningJobPgid,
  setRunningJobSummary,
  TERMINAL,
} from "./jobs.ts";
import type { Layout } from "./layout.ts";
import { getProfile } from "./profiles.ts";
import { trackJobSettlement } from "./runner.ts";
import type { TaskRow } from "./tasks.ts";

const BOOTSTRAP_PROFILE = "dependency-bootstrap";
const BOOTSTRAP_POLL_SECONDS = 20;

interface DependencyBootstrapDeps {
  db: DatabaseSync;
  layout: Layout;
  dependencyBootstrapSandboxRunner?: DependencyBootstrapSandboxRunner;
}

function identitySummary(identity: DependencyBootstrapIdentity): Record<string, unknown> {
  return {
    repoId: identity.repoId,
    packageManager: identity.packageManager,
    packageManagerVersion: identity.packageManagerVersion,
    lockfile: identity.lockfile,
    lockfileSha256: identity.lockfileSha256,
    node: identity.node,
    platform: identity.platform,
    arch: identity.arch,
    dependencyIdentityKey: identity.key,
  };
}

function runningBootstrap(
  deps: DependencyBootstrapDeps,
  task: TaskRow,
  identity: DependencyBootstrapIdentity,
): ReturnType<typeof listJobs>[number] | null {
  const running = listJobs(deps.db, task.taskId).filter(
    (job) => job.profile === BOOTSTRAP_PROFILE && !TERMINAL.has(job.state),
  );
  const matching = running.find((job) => job.summary?.dependencyIdentityKey === identity.key);
  if (matching) return matching;
  if (running.length > 0) {
    throw new StateError(
      "JOB_RUNNING",
      `任务 ${task.taskId} 已有不同 dependency identity 的 bootstrap ${running[0]!.jobId} 在运行；` +
        `请等待它结束后重试，避免两个 package manager 同时修改 node_modules。`,
    );
  }
  return null;
}

function materializeCacheWithAudit(
  deps: DependencyBootstrapDeps,
  task: TaskRow,
  identity: DependencyBootstrapIdentity,
  requestedProfile: string,
): boolean {
  if (!preparedDependencyCachePresent(deps.layout, identity)) return false;
  const audit = beginAudit(deps.db, {
    taskId: task.taskId,
    tool: "grande_run",
    input: {
      profile: requestedProfile,
      prerequisite: "dependency-cache-materialize",
      dependencyIdentityKey: identity.key,
    },
  });
  audit.allowed();
  if (!audit.executing()) throw new Error("dependency cache materialization audit could not enter EXECUTING");
  try {
    const materialized = materializePreparedDependencies(deps.layout, identity, task.worktreePath);
    if (!materialized) throw new Error("prepared dependency cache disappeared before materialization");
    const currentIdentity = captureDependencyBootstrapIdentity(task.repoId, task.worktreePath);
    if (currentIdentity.key !== identity.key) {
      rmSync(join(task.worktreePath, "node_modules"), { recursive: true, force: true });
      throw new DependencyBootstrapIdentityDrift(identity, currentIdentity);
    }
    audit.succeeded([task.worktreePath]);
    return true;
  } catch (error) {
    audit.failed(error instanceof Error ? error.message : String(error), [task.worktreePath]);
    throw error;
  }
}

function writeBootstrapArtifact(
  deps: DependencyBootstrapDeps,
  taskId: string,
  jobId: string,
  content: string,
): string | null {
  try {
    const dir = join(deps.layout.artifactsDir, taskId, jobId);
    mkdirSync(dir, { recursive: true });
    const artifactPath = join(dir, "output.log");
    writeFileSync(artifactPath, content, "utf8");
    return artifactPath;
  } catch (error) {
    console.error(`[dependency-bootstrap] ${jobId} artifact 写入失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function launchBootstrap(
  deps: DependencyBootstrapDeps,
  task: TaskRow,
  requestedProfile: string,
  identity: DependencyBootstrapIdentity,
): { jobId: string; state: "running"; pollAfterSeconds: number } {
  const audit = beginAudit(deps.db, {
    taskId: task.taskId,
    tool: "grande_run",
    input: {
      profile: requestedProfile,
      prerequisite: BOOTSTRAP_PROFILE,
      dependencyIdentityKey: identity.key,
    },
  });
  audit.allowed();
  if (!audit.executing()) throw new Error("dependency bootstrap audit could not enter EXECUTING");

  const jobId = `job_${randomUUID()}`;
  const argv = dependencyInstallArgv(identity.packageManager);
  try {
    createJob(deps.db, {
      jobId,
      taskId: task.taskId,
      profile: BOOTSTRAP_PROFILE,
      argv,
      pgid: null,
    });
    setRunningJobSummary(deps.db, jobId, {
      kind: BOOTSTRAP_PROFILE,
      phase: "preparing",
      requestedProfile,
      ...identitySummary(identity),
    });
    audit.succeeded([task.worktreePath]);
  } catch (error) {
    audit.failed(error instanceof Error ? error.message : String(error));
    throw error;
  }

  const jobTmp = join(deps.layout.derivedRoot, "tmp", jobId);
  const settlement = prepareDependenciesInWorktree({
    layout: deps.layout,
    repoId: task.repoId,
    worktreePath: task.worktreePath,
    jobTmp,
    sandboxRunner: deps.dependencyBootstrapSandboxRunner,
    onSpawn: (pgid) => {
      try { setRunningJobPgid(deps.db, jobId, pgid); } catch { /* terminal reconciliation already won */ }
    },
  }).then((prepared) => {
    const run = prepared.runResult;
    const artifact = writeBootstrapArtifact(
      deps,
      task.taskId,
      jobId,
      run
        ? `${run.stdout}${run.stderr ? `\n--- stderr ---\n${run.stderr}` : ""}`
        : `dependency bootstrap satisfied from ${prepared.source}\n`,
    );
    finishJob(deps.db, jobId, {
      state: "passed",
      exitCode: 0,
      artifactPath: artifact,
      summary: {
        kind: BOOTSTRAP_PROFILE,
        phase: "ready",
        requestedProfile,
        source: prepared.source,
        cacheDir: prepared.cacheDir,
        truncated: run?.truncated ?? false,
        killedBy: run?.killedBy ?? null,
        durationMs: run?.durationMs ?? 0,
        peakRssMb: run?.peakRssMb ?? 0,
        ...identitySummary(prepared.identity),
      },
    });
  }).catch((error: unknown) => {
    const failure = error instanceof DependencyBootstrapFailure ? error : null;
    const drift = error instanceof DependencyBootstrapIdentityDrift ? error : null;
    const run = failure?.result;
    const reason = run?.killedBy === "timeout"
      ? "bootstrap_timeout"
      : run?.killedBy === "rss"
        ? "bootstrap_resource_exhausted"
        : drift
          ? "identity_drift"
          : failure
            ? "install_failed"
            : "preparation_failed";
    const artifact = writeBootstrapArtifact(
      deps,
      task.taskId,
      jobId,
      failure
        ? `${failure.message}\n${run!.stdout}${run!.stderr ? `\n--- stderr ---\n${run!.stderr}` : ""}`
        : `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    const state = run?.killedBy === "timeout" ? "timeout" : run?.killedBy === "rss" ? "killed" : "failed";
    try {
      finishJob(deps.db, jobId, {
        state,
        exitCode: run?.exitCode ?? null,
        artifactPath: artifact,
        summary: {
          kind: BOOTSTRAP_PROFILE,
          phase: "failed",
          failureClass: "dependency-bootstrap",
          reason,
          requestedProfile,
          truncated: run?.truncated ?? false,
          killedBy: run?.killedBy ?? null,
          durationMs: run?.durationMs ?? null,
          peakRssMb: run?.peakRssMb ?? null,
          ...identitySummary(failure?.identity ?? drift?.expected ?? identity),
          ...(drift ? { actualDependencyIdentityKey: drift.actual.key } : {}),
        },
      });
    } catch {
      // A shutdown/reconciler terminal CAS may already have won. Never create an unhandled rejection.
    }
  }).finally(() => {
    try {
      rmSync(jobTmp, { recursive: true, force: true });
    } catch (error) {
      console.error(`[dependency-bootstrap] ${jobId} 临时目录清理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  trackJobSettlement(jobId, settlement);

  return { jobId, state: "running", pollAfterSeconds: BOOTSTRAP_POLL_SECONDS };
}

export interface DependencyPrerequisite {
  data: Record<string, unknown>;
  hint: string;
}

/** Called only after the core grande_run side-effect-free policy/profile/path preflight passes. */
export function prepareDependencyPrerequisite(
  deps: DependencyBootstrapDeps,
  task: TaskRow,
  requestedProfile: string,
): DependencyPrerequisite | null {
  const profile = getProfile(deps.layout, task.repoId, requestedProfile);
  if (!profileRequiresDependencyBootstrap(deps.layout, task.repoId, task.worktreePath, profile.argv)) return null;

  const identity = captureDependencyBootstrapIdentity(task.repoId, task.worktreePath);
  const existing = runningBootstrap(deps, task, identity);
  if (existing) {
    return {
      data: {
        jobId: existing.jobId,
        state: existing.state,
        pollAfterSeconds: BOOTSTRAP_POLL_SECONDS,
        prerequisite: BOOTSTRAP_PROFILE,
        requestedProfile,
        reused: true,
      },
      hint: `依赖准备仍在运行（${existing.jobId}）；先取得该 job 终态，通过后重试 profile ${requestedProfile}。`,
    };
  }

  if (preparedDependenciesPresent(task.worktreePath, identity)) return null;
  if (materializeCacheWithAudit(deps, task, identity, requestedProfile)) return null;

  const started = launchBootstrap(deps, task, requestedProfile, identity);
  return {
    data: {
      ...started,
      prerequisite: BOOTSTRAP_PROFILE,
      requestedProfile,
      dependencyIdentityKey: identity.key,
      packageManager: identity.packageManager,
    },
    hint: `fresh worktree 缺少与当前 lockfile/runtime 匹配的依赖；已启动受控 ${identity.packageManager} bootstrap。` +
      `该 job 通过后重试 profile ${requestedProfile}，不会把 bootstrap 失败误报为产品测试失败。`,
  };
}
