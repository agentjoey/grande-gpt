import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";
import { StateError } from "./errors.ts";
import { GitError } from "./worktree.ts";

export interface CommitResult {
  commit: string;
  message: string;
  filesChanged: number;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

export interface WorktreeCommitState {
  head: string;
  hasChanges: boolean;
}

/**
 * Bind a task operation to the branch recorded in the control plane.
 * Worktree paths are durable task state, but Git still permits a caller to
 * detach HEAD or switch that directory to another branch. Continuing would
 * commit/push/merge a ref different from the one the task and PR name.
 */
export function assertTaskBranch(worktreePath: string, expectedBranch: string): string {
  let actualBranch: string;
  try {
    actualBranch = execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "symbolic-ref", "-q", "--short", "HEAD"],
      { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (error) {
    const e = error as { status?: number; stderr?: Buffer | string; message: string };
    if (e.status === 1) {
      throw new StateError(
        "STALE_STATE",
        `任务 worktree 处于 detached HEAD；期望分支 ${expectedBranch}，拒绝继续。`,
      );
    }
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new GitError("GIT_FAILED", `git symbolic-ref 失败：${detail}`);
  }
  if (actualBranch !== expectedBranch) {
    throw new StateError(
      "STALE_STATE",
      `任务 worktree 当前分支 ${actualBranch} 与记录的任务分支 ${expectedBranch} 不一致，拒绝继续。`,
    );
  }
  return git(worktreePath, ["rev-parse", "HEAD"]).trim();
}

/**
 * S2 的所有 git 调用都从这个 helper 经过。`core.hooksPath=/dev/null` 位于 argv
 * 前缀，因而 status/add/diff/commit/rev-parse 无一例外；这不是只保护 commit
 * 那一条，而是把本模块整个 git 能力面都固定为「绝不执行仓库 hook」。
 */
function git(worktreePath: string, args: string[], config: string[] = []): string {
  const argv = ["-c", "core.hooksPath=/dev/null", ...config, ...args];
  try {
    return execFileSync("git", argv, {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    throw new GitError("GIT_FAILED", `git ${args[0] ?? "命令"} 失败：${detail}`);
  }
}

/** 读取当前 HEAD 与是否存在未提交改动；不创建 commit。 */
export function inspectWorktreeCommitState(worktreePath: string): WorktreeCommitState {
  const status = git(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const head = git(worktreePath, ["rev-parse", "HEAD"]).trim();
  return { head, hasChanges: status.length > 0 };
}

/**
 * commit 与 merge commit 共用同一份控制平面身份。导出给 syncBase 使用，避免
 * merge 回退到宿主 git 全局身份，或把身份写进共享的 .git/config。
 */
export function loadCommitIdentity(layout: Layout): CommitIdentity {
  const path = join(layout.configDir, "identity.yaml");
  if (!existsSync(path)) {
    throw new StateError(
      "INVALID_INPUT",
      `缺少提交身份配置 ${path}。请配置 commit.name 与 commit.email；GrandeGPT 不会猜默认值，也不会回退到宿主 git 全局身份。`,
    );
  }

  let doc: unknown;
  try {
    doc = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new StateError(
      "INVALID_INPUT",
      `无法解析提交身份配置 ${path}：${error instanceof Error ? error.message : String(error)}。` +
        `请配置非空的 commit.name 与 commit.email。`,
    );
  }

  const commit = (doc && typeof doc === "object" ? (doc as { commit?: unknown }).commit : undefined);
  const record = commit && typeof commit === "object" ? commit as Record<string, unknown> : {};
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const email = typeof record.email === "string" ? record.email.trim() : "";
  if (!name || !email) {
    throw new StateError(
      "INVALID_INPUT",
      `提交身份配置 ${path} 不完整。请配置非空的 commit.name 与 commit.email；` +
        `GrandeGPT 不会猜默认值，也不会回退到宿主 git 全局身份。`,
    );
  }
  return { name, email };
}

function buildCommitMessage(taskId: string, message: string, attestationId = "none"): string {
  const body = message
    .split(/\r?\n/)
    .filter((line) => !/^\s*Grande-(?:Task|Attestation)\s*:/i.test(line))
    .join("\n")
    .trim();
  if (!body) {
    throw new StateError("INVALID_INPUT", "提交 message 在移除伪造尾注后为空；请提供真实的提交说明。 ");
  }
  return `${body}\n\nGrande-Task: ${taskId}\nGrande-Attestation: ${attestationId}`;
}

/** 把 worktree 的全部改动提交到任务分支。绝不执行 hooks。 */
export function commitWorktree(
  layout: Layout,
  worktreePath: string,
  taskId: string,
  message: string,
  attestationId = "none",
): CommitResult {
  const identity = loadCommitIdentity(layout);
  const state = inspectWorktreeCommitState(worktreePath);
  if (!state.hasChanges) {
    if (attestationId === "none") {
      throw new StateError("INVALID_INPUT", `任务 ${taskId} 的 worktree 没有任何改动；拒绝产生空 commit。`);
    }
    return {
      commit: state.head,
      message: "当前 HEAD 已通过 fresh verification；未创建空 commit。",
      filesChanged: 0,
    };
  }

  const finalMessage = buildCommitMessage(taskId, message, attestationId);
  git(worktreePath, ["add", "--all"]);
  const changed = git(worktreePath, ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean);
  if (changed.length === 0) {
    throw new StateError("INVALID_INPUT", `任务 ${taskId} 的 worktree 没有可提交改动；拒绝产生空 commit。`);
  }

  git(
    worktreePath,
    ["commit", "-q", "-m", finalMessage],
    ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`],
  );
  const commit = git(worktreePath, ["rev-parse", "HEAD"]).trim();
  return { commit, message: finalMessage, filesChanged: changed.length };
}
