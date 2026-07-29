import { execFileSync } from "node:child_process";
import type { Layout } from "./layout.ts";
import { createCheckpoint } from "./checkpoint.ts";
import { loadCommitIdentity } from "./commit.ts";
import { StateError } from "./errors.ts";
import { resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { GitError } from "./worktree.ts";

export interface SyncBaseResult {
  action: "up-to-date" | "fast-forward" | "merged";
  before: string;
  after: string;
  canonicalHead: string;
  checkpointId: string;
}

const splitZ = (value: string): string[] => value.split("\0").filter(Boolean);

/** 每条 git 调用都以 argv 执行，并统一禁用全部仓库 hooks。 */
function git(cwd: string, args: string[], config: string[] = []): string {
  try {
    return execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...config, ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new GitError("GIT_FAILED", `git ${args[0] ?? "命令"} 失败：${detail}`);
  }
}

/** Git 用退出码 0/1 表达祖先关系，不能用普通 git helper 把 1 当命令故障。 */
function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "merge-base", "--is-ancestor", ancestor, descendant],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer | string; message: string };
    if (e.status === 1) return false;
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new GitError("GIT_FAILED", `git merge-base 失败：${detail}`);
  }
}

function canonicalHead(canonicalPath: string): string {
  try {
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "symbolic-ref", "-q", "--short", "HEAD"],
      { cwd: canonicalPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer | string; message: string };
    if (e.status === 1) {
      throw new StateError("INVALID_INPUT", "canonical checkout 处于 detached HEAD，无法安全同步 base。 ");
    }
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new GitError("GIT_FAILED", `git symbolic-ref 失败：${detail}`);
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
  canonical: string,
): void {
  const identity = loadCommitIdentity(layout);
  try {
    execFileSync(
      "git",
      [
        "-c", "core.hooksPath=/dev/null",
        "-c", `user.name=${identity.name}`,
        "-c", `user.email=${identity.email}`,
        "merge", "--no-edit", canonical,
      ],
      { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const conflicts = splitZ(git(worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"]));
    if (conflicts.length > 0) {
      // merge 冲突是一项整体失败：必须先 abort 到操作前状态，再把错误交给模型。
      git(worktreePath, ["merge", "--abort"]);
      throw new StateError(
        "MERGE_CONFLICT",
        `同步 base 发生冲突，已执行 git merge --abort 并恢复操作前状态。冲突文件：${conflicts.join("、")}`,
      );
    }
    const e = error as { stderr?: Buffer | string; message: string };
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new GitError("GIT_FAILED", `git merge 失败：${detail}`);
  }
}

/**
 * 只使用本机 canonical HEAD，不 fetch。开始前要求 worktree 干净并建立 checkpoint；
 * 无任务提交时快进，双方都有提交时 merge。冲突时一定 abort，不把半完成状态留给模型。
 */
export function syncBase(
  layout: Layout,
  task: { taskId: string; repoId: string; worktreePath: string; baseCommit: string },
): SyncBaseResult {
  const dirty = git(task.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (dirty.length > 0) {
    throw new StateError("WORKTREE_DIRTY", "同步 base 前 worktree 必须干净；请先提交或回滚当前改动。 ");
  }

  const canonicalPath = resolveRepoPath(layout, task.repoId, registeredIds(layout));
  const canonical = canonicalHead(canonicalPath);
  const before = git(task.worktreePath, ["rev-parse", "HEAD"]).trim();
  const checkpointId = createCheckpoint(
    layout,
    task.taskId,
    task.worktreePath,
    checkpointPaths(task.worktreePath),
  );

  if (isAncestor(task.worktreePath, canonical, before)) {
    return { action: "up-to-date", before, after: before, canonicalHead: canonical, checkpointId };
  }

  const taskHasOwnCommits = Number.parseInt(
    git(task.worktreePath, ["rev-list", "--count", `${task.baseCommit}..HEAD`]).trim(),
    10,
  ) > 0;

  if (!taskHasOwnCommits) {
    git(task.worktreePath, ["merge", "--ff-only", canonical]);
    const after = git(task.worktreePath, ["rev-parse", "HEAD"]).trim();
    return { action: "fast-forward", before, after, canonicalHead: canonical, checkpointId };
  }

  mergeCanonical(layout, task.worktreePath, canonical);
  const after = git(task.worktreePath, ["rev-parse", "HEAD"]).trim();
  return { action: "merged", before, after, canonicalHead: canonical, checkpointId };
}
