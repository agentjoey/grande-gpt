import type { Layout } from "./layout.ts";
import { createCheckpoint } from "./checkpoint.ts";
import { loadCommitIdentity } from "./commit.ts";
import { assertTaskBranch } from "./commit.ts";
import { StateError } from "./errors.ts";
import { GitExecError, safeGit, type SafeGitOptions } from "./gitExec.ts";
import { resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { GitError } from "./worktree.ts";

export type SyncBaseRelation = "equal" | "task_ahead" | "canonical_ahead" | "diverged";

export interface SyncBaseResult {
  action: "none" | "fast-forward" | "merged";
  relation: SyncBaseRelation;
  before: string;
  after: string;
  canonicalHead: string;
  checkpointId: string;
}

const splitZ = (value: string): string[] => value.split("\0").filter(Boolean);

function gitDetail(error: unknown): string {
  if (error instanceof GitExecError) return error.message.replace(/^git failed:\s*/u, "");
  return error instanceof Error ? error.message : String(error);
}

/** 每条 git 调用都以 argv 执行，并统一禁用全部仓库 hooks。 */
function git(
  cwd: string,
  args: string[],
  config: string[] = [],
  options: SafeGitOptions = {},
): string {
  try {
    return safeGit.local(cwd, [...config, ...args], options);
  } catch (error) {
    throw new GitError("GIT_FAILED", `git ${args[0] ?? "命令"} 失败：${gitDetail(error)}`);
  }
}

/** Git 用退出码 0/1 表达祖先关系，不能把 1 当命令故障。 */
function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    return safeGit.tryRelation(cwd, ancestor, descendant);
  } catch (error) {
    throw new GitError("GIT_FAILED", `git merge-base 失败：${gitDetail(error)}`);
  }
}

function relationOf(cwd: string, canonical: string, task: string): SyncBaseRelation {
  if (canonical === task) return "equal";
  if (isAncestor(cwd, canonical, task)) return "task_ahead";
  if (isAncestor(cwd, task, canonical)) return "canonical_ahead";
  return "diverged";
}

function canonicalHead(canonicalPath: string): string {
  try {
    safeGit.local(canonicalPath, ["symbolic-ref", "-q", "--short", "HEAD"]);
  } catch (error) {
    if (error instanceof GitExecError && error.status === 1) {
      throw new StateError("INVALID_INPUT", "canonical checkout 处于 detached HEAD，无法安全同步 base。 ");
    }
    throw new GitError("GIT_FAILED", `git symbolic-ref 失败：${gitDetail(error)}`);
  }
  return git(canonicalPath, ["rev-parse", "HEAD"]).trim();
}

function checkpointPaths(worktreePath: string): string[] {
  const tracked = splitZ(git(worktreePath, ["ls-files", "-z"]));
  const untracked = splitZ(git(worktreePath, ["ls-files", "-z", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

function mergeCanonical(
  layout: Layout,
  worktreePath: string,
  taskBranch: string,
  expectedHead: string,
  canonical: string,
): void {
  const identity = loadCommitIdentity(layout);
  try {
    safeGit.local(
      worktreePath,
      [
        "-c", `user.name=${identity.name}`,
        "-c", `user.email=${identity.email}`,
        "merge", "--no-edit", canonical,
      ],
      { expectedBranch: taskBranch, expectedHead },
    );
  } catch (error) {
    const conflicts = splitZ(git(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]));
    if (conflicts.length > 0) {
      git(worktreePath, ["merge", "--abort"], [], { expectedBranch: taskBranch, expectedHead });
      throw new StateError(
        "MERGE_CONFLICT",
        `同步 base 发生冲突，已执行 git merge --abort 并恢复操作前状态。冲突文件：${conflicts.join("、")}`,
      );
    }
    throw new GitError("GIT_FAILED", `git merge 失败：${gitDetail(error)}`);
  }
}

/**
 * 方向固定为 local canonical → task worktree；绝不修改 canonical，也不 fetch。
 * 开始前要求 task worktree 干净并建立 checkpoint。relation 描述调用前两个 HEAD 的
 * 图关系；equal/task_ahead 无需操作，canonical_ahead 只 fast-forward，diverged 才 merge。
 */
export function syncBase(
  layout: Layout,
  task: { taskId: string; repoId: string; branch: string; worktreePath: string; baseCommit: string },
): SyncBaseResult {
  const guardedHead = assertTaskBranch(task.worktreePath, task.branch);
  const dirty = git(task.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (dirty.length > 0) {
    throw new StateError("WORKTREE_DIRTY", "同步 base 前 worktree 必须干净；请先提交或回滚当前改动。 ");
  }

  const canonicalPath = resolveRepoPath(layout, task.repoId, registeredIds(layout));
  const canonical = canonicalHead(canonicalPath);
  const before = git(task.worktreePath, ["rev-parse", "HEAD"]).trim();
  if (before !== guardedHead) {
    throw new StateError("STALE_STATE", "同步 base 前 task HEAD 已发生变化；拒绝继续。 ");
  }
  const relation = relationOf(task.worktreePath, canonical, before);
  const checkpointId = createCheckpoint(
    layout,
    task.taskId,
    task.worktreePath,
    checkpointPaths(task.worktreePath),
  );

  if (relation === "equal" || relation === "task_ahead") {
    return { action: "none", relation, before, after: before, canonicalHead: canonical, checkpointId };
  }

  if (relation === "canonical_ahead") {
    git(task.worktreePath, ["merge", "--ff-only", canonical], [], {
      expectedBranch: task.branch,
      expectedHead: before,
    });
    const after = git(task.worktreePath, ["rev-parse", "HEAD"]).trim();
    return { action: "fast-forward", relation, before, after, canonicalHead: canonical, checkpointId };
  }

  mergeCanonical(layout, task.worktreePath, task.branch, before, canonical);
  const after = git(task.worktreePath, ["rev-parse", "HEAD"]).trim();
  return { action: "merged", relation, before, after, canonicalHead: canonical, checkpointId };
}
