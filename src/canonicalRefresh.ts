import { inspectCanonicalGitState } from "./canonicalGit.ts";
import { StateError } from "./errors.ts";
import { GitExecError, safeGit, type SafeGitOptions } from "./gitExec.ts";
import type { Layout } from "./layout.ts";
import { resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { GitError } from "./worktree.ts";

export type CanonicalRefreshRelation = "no_remote" | "equal" | "remote_ahead" | "local_ahead" | "diverged";

export interface CanonicalRefreshResult {
  action: "none" | "fast-forward";
  relation: CanonicalRefreshRelation;
  branch: string;
  before: string;
  after: string;
  remoteHead: string | null;
}

function detailFromGitError(error: unknown): { status: number | null; detail: string } {
  if (error instanceof GitExecError) {
    return {
      status: error.status,
      detail: error.message.replace(/^git failed:\s*/u, ""),
    };
  }
  return {
    status: null,
    detail: error instanceof Error ? error.message : String(error),
  };
}

function git(cwd: string, args: string[], options: SafeGitOptions = {}): string {
  try {
    return safeGit.local(cwd, args, options);
  } catch (error) {
    const detail = detailFromGitError(error).detail;
    throw new GitError("GIT_FAILED", `git ${args[0] ?? "命令"} 失败：${detail}`);
  }
}

function tryGit(cwd: string, args: string[]): { ok: true; value: string } | { ok: false; status: number | null; detail: string } {
  try {
    return {
      ok: true,
      value: safeGit.local(cwd, args).trim(),
    };
  } catch (error) {
    const failure = detailFromGitError(error);
    return {
      ok: false,
      status: failure.status,
      detail: failure.detail,
    };
  }
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    return safeGit.tryRelation(cwd, ancestor, descendant);
  } catch (error) {
    const detail = detailFromGitError(error).detail;
    throw new GitError("GIT_FAILED", `git merge-base 失败：${detail}`);
  }
}

/**
 * 把 registered repo 的本机 canonical branch 安全刷新到 origin 同名 branch。
 *
 * 边界刻意很窄：remote 固定为 origin，ref 固定为当前 canonical branch；只允许 clean
 * checkout 上 fetch + compare + fast-forward。expectedBranch 只是一道相等性 guard，不能
 * 指定要 fetch 的 ref。没有 origin 的纯本地项目保持原有 local-loop 语义；dirty、
 * local-ahead 或 diverged 都 fail closed，绝不 reset/force/自动 merge。
 */
export function refreshCanonical(
  layout: Layout,
  repoId: string,
  expectedBranch?: string,
): CanonicalRefreshResult {
  const repoRoot = resolveRepoPath(layout, repoId, registeredIds(layout));
  const state = inspectCanonicalGitState(repoRoot);
  if (!state.repository || !state.headExists || state.headSha === null || state.inspectionError !== null) {
    throw new StateError("CANONICAL_BUSY", `仓库 ${repoId} 的 canonical Git 状态无法安全确认，拒绝 refresh。`);
  }
  if (state.detached || state.busy || state.branch === null) {
    throw new StateError(
      "CANONICAL_BUSY",
      `仓库 ${repoId} 的 canonical checkout 不是可安全刷新的正常分支状态，拒绝 refresh。`,
    );
  }
  if (expectedBranch !== undefined && state.branch !== expectedBranch) {
    throw new StateError(
      "CANONICAL_BUSY",
      `仓库 ${repoId} 当前 canonical branch=${state.branch}，但当前 PR base=${expectedBranch}；` +
        `不会切分支或刷新任意 ref，拒绝继续。`,
    );
  }

  const dirty = git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (dirty.length > 0) {
    throw new StateError(
      "CANONICAL_DIRTY",
      `仓库 ${repoId} 的 canonical checkout 有未提交改动；为避免覆盖 Human 工作，拒绝 refresh。`,
    );
  }

  const branch = state.branch;
  const before = state.headSha;
  const origin = tryGit(repoRoot, ["remote", "get-url", "origin"]);
  if (!origin.ok) {
    return { action: "none", relation: "no_remote", branch, before, after: before, remoteHead: null };
  }

  // 不接受调用方 ref/remote；只取当前 canonical branch 的同名 origin ref。
  // fetch 虽不改工作树 HEAD，但会写 remote-tracking ref，因此执行前重新绑定 branch+HEAD。
  git(repoRoot, [
    "fetch", "--no-tags", "origin",
    `refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ], { expectedBranch: branch, expectedHead: before });
  const remoteHead = git(repoRoot, ["rev-parse", `refs/remotes/origin/${branch}`]).trim();
  const localHead = git(repoRoot, ["rev-parse", "HEAD"]).trim();

  if (localHead === remoteHead) {
    return { action: "none", relation: "equal", branch, before, after: localHead, remoteHead };
  }

  if (isAncestor(repoRoot, localHead, remoteHead)) {
    git(repoRoot, ["merge", "--ff-only", `refs/remotes/origin/${branch}`], {
      expectedBranch: branch,
      expectedHead: localHead,
    });
    const after = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    if (after !== remoteHead) {
      throw new StateError("CANONICAL_DIVERGED", `仓库 ${repoId} refresh 后 HEAD 未达到 origin/${branch}，拒绝继续。`);
    }
    return { action: "fast-forward", relation: "remote_ahead", branch, before, after, remoteHead };
  }

  if (isAncestor(repoRoot, remoteHead, localHead)) {
    throw new StateError(
      "CANONICAL_DIVERGED",
      `仓库 ${repoId} 的 local canonical 领先 origin/${branch}；不会自动 push/reset，拒绝继续。`,
    );
  }

  throw new StateError(
    "CANONICAL_DIVERGED",
    `仓库 ${repoId} 的 local canonical 与 origin/${branch} 已分叉；不会自动 merge/reset，拒绝继续。`,
  );
}
