import type { DatabaseSync } from "node:sqlite";
import { workspaceDigest } from "./attestation.ts";
import type { Layout } from "./layout.ts";
import { StateError } from "./errors.ts";
import { loadEffectiveCommitPolicy, RepoPolicyError } from "./repoPolicy.ts";

export interface CommitPolicyResult {
  workspaceDigest: string;
  requiredProfiles: string[];
}

/**
 * 一个 profile 只有在 passed、exitCode=0，且 run 启动时记录的工作区摘要与当前
 * commit 前摘要完全一致时才算绿色。名称相同但摘要不同的旧结果不能复用。
 */
function missingProfiles(
  db: DatabaseSync,
  taskId: string,
  digest: string,
  required: readonly string[],
): string[] {
  const query = db.prepare(
    `SELECT 1 FROM job
      WHERE taskId=? AND profile=? AND state='passed' AND exitCode=0 AND workspaceDigest=?
      LIMIT 1`,
  );
  return required.filter((profile) => query.get(taskId, profile, digest) === undefined);
}

/** 在任何 git add/commit 之前执行；拒绝路径只写审计，不触碰 worktree 或 HEAD。 */
export function assertCommitPolicy(
  db: DatabaseSync,
  layout: Layout,
  task: { taskId: string; worktreePath: string },
): CommitPolicyResult {
  let requiredProfiles: string[];
  try {
    requiredProfiles = loadEffectiveCommitPolicy(
      layout,
      task.worktreePath,
    ).requireGreenBeforeCommit ?? [];
  } catch (error) {
    if (error instanceof RepoPolicyError) {
      throw new StateError(error.code, error.message);
    }
    throw error;
  }

  const digest = workspaceDigest(task.worktreePath);
  const missing = missingProfiles(db, task.taskId, digest, requiredProfiles);
  if (missing.length > 0) {
    throw new StateError(
      "POLICY_DENIED",
      `commit 被 requireGreenBeforeCommit 拒绝：当前工作区状态缺少通过的 profile：${missing.join("、")}。` +
        `请在不再修改工作区的前提下运行这些 profile，全部绿色后再提交。`,
    );
  }
  return { workspaceDigest: digest, requiredProfiles };
}
