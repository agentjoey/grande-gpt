import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeGit } from "./gitExec.ts";
import type { Layout } from "./layout.ts";
import { assertTaskId } from "./paths.ts";
import { acquireRepoProcessLock } from "./repoProcessLock.ts";
import { withRepoWriteLock } from "./repoWriteLock.ts";
import { getTask, listActiveTasks } from "./tasks.ts";
import { registeredIds } from "./registry.ts";
import { removeWorktree } from "./worktree.ts";
import { resolveRepoPath } from "./paths.ts";

export interface GcPlan {
  orphanWorktrees: { repoId: string; taskId: string; path: string; branch: string | null }[];
  ghostTasks: { taskId: string; repoId: string; worktreePath: string }[];
  closedResidualWorktrees: { taskId: string; repoId: string; worktreePath: string; branch: string }[];
}

export interface GcApplyResult {
  removed: number;
  closed: number;
  reconciledClosedResiduals: number;
}

/**
 * 从 git worktree list --porcelain 的输出中解析出所有 worktree 路径到分支名的映射。
 * 分支行格式：`branch refs/heads/<name>`，提取 <name> 部分。
 * detached HEAD 的 worktree 在映射中值为 null。
 */
function parseWorktreeBranches(repoRoot: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  let out: string;
  try {
    out = safeGit.local(repoRoot, ["worktree", "list", "--porcelain"]);
  } catch {
    return map;
  }

  let currentPath: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      const prefix = "refs/heads/";
      const branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
      if (currentPath) map.set(currentPath, branch);
      currentPath = null;
    } else if (line === "") {
      if (currentPath) map.set(currentPath, null);
      currentPath = null;
    }
  }
  if (currentPath) map.set(currentPath, null);
  return map;
}

/**
 * 扫描工作区，生成 GC 计划。只读——绝不改任何东西。
 */
export function planGc(db: DatabaseSync, layout: Layout): GcPlan {
  const orphanWorktrees: GcPlan["orphanWorktrees"] = [];
  const ghostTasks: GcPlan["ghostTasks"] = [];
  const closedResidualWorktrees: GcPlan["closedResidualWorktrees"] = [];
  const worktreesRoot = layout.worktreesRoot;

  if (existsSync(worktreesRoot)) {
    for (const repoEntry of readdirSync(worktreesRoot, { withFileTypes: true })) {
      if (!repoEntry.isDirectory()) continue;
      const repoId = repoEntry.name;
      const repoDir = join(worktreesRoot, repoId);
      if (!existsSync(repoDir)) continue;

      const canonicalRepo = join(layout.workspaceRoot, repoId);
      const branchMap = existsSync(join(canonicalRepo, ".git"))
        ? parseWorktreeBranches(canonicalRepo)
        : new Map<string, string | null>();

      for (const taskEntry of readdirSync(repoDir, { withFileTypes: true })) {
        if (!taskEntry.isDirectory()) continue;
        const taskId = taskEntry.name;
        try {
          assertTaskId(taskId);
        } catch {
          continue;
        }
        if (!getTask(db, taskId)) {
          const path = join(repoDir, taskId);
          const branch = branchMap.get(path) ?? null;
          orphanWorktrees.push({ repoId, taskId, path, branch });
        }
      }
    }
  }

  for (const t of listActiveTasks(db)) {
    if (!existsSync(t.worktreePath)) ghostTasks.push({ taskId: t.taskId, repoId: t.repoId, worktreePath: t.worktreePath });
  }

  const closedRows = db
    .prepare("SELECT taskId FROM task WHERE state='CLOSED' ORDER BY createdAt DESC, rowid DESC")
    .all() as { taskId: string }[];
  for (const row of closedRows) {
    const t = getTask(db, row.taskId);
    if (!t) continue;
    const expectedManagedPath = join(worktreesRoot, t.repoId, t.taskId);
    if (t.worktreePath !== expectedManagedPath || !existsSync(t.worktreePath)) continue;
    closedResidualWorktrees.push({
      taskId: t.taskId,
      repoId: t.repoId,
      worktreePath: t.worktreePath,
      branch: t.branch,
    });
  }

  return { orphanWorktrees, ghostTasks, closedResidualWorktrees };
}

