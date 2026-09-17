import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import { safeGit } from "./gitExec.ts";
import type { Layout } from "./layout.ts";
import { resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import {
  saveExplicitDeliveryTarget,
  type DeliveryTarget,
} from "./taskDeliveryTarget.ts";
import { saveTaskCloseIntent, type TaskCloseIntent } from "./taskCloseIntent.ts";
import { createTask, updateTaskState, type TaskRow } from "./tasks.ts";
import { openWorktree, type WorktreeInfo } from "./worktree.ts";
import { planTaskWorktree } from "./taskWorktreePlan.ts";

export interface TaskLifecycleDeps {
  db: DatabaseSync;
  layout: Layout;
}

export interface TaskOpenLifecycleInput {
  taskId: string;
  repoId: string;
  slug: string;
  deliveryTarget?: DeliveryTarget;
}

type WorktreeMaterializer = (
  layout: Layout,
  repoId: string,
  slug: string,
  taskId: string,
) => WorktreeInfo;

/**
 * Persist CREATING before the first Git mutation. If materialization throws or the
 * process dies afterwards, startup/periodic reconciliation has a durable owner row.
 */
export function openTaskWithCreating(
  deps: TaskLifecycleDeps,
  input: TaskOpenLifecycleInput,
  materialize: WorktreeMaterializer = openWorktree,
): TaskRow {
  const planned = planTaskWorktree(deps.layout, input.repoId, input.slug, input.taskId);
  const creating = createTask(deps.db, {
    taskId: input.taskId,
    repoId: input.repoId,
    branch: planned.branch,
    baseCommit: planned.baseCommit,
    worktreePath: planned.worktreePath,
    state: "CREATING",
  });
  if (input.deliveryTarget !== undefined) {
    saveExplicitDeliveryTarget(deps.db, input.taskId, input.deliveryTarget);
  }

  const actual = materialize(deps.layout, input.repoId, input.slug, input.taskId);
  if (
    actual.branch !== planned.branch
    || actual.baseCommit !== planned.baseCommit
    || actual.worktreePath !== planned.worktreePath
  ) {
    throw new StateError(
      "STALE_STATE",
      `任务 ${input.taskId} 的 worktree materialization 与 durable CREATING plan 不一致；拒绝标记 READY。`,
    );
  }
  return updateTaskState(deps.db, input.taskId, "READY", creating.stateVersion);
}

/**
 * Prove a clean exact task checkout before persisting close intent. Dirty/untracked data
 * is user data, not garbage; task_close must refuse it instead of relying on --force.
 */
export function prepareTaskCloseIntent(db: DatabaseSync, task: TaskRow): TaskCloseIntent {
  const headSha = safeGit.local(
    task.worktreePath,
    ["rev-parse", "HEAD"],
    { expectedBranch: task.branch },
  ).trim();
  const dirty = safeGit.local(
    task.worktreePath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { expectedBranch: task.branch, expectedHead: headSha },
  );
  if (dirty.length > 0) {
    throw new StateError(
      "WORKTREE_DIRTY",
      `任务 ${task.taskId} 的 worktree 有未提交或未跟踪修改；拒绝关闭并保留现场。`,
    );
  }
  return saveTaskCloseIntent(db, {
    taskId: task.taskId,
    expectedStateVersion: task.stateVersion,
    headSha,
  });
}

/**
 * Close-path Git mutation bound to the exact durable intent. This deliberately mirrors
 * the Task 1 locked cleanup rule: HEAD.lock + exact branch/head + non-force remove.
 */
export function removeTaskWorktreeForClose(
  layout: Layout,
  task: TaskRow,
  expectedHead: string,
): void {
  const expectedPath = join(layout.worktreesRoot, task.repoId, task.taskId);
  if (task.worktreePath !== expectedPath) {
    throw new StateError(
      "STALE_STATE",
      `任务 ${task.taskId} 的 worktreePath 不属于受管路径；拒绝自动关闭。`,
    );
  }
  if (!existsSync(task.worktreePath)) {
    throw new StateError(
      "STALE_STATE",
      `任务 ${task.taskId} 的 worktree 已不存在；保留 durable close intent 交给 reconciliation。`,
    );
  }

  const repoRoot = resolveRepoPath(layout, task.repoId, registeredIds(layout));
  const expected = { expectedBranch: task.branch, expectedHead };
  const dirtyBeforeLock = safeGit.local(
    task.worktreePath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    expected,
  );
  if (dirtyBeforeLock.length > 0) {
    throw new StateError(
      "WORKTREE_DIRTY",
      `任务 ${task.taskId} 的 worktree 在 close intent 后出现修改；拒绝删除并保留现场。`,
    );
  }

  const gitAdminDir = safeGit.local(
    task.worktreePath,
    ["rev-parse", "--absolute-git-dir"],
    expected,
  ).trim();
  if (gitAdminDir.length === 0) {
    throw new StateError("STALE_STATE", `任务 ${task.taskId} 无法确认 Git admin dir；拒绝关闭。`);
  }

  const lockPath = join(gitAdminDir, "HEAD.lock");
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    const dirtyLocked = safeGit.local(
      task.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      expected,
    );
    if (dirtyLocked.length > 0) {
      throw new StateError(
        "WORKTREE_DIRTY",
        `任务 ${task.taskId} 的 worktree 在 locked cleanup 前出现修改；拒绝删除并保留现场。`,
      );
    }
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

  const registered = safeGit.local(repoRoot, ["worktree", "list", "--porcelain"])
    .split("\n")
    .some((line) => line === `branch refs/heads/${task.branch}`);
  if (registered) {
    throw new StateError(
      "STALE_STATE",
      `任务 ${task.taskId} 的分支仍被其他 worktree 注册；拒绝删除分支，等待 reconciliation。`,
    );
  }
  safeGit.local(repoRoot, ["update-ref", "-d", `refs/heads/${task.branch}`, expectedHead]);
}
