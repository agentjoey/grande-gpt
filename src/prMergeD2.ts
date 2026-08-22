import { beginAudit } from "./audit.ts";
import { refreshCanonical, type CanonicalRefreshResult } from "./canonicalRefresh.ts";
import { ok } from "./envelope.ts";
import { redact } from "./errors.ts";
import { createGithubApi, type GithubLifecycleApi } from "./githubApi.ts";
import { loadGithubToken } from "./githubAuth.ts";
import { reconcileMergedTaskFromRefresh, reconcileObservedMergedTask, type MergeReconcileResult } from "./mergeReconcile.ts";
import { parseGithubRemote, readGithubRemoteUrl } from "./prOpen.ts";
import { assertTaskBranch } from "./commit.ts";
import { getTask } from "./tasks.ts";
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

/**
 * D2 wrapper around the existing C3 merge gate. It never issues a merge itself.
 * The base tool owns all CI/attestation/receipt/expected-SHA gates and the single
 * remote merge attempt. This layer only observes ambiguous outcomes and reconciles
 * confirmed remote merges locally.
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
        const expectedMergeSha = typeof envelope.data.mergeSha === "string" ? envelope.data.mergeSha : null;
        const expectedTaskHead = typeof envelope.data.headSha === "string" ? envelope.data.headSha : null;
        const result = reconcileMergedTaskFromRefresh(
          deps,
          task,
          canonicalRefresh,
          expectedMergeSha,
          expectedTaskHead,
        );
        recordReconcileAudit(
          deps,
          taskId,
          { remoteMerged: true, observedAfterWriteFailure: false, prNumber: envelope.data.prNumber ?? null },
          result,
          task.worktreePath,
        );
        return reconciliationEnvelope(taskId, envelope.data, result, false);
      }

      if (envelope.ok !== false) return response;

      // A write response may have been lost after GitHub accepted the merge. Query
      // by the trusted task branch and exact local head before any future retry.
      const observed = await observeRemoteMerged(deps, taskId, options);
      if (!observed) return response;
      const result = reconcileObservedMergedTask(
        deps,
        observed.task,
        observed.pr.baseRef,
        null,
        observed.pr.headSha,
        canonicalRefresher,
      );
      const mergeSha = result.canonicalRefresh?.after ?? null;
      recordReconcileAudit(
        deps,
        taskId,
        {
          remoteMerged: true,
          observedAfterWriteFailure: true,
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
