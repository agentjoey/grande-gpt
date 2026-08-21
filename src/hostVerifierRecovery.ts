import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertDisposableVerifierRoot } from "./hostVerifier.ts";
import { finishJob, getJob, listJobs, TERMINAL, type JobRow } from "./jobs.ts";
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
  } catch {
    return false;
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
    return {
      cleaned: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Startup-only reconciliation for one-shot host verifier jobs.
 *
 * It intentionally ignores ordinary runner jobs. A live verifier is killed only
 * through its recorded detached process group; after that, its disposable root is
 * guarded and cleaned, then the existing job row is CAS-finished as an
 * infrastructure interruption. If the recorded live group cannot be killed, this
 * function throws so Gateway startup fails closed before write tools are exposed.
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

  for (const snapshot of listJobs(deps.db)) {
    if (snapshot.profile !== "host-verifier" || TERMINAL.has(snapshot.state)) continue;

    if (snapshot.pgid !== null && isAlive(snapshot.pgid)) {
      await killGroup(snapshot.pgid);
    }

    // The old process may have won the terminal CAS between our snapshot and kill/probe.
    const current = getJob(deps.db, snapshot.jobId);
    if (!current || TERMINAL.has(current.state)) continue;

    const previous = current.summary ?? {};
    const disposableRoot = typeof previous.disposableRoot === "string"
      ? previous.disposableRoot
      : null;
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
