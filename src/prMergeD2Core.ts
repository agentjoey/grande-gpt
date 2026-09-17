import { beginAudit } from "./audit.ts";
import { refreshCanonical, type CanonicalRefreshResult } from "./canonicalRefresh.ts";
import {
  activeAuthorizationForTask,
  type DeliveryAuthorizationBinding,
} from "./deliveryAuthorization.ts";
import {
  canonicalRepoPath,
  ensurePinnedReleaseSource,
  markMergeAuthorizationUncertain,
  persistExactMergeReceipt,
  verifyMergedCommit,
} from "./deliveryMerge.ts";
import { err, ok } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import { createGithubApi, type GithubLifecycleApi } from "./githubApi.ts";
import { loadGithubToken } from "./githubAuth.ts";
import { reconcileMergedTaskFromRefresh, reconcileObservedMergedTask, type MergeReconcileResult } from "./mergeReconcile.ts";
import { parseGithubRemote, readGithubRemoteUrl } from "./prOpen.ts";
import { assertTaskBranch } from "./commit.ts";
import { getExplicitDeliveryTarget } from "./taskDeliveryTarget.ts";
import { readTaskPrReceipt, recordTaskPrMerged } from "./taskPrReceipt.ts";
import { getTask, type TaskRow } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";
import type { Layout } from "./layout.ts";

interface Envelope {
  ok?: unknown;
  data?: Record<string, unknown>;
  hint?: unknown;
}

type ApiFactory = (token: string) => GithubLifecycleApi;
type RemoteReader = (worktreePath: string, token: string) => string;
type CanonicalRefresher = (layout: Layout, repoId: string, expectedBranch?: string) => CanonicalRefreshResult;

export interface PrMergeD2Options {
  apiFactory?: ApiFactory;
  readRemoteUrl?: RemoteReader;
  canonicalRefresher?: CanonicalRefresher;
}

const SHA_RE = /^[0-9a-f]{40}$/u;

function exactSha(value: unknown): string | null {
  return typeof value === "string" && SHA_RE.test(value) ? value : null;
}

function asCanonicalRefresh(value: unknown): CanonicalRefreshResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<CanonicalRefreshResult>;
  if (
    (row.action !== "none" && row.action !== "fast-forward") ||
    typeof row.branch !== "string" ||
    typeof row.before !== "string" ||
    typeof row.after !== "string" ||
    !(row.remoteHead === null || typeof row.remoteHead === "string")
  ) return null;
  return row as CanonicalRefreshResult;
}

function safeReconcileError(deps: ToolDeps, result: MergeReconcileResult): string {
  return redact(result.error ?? "local reconciliation failed", [
    deps.layout.workspaceRoot,
    deps.layout.controlRoot,
  ]);
}

function reconciliationEnvelope(
  taskId: string,
  data: Record<string, unknown>,
  result: MergeReconcileResult,
  observedAfterWriteFailure: boolean,
) {
  const mergedData = {
    ...data,
    merged: true,
    localState: result.localState,
    cleanedUp: result.cleanedUp,
    ...(result.canonicalRefresh ? { canonicalRefresh: result.canonicalRefresh } : {}),
    ...(observedAfterWriteFailure ? { observedAfterWriteFailure: true } : {}),
  };
  const hint = result.localState === "merged-but-local-stale"
    ? "remote PR 已确认 merged，但本地 canonical/worktree 对账未完成；再次调用 grande_pr_merge 只会观察并重试本地 reconciliation，不会重复 merge。"
    : result.localState === "deploy-pending"
      ? "remote PR 已确认 merged；canonical 已刷新。检测到 .grande/deploy.yaml，保留 task worktree 进入既有 deploy → verify → DONE 闭环。"
      : "remote PR 已确认 merged；canonical 已刷新，task worktree/branch 已清理并关闭。";
  return { structuredContent: ok({ taskId, data: mergedData, hint }) };
}

function recordReconcileAudit(
  deps: ToolDeps,
  taskId: string,
  input: Record<string, unknown>,
  result: MergeReconcileResult,
  touchedPath: string,
): void {
  const audit = beginAudit(deps.db, { taskId, tool: "grande_pr_merge", input: { ...input, phase: "post_merge_reconcile" } });
  audit.allowed();
  if (!audit.executing()) return;
  if (result.localState === "merged-but-local-stale") {
    audit.failed(`merged-but-local-stale: ${safeReconcileError(deps, result)}`);
  } else {
    audit.succeeded([touchedPath]);
  }
}

async function observeRemoteMerged(
  deps: ToolDeps,
  taskId: string,
  options: PrMergeD2Options,
): Promise<{
  task: NonNullable<ReturnType<typeof getTask>>;
  pr: Awaited<ReturnType<GithubLifecycleApi["getPullRequest"]>>;
} | null> {
  const task = getTask(deps.db, taskId);
  if (!task || task.state === "CLOSED") return null;
  let head: string;
  try {
    head = assertTaskBranch(task.worktreePath, task.branch);
  } catch {
    return null;
  }

  try {
    const token = loadGithubToken(deps.layout).token;
    const readRemote = options.readRemoteUrl ?? readGithubRemoteUrl;
    const { owner, repo } = parseGithubRemote(readRemote(task.worktreePath, token));
    const api = (options.apiFactory ?? createGithubApi)(token);
    const found = await api.findPullRequest(owner, repo, task.branch, "all");
    if (!found) return null;
    const pr = await api.getPullRequest(owner, repo, found.number);
    if (
      pr.merged !== true ||
      pr.headRef !== task.branch ||
      pr.headSha !== head
    ) return null;
    return { task, pr };
  } catch {
    return null;
  }
}

