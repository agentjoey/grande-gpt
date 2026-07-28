import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Layout } from "./layout.ts";
import { assertTaskId } from "./paths.ts";
import { getTask, listActiveTasks } from "./tasks.ts";
import { registeredIds } from "./registry.ts";
import { GitError, removeWorktree } from "./worktree.ts";
import { resolveRepoPath } from "./paths.ts";

export interface GcPlan {
  orphanWorktrees: { repoId: string; taskId: string; path: string; branch: string | null }[];
  ghostTasks: { taskId: string; repoId: string; worktreePath: string }[];
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
    out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
 *
 * 方向 A（磁盘有、库里没有 → 孤儿 worktree）：
 *   扫描 worktreesRoot 下每个 repoId/taskId 目录，对数据库里查不到 task 行的，
 *   通过 `git worktree list --porcelain` 反查分支名，加入回收清单。
 *
 * 方向 B（库里有、磁盘没有 → 幽灵 task）：
 *   遍历所有非 CLOSED 的 task 行，其 worktreePath 在文件系统上不存在，
 *   加入 CLOSED 修复清单。
 */
export function planGc(db: DatabaseSync, layout: Layout): GcPlan {
  const orphanWorktrees: GcPlan["orphanWorktrees"] = [];
  const ghostTasks: GcPlan["ghostTasks"] = [];

  const worktreesRoot = layout.worktreesRoot;

  // 方向 A：扫描磁盘上的 worktree 目录
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

  // 方向 B：扫描 DB 中的幽灵 task（有记录但 worktree 目录不存在）
  for (const t of listActiveTasks(db)) {
    if (!existsSync(t.worktreePath)) {
      ghostTasks.push({ taskId: t.taskId, repoId: t.repoId, worktreePath: t.worktreePath });
    }
  }

  return { orphanWorktrees, ghostTasks };
}

/**
 * 应用 GC 计划。
 *
 * 方向 A：对每个孤儿 worktree 尝试 `git worktree remove --force`。
 *   branch 已知时走完整的 `removeWorktree`（含分支清理）；
 *   branch 为 null 时（git worktree 注册项已被 prune / canonical .git 缺失 /
 *   detached HEAD）只做 `git worktree remove --force`，不做分支删除。
 *   两者都以「目录是否真的被清掉了」为准计数——若 removeWorktree 因分支删除
 *   失败而抛错、但 worktree 目录本身已被移除，仍计入 removed。
 *   目录仍然在磁盘上时不计入 removed（不是「跳过并谎报」，是「真的没回收成功」）。
 *
 * 方向 B：对每个幽灵 task 做直接 UPDATE 标为 CLOSED（不做文件系统操作——
 *   worktree 目录已经不存在，没有东西可删）。
 *
 * CAS 守卫：每一条 task 更新都加了 `AND state != 'CLOSED'`，防止并发/反复
 *   调用覆盖已经 CLOSED 的记录（与 jobs.ts 里 finishJob 的 CAS 同源）。
 */
export function applyGc(db: DatabaseSync, layout: Layout, plan: GcPlan): { removed: number; closed: number } {
  let removed = 0;
  let closed = 0;

  for (const o of plan.orphanWorktrees) {
    if (!existsSync(o.path)) continue;

    try {
      if (o.branch !== null) {
        removeWorktree(layout, { repoId: o.repoId, worktreePath: o.path, branch: o.branch });
      } else {
        const repoRoot = resolveRepoPath(layout, o.repoId, registeredIds(layout));
        execFileSync("git", ["worktree", "remove", "--force", o.path], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      removed++;
    } catch {
      // removeWorktree 可能在 worktree 目录已成功移除之后、
      // 因分支删除失败而抛错（src/worktree.ts:203-211）。
      // 此计数落后于 removeWorktree 内部的 git branch -D 异常。
      // 此时 worktree 目录本身已经不存在——不能因为分支删不掉就假装目录还在。
      if (!existsSync(o.path)) {
        removed++;
      }
      // 目录仍然存在：repo 未注册 / git 工作树损坏 / 权限不足……
      // 确实没有回收成功，不计数；这个孤儿下次 gc 会再次出现。
    }
  }

  for (const g of plan.ghostTasks) {
    const res = db
      .prepare("UPDATE task SET state = 'CLOSED', updatedAt = ?, stateVersion = stateVersion + 1 WHERE taskId = ? AND state != 'CLOSED'")
      .run(Date.now(), g.taskId);
    if (res.changes > 0) closed++;
  }

  return { removed, closed };
}
