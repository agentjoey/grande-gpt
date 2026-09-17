import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectCanonicalGitState } from "./canonicalGit.ts";
import type { Layout } from "./layout.ts";
import { assertTaskId, assertValidId, resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { GitError, type WorktreeInfo } from "./worktree.ts";

/** Read-only plan used to persist CREATING before any Git worktree mutation. */
export function planTaskWorktree(
  layout: Layout,
  repoId: string,
  slug: string,
  taskId: string,
): WorktreeInfo {
  assertValidId(taskId, "taskId");
  assertTaskId(taskId);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) {
    throw new GitError("INVALID_INPUT", `slug 必须是 1–40 个小写字母、数字或连字符，收到：${slug}`);
  }

  const repoRoot = resolveRepoPath(layout, repoId, registeredIds(layout));
  const canonical = inspectCanonicalGitState(repoRoot);
  if (!canonical.repository) {
    throw new GitError("GIT_FAILED", `${repoRoot} 不是有效 Git repository，不能派生 worktree。`);
  }
  if (canonical.inspectionError !== null) {
    throw new GitError("GIT_FAILED", `${repoRoot} 无法确认 canonical Git 状态：${canonical.inspectionError}`);
  }
  if (!canonical.headExists || canonical.headSha === null) {
    throw new GitError("GIT_FAILED", `${repoRoot} 没有 baseline commit（HEAD 不存在），不能派生 worktree。`);
  }
  if (canonical.busyReasons.length > 0) {
    throw new GitError(
      "CANONICAL_BUSY",
      `${repoRoot} 正处于 ${canonical.busyReasons[0]!} 状态。请先在你自己的 checkout 里处理完，再开新任务。`,
    );
  }
  if (canonical.detached || canonical.branch === null) {
    throw new GitError(
      "CANONICAL_BUSY",
      `${repoRoot} 处于 detached HEAD（不在任何分支上）。请先在你自己的 checkout 里切回一个分支，再开新任务。`,
    );
  }

  const worktreePath = join(layout.worktreesRoot, repoId, taskId);
  if (existsSync(worktreePath)) {
    throw new GitError("WORKTREE_EXISTS", `${taskId} 的 worktree 已存在：${worktreePath}`);
  }
  const suffix = (taskId.match(/[A-Za-z0-9]/g) ?? []).slice(-4).join("");
  return {
    taskId,
    branch: `grande/${slug}-${suffix}`,
    baseCommit: canonical.headSha,
    worktreePath,
  };
}