function recordMergeFromExistingReceipt(
  deps: ToolDeps,
  taskId: string,
  taskHead: string | null,
  mergeSha: string | null,
  prNumber: unknown,
  baseRef: string,
): boolean {
  if (!taskHead || !mergeSha) return false;
  const receipt = readTaskPrReceipt(deps.db, taskId);
  if (!receipt) return false;
  if (receipt.prNumber !== prNumber || (receipt.baseRef !== null && receipt.baseRef !== baseRef)) {
    throw new StateError("STALE_STATE", "merge response 的 PR number/base 与 durable receipt 不一致，拒绝绑定。");
  }
  if (receipt.baseRef === null || receipt.headSha !== taskHead) return false;
  recordTaskPrMerged(deps.db, {
    taskId,
    prNumber: receipt.prNumber,
    prUrl: receipt.prUrl,
    headSha: receipt.headSha,
    baseRef: receipt.baseRef,
    baseSha: receipt.baseSha,
    mergeSha,
  });
  return true;
}

function recordMergeFromObserved(
  deps: ToolDeps,
  observed: NonNullable<Awaited<ReturnType<typeof observeRemoteMerged>>>,
  expectedMergeSha: string | null = null,
): string | null {
  const observedMergeSha = exactSha(observed.pr.mergeCommitSha);
  if (!observedMergeSha) return null;
  if (expectedMergeSha !== null && expectedMergeSha !== observedMergeSha) {
    throw new StateError(
      "STALE_STATE",
      `merge response SHA ${expectedMergeSha} 与 GitHub PR merge_commit_sha ${observedMergeSha} 不一致。`,
    );
  }
  recordTaskPrMerged(deps.db, {
    taskId: observed.task.taskId,
    prNumber: observed.pr.number,
    prUrl: observed.pr.url,
    headSha: observed.pr.headSha,
    baseRef: observed.pr.baseRef,
    baseSha: observed.pr.baseSha ?? null,
    mergeSha: observedMergeSha,
  });
  return observedMergeSha;
}

/**
 * Minimal V2 Task 5：丢失响应后的 reconcile 路径同样要过 exact 证据检查
 * （规格 §10.2/§14.3）——reconcile 出的 merge commit 必须验证 parents/tree 并钉住
 * pinned release source。返回 null 表示无需检查或检查通过；返回 StateError 表示证据
 * 不符——此时 authorization 已被置为 UNCERTAIN（终态），绝不能继续 deploy。
 */
function reconcileAuthorizedDeployEvidence(
  deps: ToolDeps,
  task: TaskRow,
  result: MergeReconcileResult,
  mergeSha: string | null,
): StateError | null {
  if (getExplicitDeliveryTarget(deps.db, task.taskId) !== "deploy") return null;
  // 本地对账没收尾时只重试 reconcile，不定罪——remote merged 本身已经确认。
  if (result.localState === "merged-but-local-stale") return null;
  const active = activeAuthorizationForTask(deps.db, task.taskId);
  if (!active || active.kind !== "delivery" || active.status !== "EXECUTING") return null;
  const binding = active.binding as DeliveryAuthorizationBinding;
  try {
    if (!mergeSha || !SHA_RE.test(mergeSha)) {
      throw new StateError("STALE_STATE", "reconcile 未给出精确 merge SHA，无法确认交付证据。");
    }
    const verified = verifyMergedCommit({
      repoPath: canonicalRepoPath(deps.layout, task.repoId),
      authorizationId: active.authorizationId,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
      mergeSha,
      expectedMergeTree: binding.expectedMergeTree,
    });
    const pinned = ensurePinnedReleaseSource({
      layout: deps.layout,
      repoId: task.repoId,
      authorizationId: active.authorizationId,
      mergeSha,
      expectedTree: binding.expectedMergeTree,
    });
    // 幂等：同一 authorizationId 的相同 receipt 重复写入是 no-op（响应丢失重放）。
    persistExactMergeReceipt(deps.layout, { ...verified, releaseSourceRealpath: pinned.realpath });
    return null;
  } catch (error) {
    const normalized = error instanceof StateError
      ? error
      : new StateError("STALE_STATE", error instanceof Error ? error.message : String(error));
    try {
      markMergeAuthorizationUncertain(deps.db, active, normalized.message);
    } catch {
      // 状态可能已被并发请求推进；不影响本次拒绝。
    }
    return normalized;
  }
}

