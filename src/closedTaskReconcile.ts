import { lstatSync } from "node:fs";
import { join } from "node:path";
import { assertTaskBranch } from "./commit.ts";
import { canonicalRepoPath } from "./deliveryMerge.ts";
import { err, ok } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import { safeGit } from "./gitExec.ts";
import { createGithubApi } from "./githubApi.ts";
import { loadGithubToken } from "./githubAuth.ts";
import { parseGithubRemote, readGithubRemoteUrl } from "./prOpen.ts";
import type { PrMergeD2Options } from "./prMergeD2Core.ts";
import { getExplicitDeliveryTarget } from "./taskDeliveryTarget.ts";
import { assertClosedTaskReconcileState, readTaskPrReceipt, recordClosedTaskPrMerged } from "./taskPrReceipt.ts";
import { getTask, type TaskRow } from "./tasks.ts";
import type { ToolDeps } from "./toolsCore.ts";

const SHA_RE = /^[0-9a-f]{40}$/u;

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertRemoved(task: TaskRow): void {
  if (exists(task.worktreePath)) {
    throw new StateError("STALE_STATE", "CLOSED task 仍有 worktree 残留；本入口不删除或覆盖文件。");
  }
}

/**
 * Repair historical PR evidence through the existing merge entrypoint. The outer tool
 * owns the repo write lock. This path performs remote reads and one audited SQLite write,
 * never remote merge, canonical refresh, branch mutation, worktree creation or cleanup.
 */
export async function reconcileClosedTask(
  deps: ToolDeps,
  task: TaskRow,
  options: PrMergeD2Options = {},
) {
  try {
    assertRemoved(task);
    const expectedHead = assertClosedTaskReconcileState(deps.db, task.taskId, task.stateVersion);
    const repoRoot = canonicalRepoPath(deps.layout, task.repoId);
    if (getExplicitDeliveryTarget(deps.db, task.taskId) === undefined
        && exists(join(repoRoot, ".grande", "deploy.yaml"))) {
      throw new StateError("POLICY_DENIED", "legacy task 存在 deployment 配置，不能按普通 PR 自动归档。");
    }
    const token = loadGithubToken(deps.layout).token;
    const readRemote = options.readRemoteUrl ?? readGithubRemoteUrl;
    const remoteUrl = readRemote(repoRoot, token);
    const { owner, repo } = parseGithubRemote(remoteUrl);
    const api = (options.apiFactory ?? createGithubApi)(token);
    const previous = readTaskPrReceipt(deps.db, task.taskId);
    const found = await api.findPullRequest(owner, repo, task.branch, "all");
    if (!found || !Number.isSafeInteger(found.number) || found.number <= 0) {
      throw new StateError("STALE_STATE", "找不到历史 task branch 对应的 PR。");
    }
    if (previous && (previous.prNumber !== found.number || previous.prUrl !== found.url)) {
      throw new StateError("STALE_STATE", "历史 PR identity 与当前 task branch 的查询结果冲突。");
    }
    const pr = await api.getPullRequest(owner, repo, found.number);
    const expectedUrl = `https://github.com/${owner}/${repo}/pull/${found.number}`;
    if (pr.number !== found.number || pr.url !== expectedUrl || found.url !== expectedUrl
        || pr.state !== "closed" || pr.merged !== true || pr.headRef !== task.branch
        || pr.headSha !== expectedHead || !SHA_RE.test(pr.headSha)
        || typeof pr.baseRef !== "string" || !pr.baseRef
        || typeof pr.mergeCommitSha !== "string" || !SHA_RE.test(pr.mergeCommitSha)) {
      throw new StateError("STALE_STATE", "GitHub PR/repo/branch/head/merged identity 与可信 task 证据不一致。");
    }

    // base.sha on a merged PR can move. The actual merge commit's ordered parents are
    // immutable: require a two-parent merge with this exact task head as its second parent.
    const canonicalHead = assertTaskBranch(repoRoot, pr.baseRef);
    const expected = { expectedBranch: pr.baseRef, expectedHead: canonicalHead };
    const parents = safeGit.local(repoRoot,
      ["rev-list", "--parents", "-n", "1", pr.mergeCommitSha], expected).trim().split(/\s+/u);
    const mergeBase = parents[1];
    if (parents.length !== 3 || parents[0] !== pr.mergeCommitSha || parents[2] !== expectedHead
        || !mergeBase || !SHA_RE.test(mergeBase) || !SHA_RE.test(task.baseCommit)
        || !safeGit.tryRelation(repoRoot, task.baseCommit, mergeBase)
        || !safeGit.tryRelation(repoRoot, pr.mergeCommitSha, canonicalHead)) {
      throw new StateError("STALE_STATE", "canonical 中缺少匹配 task head/base 的精确 merge ancestry；拒绝猜测历史证据。");
    }

    // Recheck after asynchronous reads; neither moved registration nor reappeared files
    // may be accepted using the earlier snapshot. SQLite rechecks version/jobs/attestation.
    const current = getTask(deps.db, task.taskId);
    if (!current || current.repoId !== task.repoId || current.branch !== task.branch
        || current.baseCommit !== task.baseCommit || current.worktreePath !== task.worktreePath
        || canonicalRepoPath(deps.layout, task.repoId) !== repoRoot
        || readRemote(repoRoot, token) !== remoteUrl) {
      throw new StateError("STALE_STATE", "历史 task/repository identity 在核验期间变化。");
    }
    assertRemoved(current);
    if (safeGit.local(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], expected).trim()) {
      throw new StateError("STALE_STATE", "canonical 存在未提交修改；保留现场，不补写证据。");
    }
    const receipt = recordClosedTaskPrMerged(deps.db, {
      taskId: task.taskId, prNumber: pr.number, prUrl: pr.url, headSha: expectedHead,
      baseRef: pr.baseRef, baseSha: mergeBase, mergeSha: pr.mergeCommitSha,
    }, task.stateVersion);
    return { structuredContent: ok({
      taskId: task.taskId,
      data: { merged: true, existing: true, reconciled: true, evidenceOnly: true,
        prNumber: receipt.prNumber, headSha: receipt.headSha, mergeSha: receipt.mergeSha,
        localState: "clean", cleanedUp: false },
      hint: "历史 CLOSED task 的 exact merge receipt 已核验；未重复 merge、创建 worktree 或执行 cleanup。",
    }) };
  } catch (error) {
    const failure = toToolError(error);
    failure.message = redact(failure.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
    return { structuredContent: err({ ...failure, taskId: task.taskId }) };
  }
}
