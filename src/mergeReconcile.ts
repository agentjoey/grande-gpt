import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalRefreshResult } from "./canonicalRefresh.ts";
import { assertTaskBranch } from "./commit.ts";
import { canonicalRepoPath } from "./deliveryMerge.ts";
import { safeGit } from "./gitExec.ts";
import { listJobs, TERMINAL } from "./jobs.ts";
import type { Layout } from "./layout.ts";
import { getExplicitDeliveryTarget } from "./taskDeliveryTarget.ts";
import { readTaskPrReceipt } from "./taskPrReceipt.ts";
import { getTask, updateTaskState, type TaskRow } from "./tasks.ts";
import type { ToolDeps } from "./toolsCore.ts";

export type MergedLocalState = "clean" | "deploy-pending" | "merged-but-local-stale";

export interface MergeReconcileResult {
  localState: MergedLocalState;
  cleanedUp: boolean;
  canonicalRefresh?: CanonicalRefreshResult;
  error?: string;
}

type CanonicalRefresher = (layout: Layout, repoId: string, expectedBranch?: string) => CanonicalRefreshResult;
const SHA_RE = /^[0-9a-f]{40}$/u;

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
  if (expectedMergeSha === null || !SHA_RE.test(expectedMergeSha)) {
    return stale(canonicalRefresh, "confirmed merged PR did not provide an exact merge SHA");
  }
  if (expectedTaskHead === null || !SHA_RE.test(expectedTaskHead)) {
    return stale(canonicalRefresh, "confirmed merged PR did not provide an exact task head SHA");
  }
  const receipt = readTaskPrReceipt(deps.db, task.taskId);
  if (!receipt || receipt.mergeSha !== expectedMergeSha || receipt.headSha !== expectedTaskHead
      || receipt.baseRef !== canonicalRefresh.branch) {
    return stale(canonicalRefresh, "cleanup requires a matching durable PR/head/base/merge receipt");
  }
  if (canonicalRefresh.remoteHead === null || !SHA_RE.test(canonicalRefresh.remoteHead)
      || canonicalRefresh.after !== canonicalRefresh.remoteHead) {
    return stale(canonicalRefresh, "cleanup requires an exact published remote canonical snapshot");
  }

  let repoRoot: string;
  try {
    repoRoot = canonicalRepoPath(deps.layout, task.repoId);
    const canonicalHead = assertTaskBranch(repoRoot, canonicalRefresh.branch);
    if (canonicalHead !== canonicalRefresh.after) {
      return stale(canonicalRefresh, "canonical changed after refresh; repeat reconciliation before cleanup");
    }
    if (safeGit.local(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).length > 0) {
      return stale(canonicalRefresh, "canonical is dirty; automatic cleanup refused");
    }
    // The canonical branch may already contain later work. Prove inclusion instead of
    // relabelling its moving HEAD as this task's merge commit. Squash/rebase without
    // head ancestry remains uncertain and requires manual inspection, never force deletion.
    if (!safeGit.tryRelation(repoRoot, expectedMergeSha, canonicalHead)
        || !safeGit.tryRelation(repoRoot, expectedTaskHead, expectedMergeSha)) {
      return stale(canonicalRefresh, "exact task head/merge is not included in published canonical history");
    }
    const currentHead = assertTaskBranch(task.worktreePath, task.branch);
    if (currentHead !== expectedTaskHead) {
      return stale(canonicalRefresh, `task HEAD drifted after merge: expected ${expectedTaskHead}, observed ${currentHead}`);
    }
    const dirty = safeGit.local(task.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (dirty.length > 0) {
      return stale(canonicalRefresh, "task worktree became dirty/uncommitted after merge; automatic cleanup refused");
    }
  } catch (error) {
    return stale(canonicalRefresh, `could not prove task worktree safe for cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }

  // V2 delivery still needs the task, and legacy deployment reads its worktree spec.
  if (getExplicitDeliveryTarget(deps.db, task.taskId) === "deploy"
      || existsSync(join(task.worktreePath, ".grande", "deploy.yaml"))) {
    return { localState: "deploy-pending", cleanedUp: false, canonicalRefresh };
  }

  const activeJob = listJobs(deps.db, task.taskId).find((job) => !TERMINAL.has(job.state));
  if (activeJob) {
    return stale(canonicalRefresh, `task still has non-terminal job ${activeJob.jobId}`);
  }

  const taskExpected = { expectedBranch: task.branch, expectedHead: expectedTaskHead };
  let cleanupError: unknown = null;
  let headLockFd: number | null = null;
  let headLockPath: string | null = null;
  try {
    // Resolve the linked worktree's own Git admin dir while still bound to the expected
    // task identity. The subsequent HEAD.lock closes the check→remove TOCTOU window.
    const gitAdminDir = safeGit.local(
      task.worktreePath,
      ["rev-parse", "--absolute-git-dir"],
      taskExpected,
    ).trim();
    if (gitAdminDir.length === 0) {
      throw new Error("task worktree Git admin dir is empty");
    }
    headLockPath = join(gitAdminDir, "HEAD.lock");
    headLockFd = openSync(headLockPath, "wx", 0o600);

    // Re-prove exact identity only after acquiring HEAD.lock. Git commit/switch/detach
    // cannot update HEAD while this lock exists; ordinary non-force worktree removal can.
    const lockedHead = assertTaskBranch(task.worktreePath, task.branch);
    if (lockedHead !== expectedTaskHead) {
      throw new Error(`task HEAD drifted before locked cleanup: expected ${expectedTaskHead}, observed ${lockedHead}`);
    }

    // Dirty/untracked changes remain Git's responsibility here: non-force removal refuses
    // them. Do not use --force and do not rely on later branch deletion as a safety net.
    safeGit.local(task.worktreePath, ["-C", repoRoot, "worktree", "remove", task.worktreePath]);
  } catch (error) {
    cleanupError = error;
  } finally {
    if (headLockFd !== null) {
      try {
        closeSync(headLockFd);
        if (headLockPath !== null) {
          try {
            unlinkSync(headLockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }
  if (cleanupError !== null) {
    return stale(canonicalRefresh, cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
  }

  try {
    const canonicalExpected = { expectedBranch: canonicalRefresh.branch, expectedHead: canonicalRefresh.after };
    safeGit.local(repoRoot, ["branch", "-d", task.branch], canonicalExpected);
    const current = getTask(deps.db, task.taskId);
    if (!current) return stale(canonicalRefresh, "task disappeared after worktree cleanup");
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

/** Reconcile a confirmed remote merge using one fixed-origin canonical refresh. */
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
