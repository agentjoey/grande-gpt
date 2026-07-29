import { execFileSync } from "node:child_process";
import type { Layout } from "./layout.ts";
import { registeredIds } from "./registry.ts";
import { resolveRepoPath } from "./paths.ts";
import { GitError } from "./worktree.ts";

export interface BaseStatus {
  baseCommit: string;
  behind: number | null;
  diverged: boolean | null;
}

/** 本模块每一条 git 调用都使用 argv，并无条件禁用仓库 hooks。 */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new GitError("GIT_FAILED", `git ${args[0] ?? "命令"} 失败：${detail}`);
  }
}

function canonicalHead(canonicalPath: string): string | null {
  try {
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "symbolic-ref", "-q", "--short", "HEAD"],
      { cwd: canonicalPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer | string; message: string };
    if (e.status === 1) return null;
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new GitError("GIT_FAILED", `git symbolic-ref 失败：${detail}`);
  }
  return git(canonicalPath, ["rev-parse", "HEAD"]).trim();
}

/**
 * `behind` 使用 `<baseCommit>..<canonical HEAD>` 的两点范围，直接计算 canonical
 * 相对任务起点新增的全部可达 commit；merge 的另一侧祖先会被如实计入，不使用
 * `HEAD~N` 的第一父级猜测。`diverged` 仅在 canonical 前进且任务分支也拥有
 * canonical HEAD 不可达的新 commit 时为 true。这里绝不 fetch，也不修改仓库。
 */
export function inspectBaseStatus(
  layout: Layout,
  task: { repoId: string; worktreePath: string; baseCommit: string },
): BaseStatus {
  const canonicalPath = resolveRepoPath(layout, task.repoId, registeredIds(layout));
  const head = canonicalHead(canonicalPath);
  if (head === null) {
    return { baseCommit: task.baseCommit, behind: null, diverged: null };
  }

  const behind = Number.parseInt(
    git(canonicalPath, ["rev-list", "--count", `${task.baseCommit}..${head}`]).trim(),
    10,
  );
  const taskAhead = Number.parseInt(
    git(task.worktreePath, ["rev-list", "--count", `${head}..HEAD`]).trim(),
    10,
  );
  if (!Number.isInteger(behind) || !Number.isInteger(taskAhead)) {
    throw new GitError("GIT_FAILED", "git rev-list 返回了无法解析的提交计数。 ");
  }
  return {
    baseCommit: task.baseCommit,
    behind,
    diverged: behind > 0 && taskAhead > 0,
  };
}
