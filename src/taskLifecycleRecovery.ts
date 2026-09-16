import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GitExecError, safeGit } from "./gitExec.ts";
import { listJobs, TERMINAL } from "./jobs.ts";
import type { Layout } from "./layout.ts";
import { registeredIds } from "./registry.ts";
import { withRepoWriteLock } from "./repoWriteLock.ts";
import { resolveRepoPath } from "./paths.ts";
import {
  clearTaskCloseIntent,
  ensureTaskCloseIntentTable,
  getTaskCloseIntent,
  type TaskCloseIntent,
} from "./taskCloseIntent.ts";
import { getTask, updateTaskState, type TaskRow } from "./tasks.ts";

export interface TaskLifecycleRecoveryResult {
  creatingReady: number;
  creatingClosed: number;
  closingClosed: number;
  unresolved: number;
}

const emptyResult = (): TaskLifecycleRecoveryResult => ({
  creatingReady: 0,
  creatingClosed: 0,
  closingClosed: 0,
  unresolved: 0,
});

function expectedManagedPath(layout: Layout, task: TaskRow): string {
  return join(layout.worktreesRoot, task.repoId, task.taskId);
}

function readBranchHead(repoRoot: string, branch: string): string | null {
  try {
    return safeGit.local(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).trim();
  } catch (error) {
    if (error instanceof GitExecError && error.status === 1) return null;
    throw error;
  }
}

function branchIsRegistered(repoRoot: string, branch: string): boolean {
  const out = safeGit.local(repoRoot, ["worktree", "list", "--porcelain"]);
  return out.split("\n").some((line) => line === `branch refs/heads/${branch}`);
}

