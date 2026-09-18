import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertDisposableVerifierRoot } from "./hostVerifier.ts";
import { finishJob, getJob, hasUnsettledResourceOwner, listNonterminalJobs, TERMINAL, type JobRow } from "./jobs.ts";
import type { Layout } from "./layout.ts";
import { resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { safeGit } from "./gitExec.ts";
import { getTask } from "./tasks.ts";

export interface HostVerifierRecoveryDeps {
  db: DatabaseSync;
  layout: Layout;
}

export interface HostVerifierRecoveryCleanupResult {
  cleaned: boolean;
  error?: string;
}

export interface HostVerifierRecoveryOps {
  isAlive?: (pgid: number) => boolean;
  killGroup?: (pgid: number) => Promise<void>;
  cleanupDisposable?: (
    job: JobRow,
    disposableRoot: string,
  ) => Promise<HostVerifierRecoveryCleanupResult>;
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // Permission/unknown probe errors do not prove process extinction.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function killRecordedProcessGroup(pgid: number): Promise<void> {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    if (!processGroupAlive(pgid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`recorded host verifier process group ${pgid} did not terminate`);
}

async function cleanupRecoveredDisposable(
  deps: HostVerifierRecoveryDeps,
  job: JobRow,
  disposableRoot: string,
): Promise<HostVerifierRecoveryCleanupResult> {
  try {
    const task = getTask(deps.db, job.taskId);
    if (!task) return { cleaned: false, error: `task missing for verifier job ${job.jobId}` };

    const root = existsSync(disposableRoot) ? realpathSync(disposableRoot) : disposableRoot;
    if (existsSync(disposableRoot) && root !== disposableRoot) {
      return { cleaned: false, error: "disposable verifier root resolved through a symlink" };
    }
    assertDisposableVerifierRoot(root, {
      workspaceRoot: deps.layout.workspaceRoot,
      controlRoot: deps.layout.controlRoot,
      taskWorktree: task.worktreePath,
    });
    if (!existsSync(root)) return { cleaned: true };

    const canonicalRepo = resolveRepoPath(deps.layout, task.repoId, registeredIds(deps.layout));
    const sourceRoot = join(root, "source");
    if (existsSync(sourceRoot)) {
      safeGit.local(canonicalRepo, ["worktree", "remove", "--force", sourceRoot]);
    }
    rmSync(root, { recursive: true, force: true });
    return { cleaned: true };
  } catch (error) {
    return { cleaned: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Startup recovery for verifier jobs. Managed reservations keep their live supervisor;
 * ambiguous launch windows or old live pgids are not proof of kill authority. Legacy
 * verifier records retain their existing trusted recovery path. No TTL releases capacity.
 */
export async function reconcileHostVerifierJobsAtStartup(
  deps: HostVerifierRecoveryDeps,
  overrides: HostVerifierRecoveryOps = {},
): Promise<number> {
  const isAlive = overrides.isAlive ?? processGroupAlive;
  const killGroup = overrides.killGroup ?? killRecordedProcessGroup;
  const cleanupDisposable = overrides.cleanupDisposable
    ?? ((job, root) => cleanupRecoveredDisposable(deps, job, root));
  let reconciled = 0;

  for (const snapshot of listNonterminalJobs(deps.db)) {
    if (snapshot.profile !== "host-verifier") continue;
    if (hasUnsettledResourceOwner(snapshot)) continue;
    if (snapshot.pgid !== null && isAlive(snapshot.pgid)) {
      // A dead owner's recorded integer is not sufficient to signal a potentially reused pgid.
      if (snapshot.summary?.resourceOwner !== undefined) continue;
      await killGroup(snapshot.pgid);
    }

    const current = getJob(deps.db, snapshot.jobId);
    if (!current || TERMINAL.has(current.state) || hasUnsettledResourceOwner(current)) continue;
    const previous = current.summary ?? {};
    const disposableRoot = typeof previous.disposableRoot === "string" ? previous.disposableRoot : null;
    const cleanup = disposableRoot === null
      ? { cleaned: false, error: "running host verifier job has no trusted disposableRoot" }
      : await cleanupDisposable(current, disposableRoot);

    const finished = finishJob(deps.db, current.jobId, {
      state: "killed",
      exitCode: null,
      artifactPath: current.artifactPath,
      summary: {
        kind: "host-verifier-failure",
        repoId: previous.repoId ?? getTask(deps.db, current.taskId)?.repoId ?? null,
        commit: previous.commit ?? null,
        level: previous.level ?? null,
        disposableRoot,
        infrastructureFailure: true,
        reason: "interrupted_by_gateway_restart",
        killedBy: "gateway_restart",
        cleaned: cleanup.cleaned,
        ...(cleanup.error ? { cleanupError: cleanup.error } : {}),
      },
    });
    if (finished) reconciled += 1;
  }

  return reconciled;
}