function repoIdsForPlan(plan: GcPlan): string[] {
  return [...new Set([
    ...plan.orphanWorktrees.map((item) => item.repoId),
    ...plan.ghostTasks.map((item) => item.repoId),
    ...plan.closedResidualWorktrees.map((item) => item.repoId),
  ])].sort();
}

function repoSlice(plan: GcPlan, repoId: string): GcPlan {
  return {
    orphanWorktrees: plan.orphanWorktrees.filter((item) => item.repoId === repoId),
    ghostTasks: plan.ghostTasks.filter((item) => item.repoId === repoId),
    closedResidualWorktrees: plan.closedResidualWorktrees.filter((item) => item.repoId === repoId),
  };
}

function applyGcUnlocked(db: DatabaseSync, layout: Layout, plan: GcPlan): GcApplyResult {
  let removed = 0;
  let closed = 0;
  let reconciledClosedResiduals = 0;

  for (const o of plan.orphanWorktrees) {
    if (!existsSync(o.path)) continue;
    try {
      if (o.branch !== null) {
        removeWorktree(layout, { repoId: o.repoId, worktreePath: o.path, branch: o.branch });
      } else {
        const repoRoot = resolveRepoPath(layout, o.repoId, registeredIds(layout));
        safeGit.local(repoRoot, ["worktree", "remove", "--force", o.path]);
      }
      removed++;
    } catch {
      if (!existsSync(o.path)) removed++;
    }
  }

  for (const g of plan.ghostTasks) {
    const res = db
      .prepare("UPDATE task SET state = 'CLOSED', updatedAt = ?, stateVersion = stateVersion + 1 WHERE taskId = ? AND state != 'CLOSED'")
      .run(Date.now(), g.taskId);
    if (res.changes > 0) closed++;
  }

  for (const residual of plan.closedResidualWorktrees) {
    const current = getTask(db, residual.taskId);
    const expectedManagedPath = join(layout.worktreesRoot, residual.repoId, residual.taskId);
    // plan 可能已经 stale：apply 时再次证明仍然 CLOSED、仍指向同一受管 task path。
    if (
      !current
      || current.state !== "CLOSED"
      || current.repoId !== residual.repoId
      || current.worktreePath !== residual.worktreePath
      || current.worktreePath !== expectedManagedPath
      || !existsSync(current.worktreePath)
    ) {
      continue;
    }
    try {
      removeWorktree(layout, {
        repoId: current.repoId,
        worktreePath: current.worktreePath,
        branch: current.branch,
      });
      reconciledClosedResiduals++;
    } catch {
      // 与 orphan 路径保持同一计数语义：worktree 已删、仅 branch cleanup 报错时，
      // 仍算 residual worktree 已成功对账；目录仍在则 fail-closed，不谎报成功。
      if (!existsSync(current.worktreePath)) reconciledClosedResiduals++;
    }
  }

  return { removed, closed, reconciledClosedResiduals };
}

/**
 * standalone CLI / 既有同步调用入口。先按确定顺序拿齐所有 repo process locks，任何一把
 * 获取失败都发生在 mutation 之前；成功后才应用整个 plan，最后逆序释放。
 */
export function applyGc(db: DatabaseSync, layout: Layout, plan: GcPlan): GcApplyResult {
  const locks = [] as ReturnType<typeof acquireRepoProcessLock>[];
  try {
    for (const repoId of repoIdsForPlan(plan)) {
      locks.push(acquireRepoProcessLock(layout, repoId));
    }
    return applyGcUnlocked(db, layout, plan);
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}

/**
 * Gateway GC apply 与 task/commit/sync/push/merge/close 共用同一 per-repo 锁边界：先走
 * 进程内 FIFO，active critical section 再取得跨进程锁；不同 repo 仍可并行。
 */
export async function applyGcWithRepoWriteLocks(
  db: DatabaseSync,
  layout: Layout,
  plan: GcPlan,
): Promise<GcApplyResult> {
  const results = await Promise.all(repoIdsForPlan(plan).map((repoId) =>
    withRepoWriteLock(repoId, () => applyGcUnlocked(db, layout, repoSlice(plan, repoId)), layout),
  ));
  return results.reduce<GcApplyResult>(
    (total, result) => ({
      removed: total.removed + result.removed,
      closed: total.closed + result.closed,
      reconciledClosedResiduals: total.reconciledClosedResiduals + result.reconciledClosedResiduals,
    }),
    { removed: 0, closed: 0, reconciledClosedResiduals: 0 },
  );
}