function deleteBranchExact(repoRoot: string, branch: string, expectedHead: string): void {
  safeGit.local(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`, expectedHead]);
}

function safeRemoveExactWorktree(repoRoot: string, task: TaskRow, expectedHead: string): void {
  const expected = { expectedBranch: task.branch, expectedHead };
  const dirtyBeforeLock = safeGit.local(
    task.worktreePath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    expected,
  );
  if (dirtyBeforeLock.length > 0) throw new Error("task worktree is dirty; recovery cleanup refused");

  const gitAdminDir = safeGit.local(
    task.worktreePath,
    ["rev-parse", "--absolute-git-dir"],
    expected,
  ).trim();
  if (gitAdminDir.length === 0) throw new Error("task worktree Git admin dir is empty");

  const lockPath = join(gitAdminDir, "HEAD.lock");
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    const dirtyLocked = safeGit.local(
      task.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      expected,
    );
    if (dirtyLocked.length > 0) throw new Error("task worktree became dirty during recovery cleanup");
    safeGit.local(task.worktreePath, ["-C", repoRoot, "worktree", "remove", task.worktreePath]);
  } finally {
    if (fd !== null) {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function recoverCreatingTask(
  db: DatabaseSync,
  layout: Layout,
  task: TaskRow,
  repoRoot: string,
  result: TaskLifecycleRecoveryResult,
): void {
  if (task.worktreePath !== expectedManagedPath(layout, task)) {
    result.unresolved++;
    return;
  }

  if (existsSync(task.worktreePath)) {
    try {
      const dirty = safeGit.local(
        task.worktreePath,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { expectedBranch: task.branch, expectedHead: task.baseCommit },
      );
      if (dirty.length > 0) {
        result.unresolved++;
        return;
      }
      const current = getTask(db, task.taskId);
      if (!current || current.state !== "CREATING" || current.stateVersion !== task.stateVersion) {
        result.unresolved++;
        return;
      }
      updateTaskState(db, task.taskId, "READY", task.stateVersion);
      result.creatingReady++;
    } catch {
      result.unresolved++;
    }
    return;
  }

  try {
    const branchHead = readBranchHead(repoRoot, task.branch);
    if (branchHead === null) {
      const current = getTask(db, task.taskId);
      if (!current || current.state !== "CREATING" || current.stateVersion !== task.stateVersion) {
        result.unresolved++;
        return;
      }
      updateTaskState(db, task.taskId, "CLOSED", task.stateVersion);
      result.creatingClosed++;
      return;
    }
    if (branchHead !== task.baseCommit || branchIsRegistered(repoRoot, task.branch)) {
      result.unresolved++;
      return;
    }
    deleteBranchExact(repoRoot, task.branch, task.baseCommit);
    const current = getTask(db, task.taskId);
    if (!current || current.state !== "CREATING" || current.stateVersion !== task.stateVersion) {
      result.unresolved++;
      return;
    }
    updateTaskState(db, task.taskId, "CLOSED", task.stateVersion);
    result.creatingClosed++;
  } catch {
    result.unresolved++;
  }
}

function recoverClosingTask(
  db: DatabaseSync,
  layout: Layout,
  task: TaskRow,
  intent: TaskCloseIntent,
  repoRoot: string,
  result: TaskLifecycleRecoveryResult,
): void {
  if (task.state === "CLOSED") {
    clearTaskCloseIntent(db, task.taskId);
    return;
  }
  if (task.stateVersion !== intent.expectedStateVersion) {
    result.unresolved++;
    return;
  }
  if (task.worktreePath !== expectedManagedPath(layout, task)) {
    result.unresolved++;
    return;
  }
  if (listJobs(db, task.taskId).some((job) => !TERMINAL.has(job.state))) {
    result.unresolved++;
    return;
  }

  try {
    if (existsSync(task.worktreePath)) {
      safeRemoveExactWorktree(repoRoot, task, intent.headSha);
    }

    const branchHead = readBranchHead(repoRoot, task.branch);
    if (branchHead !== null) {
      if (branchHead !== intent.headSha || branchIsRegistered(repoRoot, task.branch)) {
        result.unresolved++;
        return;
      }
      deleteBranchExact(repoRoot, task.branch, intent.headSha);
    }

    const current = getTask(db, task.taskId);
    if (!current || current.state === "CLOSED") {
      clearTaskCloseIntent(db, task.taskId);
      return;
    }
    if (current.stateVersion !== intent.expectedStateVersion) {
      result.unresolved++;
      return;
    }
    updateTaskState(db, task.taskId, "CLOSED", intent.expectedStateVersion);
    clearTaskCloseIntent(db, task.taskId);
    result.closingClosed++;
  } catch {
    result.unresolved++;
  }
}

function reconcileRepo(
  db: DatabaseSync,
  layout: Layout,
  repoId: string,
): TaskLifecycleRecoveryResult {
  const result = emptyResult();
  const repoRoot = resolveRepoPath(layout, repoId, registeredIds(layout));
  const rows = db.prepare(
    `SELECT t.taskId
       FROM task t
       LEFT JOIN task_close_intent i ON i.taskId = t.taskId
      WHERE t.repoId = ? AND (t.state = 'CREATING' OR i.taskId IS NOT NULL)
      ORDER BY t.createdAt ASC, t.rowid ASC`,
  ).all(repoId) as { taskId: string }[];

  for (const row of rows) {
    const task = getTask(db, row.taskId);
    if (!task) continue;
    const intent = getTaskCloseIntent(db, task.taskId);
    if (intent) recoverClosingTask(db, layout, task, intent, repoRoot, result);
    else if (task.state === "CREATING") recoverCreatingTask(db, layout, task, repoRoot, result);
  }
  return result;
}

function addResult(total: TaskLifecycleRecoveryResult, value: TaskLifecycleRecoveryResult): void {
  total.creatingReady += value.creatingReady;
  total.creatingClosed += value.creatingClosed;
  total.closingClosed += value.closingClosed;
  total.unresolved += value.unresolved;
}

/** Startup/periodic lifecycle reconciliation. It only touches durable CREATING/close-intent rows. */
export async function reconcileTaskLifecycleWithRepoWriteLocks(
  db: DatabaseSync,
  layout: Layout,
): Promise<TaskLifecycleRecoveryResult> {
  ensureTaskCloseIntentTable(db);
  const candidates = db.prepare(
    `SELECT DISTINCT t.repoId
       FROM task t
       LEFT JOIN task_close_intent i ON i.taskId = t.taskId
      WHERE t.state = 'CREATING' OR i.taskId IS NOT NULL
      ORDER BY t.repoId ASC`,
  ).all() as { repoId: string }[];

  const total = emptyResult();
  for (const { repoId } of candidates) {
    const result = await withRepoWriteLock(repoId, () => reconcileRepo(db, layout, repoId), layout);
    addResult(total, result);
  }
  return total;
}