/**
 * D2 wrapper around the existing C3 merge gate. It never issues a merge itself.
 * The base tool owns all CI/attestation/receipt/expected-SHA gates and the single
 * remote merge attempt. This layer only observes ambiguous outcomes and reconciles
 * confirmed remote merges locally. Task-level durable merge evidence is persisted
 * here before any automatic cleanup is allowed.
 */
export function wrapPrMergeToolD2(
  deps: ToolDeps,
  base: ToolDef,
  options: PrMergeD2Options = {},
): ToolDef {
  const canonicalRefresher = options.canonicalRefresher ?? refreshCanonical;
  return {
    ...base,
    handler: async (args) => {
      const taskId = args.taskId as string;
      const response = await base.handler(args);
      const envelope = response.structuredContent as Envelope;

      if (envelope.ok === true && envelope.data?.merged === true) {
        const task = getTask(deps.db, taskId);
        if (!task || task.state === "CLOSED") return response;
        const canonicalRefresh = asCanonicalRefresh(envelope.data.canonicalRefresh);
        if (!canonicalRefresh) return response;
        const expectedTaskHead = exactSha(envelope.data.headSha);
        let expectedMergeSha = exactSha(envelope.data.mergeSha);

        let durableRecorded = false;
        try {
          durableRecorded = recordMergeFromExistingReceipt(
            deps, taskId, expectedTaskHead, expectedMergeSha, envelope.data.prNumber, canonicalRefresh.branch,
          );
          if (!durableRecorded) {
            const observed = await observeRemoteMerged(deps, taskId, options);
            if (observed) {
              const observedMergeSha = recordMergeFromObserved(deps, observed, expectedMergeSha);
              if (observedMergeSha) {
                expectedMergeSha = observedMergeSha;
                durableRecorded = true;
              }
            }
          }
        } catch (error) {
          const result: MergeReconcileResult = {
            localState: "merged-but-local-stale",
            cleanedUp: false,
            canonicalRefresh,
            error: error instanceof Error ? error.message : String(error),
          };
          recordReconcileAudit(
            deps,
            taskId,
            { remoteMerged: true, durableReceipt: false, prNumber: envelope.data.prNumber ?? null },
            result,
            task.worktreePath,
          );
          return reconciliationEnvelope(taskId, envelope.data, result, false);
        }

        const result = reconcileMergedTaskFromRefresh(
          deps,
          task,
          canonicalRefresh,
          durableRecorded ? expectedMergeSha : null,
          expectedTaskHead,
        );
        recordReconcileAudit(
          deps,
          taskId,
          {
            remoteMerged: true,
            observedAfterWriteFailure: false,
            durableReceipt: durableRecorded,
            prNumber: envelope.data.prNumber ?? null,
          },
          result,
          task.worktreePath,
        );
        return reconciliationEnvelope(
          taskId,
          {
            ...envelope.data,
            ...(expectedMergeSha ? { mergeSha: expectedMergeSha } : {}),
          },
          result,
          false,
        );
      }

      if (envelope.ok !== false) return response;
      // Reconciliation may recover an already-started authorized execution, but must
      // never turn an authorization rejection into an alternate path to GitHub.
      if (getExplicitDeliveryTarget(deps.db, taskId) === "deploy") {
        const active = activeAuthorizationForTask(deps.db, taskId);
        if (!active || active.kind !== "delivery" || active.status !== "EXECUTING") return response;
      }

      // A write response may have been lost after GitHub accepted the merge, or a PR may
      // have been merged externally. Query by the trusted task branch and exact local head.
      const observed = await observeRemoteMerged(deps, taskId, options);
      if (!observed) return response;
      let mergeSha: string | null = null;
      try {
        mergeSha = recordMergeFromObserved(deps, observed);
      } catch (error) {
        const toolError = toToolError(error);
        toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
        return { structuredContent: err({ ...toolError, taskId }) };
      }
      const result = reconcileObservedMergedTask(
        deps,
        observed.task,
        observed.pr.baseRef,
        mergeSha,
        observed.pr.headSha,
        canonicalRefresher,
      );
      // Keep the observed merge identity; canonical may already contain later commits.
      const evidenceError = reconcileAuthorizedDeployEvidence(deps, observed.task, result, mergeSha);
      if (evidenceError) {
        const toolError = toToolError(evidenceError);
        toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
        return { structuredContent: err({ ...toolError, taskId }) };
      }
      recordReconcileAudit(
        deps,
        taskId,
        {
          remoteMerged: true,
          observedAfterWriteFailure: true,
          durableReceipt: mergeSha !== null,
          prNumber: observed.pr.number,
          expectedHeadSha: observed.pr.headSha,
        },
        result,
        observed.task.worktreePath,
      );
      return reconciliationEnvelope(taskId, {
        merged: true,
        existing: true,
        prNumber: observed.pr.number,
        headSha: observed.pr.headSha,
        ...(mergeSha ? { mergeSha } : {}),
      }, result, true);
    },
  };
}

export function addPrMergeD2Reconciliation(
  deps: ToolDeps,
  tools: ToolDef[],
  options: PrMergeD2Options = {},
): ToolDef[] {
  return tools.map((tool) => tool.name === "grande_pr_merge" ? wrapPrMergeToolD2(deps, tool, options) : tool);
}
