import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalRefreshResult } from "./canonicalRefresh.ts";
import { safeGit } from "./gitExec.ts";
import { listJobs, TERMINAL } from "./jobs.ts";
import type { Layout } from "./layout.ts";
import { getTask, updateTaskState, type TaskRow } from "./tasks.ts";
import type { ToolDeps } from "./toolsCore.ts";
import { removeWorktree } from "./worktree.ts";

export type MergedLocalState = "clean" | "deploy-pending" | "merged-but-local-stale";

export interface MergeReconcileResult {
  localState: MergedLocalState;
  cleanedUp: boolean;
  canonicalRefresh?: CanonicalRefreshResult;
  error?: string;
}

type CanonicalRefresher = (layout: Layout, repoId: string, expectedBranch?: string) => CanonicalRefreshResult;

function stale(canonicalRefresh: CanonicalRefreshResult, error: string): MergeReconcileResult {
  return { localState: "merged-but-local-stale", cleanedUp: false, canonicalRefresh, error };
}

function cleanupAfterRefresh(
  deps: ToolDeps,
  task: TaskRow,
  canonicalRefresh: CanonicalRefreshResult,
  expectedMergeSha: string | null,
  expectedTaskHead: string | null,
): MergeReconcileResult {
  if (
    expectedMergeSha !== null &&
    canonicalRefresh.remoteHead !== null &&
    canonicalRefresh.after !== expectedMergeSha
  ) {
    return stale(
      canonicalRefresh,
      `canonical HEAD ${canonicalRefresh.after} does not match confirmed merge SHA ${expectedMergeSha}`,
    );
  }

  if (expectedTaskHead === null || !/^[0-9a-f]{40}$/u.test(expectedTaskHead)) {
    return stale(canonicalRefresh, "confirmed merged PR did not provide an exact task head SHA");
  }

  // Cleanup is automatic, unlike explicit grande_task_close. Never use the latter's
  // force-delete semantics until we have re-proved that no Human/candidate content
  // appeared after the remote merge decision.
  try {
    const dirty = safeGit.local(task.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirty.trim().length > 0) {
      return stale(canonicalRefresh, "task worktree became dirty/uncommitted after merge; automatic cleanup refused");
    }
    const currentHead = safeGit.local(task.worktreePath, ["rev-parse", "HEAD"]).trim();
    if (currentHead !== expectedTaskHead) {
      return stale(
        canonicalRefresh,
        `task HEAD drifted after merge: expected ${expectedTaskHead}, observed ${currentHead}`,
      );
    }
  } catch (error) {
    return stale(
      canonicalRefresh,
      `could not prove task worktree safe for cleanup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // S7 reads .grande/deploy.yaml from the task worktree after merge. Deleting
  // it here would break the already-approved deploy -> verify -> DONE loop.
  if (existsSync(join(task.worktreePath, ".grande", "deploy.yaml"))) {
    return { localState: "deploy-pending", cleanedUp: false, canonicalRefresh };
  }

  const activeJob = listJobs(deps.db, task.taskId).find((job) => !TERMINAL.has(job.state));
  if (activeJob) {
    return stale(canonicalRefresh, `task still has non-terminal job ${activeJob.jobId}`);
  }

  try {
    removeWorktree(deps.layout, {
      repoId: task.repoId,
      worktreePath: task.worktreePath,
      branch: task.branch,
    });
    const current = getTask(deps.db, task.taskId);
    if (!current) {
      return stale(canonicalRefresh, "task disappeared after worktree cleanup");
    }
    updateTaskState(deps.db, task.taskId, "CLOSED", current.stateVersion);
    return { localState: "clean", cleanedUp: true, canonicalRefresh };
  } catch (error) {
    return stale(canonicalRefresh, error instanceof Error ? error.message : String(error));
  }
}

/** Reuse a refresh already performed by the merge gate; do not fetch a third time. */
export function reconcileMergedTaskFromRefresh(
  deps: ToolDeps,
  task: TaskRow,
  canonicalRefresh: CanonicalRefreshResult,
  expectedMergeSha: string | null,
  expectedTaskHead: string | null,
): MergeReconcileResult {
  return cleanupAfterRefresh(deps, task, canonicalRefresh, expectedMergeSha, expectedTaskHead);
}

/**
 * Reconcile local state after the remote merge is independently observed.
 * It performs exactly one fixed-origin canonical refresh, then delegates cleanup.
 */
export function reconcileObservedMergedTask(
  deps: ToolDeps,
  task: TaskRow,
  baseRef: string,
  expectedMergeSha: string | null,
  expectedTaskHead: string | null,
  canonicalRefresher: CanonicalRefresher,
): MergeReconcileResult {
  try {
    const canonicalRefresh = canonicalRefresher(deps.layout, task.repoId, baseRef);
    return cleanupAfterRefresh(deps, task, canonicalRefresh, expectedMergeSha, expectedTaskHead);
  } catch (error) {
    return {
      localState: "merged-but-local-stale",
      cleanedUp: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
