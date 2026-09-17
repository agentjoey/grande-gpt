import { getAttestations } from "./attestation.ts";
import { assertTaskBranch } from "./commit.ts";
import { beginAudit, type AuditHandle } from "./audit.ts";
import { refreshCanonical, type CanonicalRefreshResult } from "./canonicalRefresh.ts";
import {
  activeAuthorizationForTask,
  beginAuthorizedExecution,
  type AuthorizationStages,
  type DeliveryAuthorizationBinding,
} from "./deliveryAuthorization.ts";
import {
  canonicalRepoPath,
  ensurePinnedReleaseSource,
  markMergeAuthorizationUncertain,
  persistExactMergeReceipt,
  verifyMergedCommit,
  type ExactMergeReceipt,
} from "./deliveryMerge.ts";
import { revalidateDeliveryBinding, type DeliveryReadinessDeps } from "./deliveryReadiness.ts";
import { err, ok } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import {
  createGithubApi,
  GithubApiError,
  type GithubCheckRun,
  type GithubCommitStatus,
  type GithubLifecycleApi,
} from "./githubApi.ts";
import { GithubAuthError, loadGithubToken, redactToken } from "./githubAuth.ts";
import { GitExecError, safeGit } from "./gitExec.ts";
import { isHostVerificationApplicable } from "./hostVerificationApplicability.ts";
import type { HostVerifierCoordinator } from "./hostVerifier.ts";
import type { Layout } from "./layout.ts";
import { inspectCurrentHostVerification, manualOuterTestCommand } from "./prHostVerification.ts";
import { parseGithubRemote, readGithubRemoteUrl } from "./prOpen.ts";
import { getExplicitDeliveryTarget } from "./taskDeliveryTarget.ts";
import { readTaskPrReceipt } from "./taskPrReceipt.ts";
import { getTask, type TaskRow } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

export type CiState = "none" | "pending" | "passed" | "failed";

export interface CiFailure {
  name: string;
  conclusion: string;
  detailsUrl: string | null;
  logExcerpt: string | null;
}

export interface CiSummary {
  state: CiState;
  checks: Array<{ name: string; state: string; detailsUrl: string | null }>;
  failed: CiFailure[];
}

const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function excerpt(parts: Array<string | null | undefined>): string | null {
  const value = parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n")
    .trim();
  return value ? value.slice(0, 8000) : null;
}

/**
 * 将 GitHub Checks + legacy commit statuses 收敛成模型只需要的四态。
 * 不保存历史、不做 CI 数据库；每次 pr_status/pr_merge 都重新读当前 head SHA。
 */
export function summarizeCi(checkRuns: GithubCheckRun[], statuses: GithubCommitStatus[]): CiSummary {
  const checks: CiSummary["checks"] = [];
  const failed: CiFailure[] = [];
  let hasPending = false;
  let hasPassing = false;
  let hasFailed = false;

  for (const run of checkRuns) {
    if (run.status !== "completed") {
      hasPending = true;
      checks.push({ name: run.name, state: run.status, detailsUrl: run.detailsUrl });
      continue;
    }
    const conclusion = run.conclusion ?? "unknown";
    checks.push({ name: run.name, state: conclusion, detailsUrl: run.detailsUrl });
    if (PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
      hasPassing = true;
      continue;
    }
    hasFailed = true;
    failed.push({
      name: run.name,
      conclusion,
      detailsUrl: run.detailsUrl,
      logExcerpt: excerpt([run.output?.title, run.output?.summary, run.output?.text]),
    });
  }

  const seenContexts = new Set<string>();
  for (const status of statuses) {
    if (seenContexts.has(status.context)) continue;
    seenContexts.add(status.context);
    checks.push({ name: status.context, state: status.state, detailsUrl: status.targetUrl });
    if (status.state === "success") {
      hasPassing = true;
    } else if (status.state === "pending") {
      hasPending = true;
    } else {
      hasFailed = true;
      failed.push({
        name: status.context,
        conclusion: status.state,
        detailsUrl: status.targetUrl,
        logExcerpt: excerpt([status.description]),
      });
    }
  }

  const state: CiState = hasFailed
    ? "failed"
    : hasPending ? "pending" : hasPassing ? "passed" : "none";
  return { state, checks, failed };
}

type ApiFactory = (token: string) => GithubLifecycleApi;
type RemoteReader = (worktreePath: string, token: string) => string;
type HeadReader = (worktreePath: string) => string;
type CanonicalRefresher = (layout: Layout, repoId: string, expectedBranch?: string) => CanonicalRefreshResult;

export interface PrLifecycleOptions {
  apiFactory?: ApiFactory;
  readRemoteUrl?: RemoteReader;
  readLocalHead?: HeadReader;
  canonicalRefresher?: CanonicalRefresher;
  /** Trusted control-plane mode. Production remains manual until explicit Owner activation. */
  hostVerificationMode?: "manual" | "auto";
  /** Internal restricted verifier coordinator. It exposes no argv/cwd/env inputs. */
  hostVerifierCoordinator?: HostVerifierCoordinator;
  /**
   * Minimal V2 Task 5：explicit deploy 任务的可信 readiness reader 集（Task 3）。
   * 缺失时 deploy 任务的 merge fail closed——没有可信 reader 就无法复核 binding。
   */
  deliveryReadinessDeps?: DeliveryReadinessDeps;
}

/** deploy 任务的 merge stage 授权上下文（CAS 前的复核结果）。 */
interface AuthorizedMerge {
  authorizationId: string;
  bindingDigest: string;
  taskId: string;
  binding: DeliveryAuthorizationBinding;
  stages: AuthorizationStages;
}

/**
 * 规格 §10.1：任何外部 mutation 之前找到唯一 APPROVED authorization 并复核 binding。
 * 本函数在【任何 GitHub API 调用之前】运行——没有 APPROVED authorization、binding
 * 漂移或过期都直接抛错，零 GitHub 调用、零执行。
 */
async function reauthorizeForMerge(
  deps: ToolDeps,
  taskId: string,
  options: PrLifecycleOptions,
): Promise<AuthorizedMerge> {
  const readinessDeps = options.deliveryReadinessDeps;
  if (!readinessDeps) {
    throw new StateError(
      "POLICY_DENIED",
      `任务 ${taskId} 是 explicit deploy 任务，但 Gateway 未接入可信 readiness reader；fail closed，拒绝 merge。`,
    );
  }
  const active = activeAuthorizationForTask(deps.db, taskId);
  if (!active || active.kind !== "delivery" || active.status !== "APPROVED") {
    throw new StateError(
      "STALE_STATE",
      `任务 ${taskId} 没有 APPROVED 状态的 delivery authorization；` +
        "deploy 任务的 merge 必须由 Console 审批启动，禁止任何 GitHub 调用。",
    );
  }
  // 复核 durable binding：任何字段漂移都会在这里 CAS 置 STALE 并抛错（Task 3）。
  const binding = await revalidateDeliveryBinding(deps.db, active.authorizationId, readinessDeps);
  return {
    authorizationId: active.authorizationId,
    bindingDigest: active.bindingDigest,
    taskId,
    binding,
    stages: active.stages,
  };
}

function readHead(worktreePath: string): string {
  try {
    return safeGit.local(worktreePath, ["rev-parse", "HEAD"]).trim();
  } catch (error) {
    const detail = error instanceof GitExecError
      ? error.message.replace(/^git failed:\s*/u, "")
      : error instanceof Error ? error.message : String(error);
    throw new StateError("INVALID_INPUT", `读取任务 HEAD 失败：${detail}`);
  }
}

function normalizedError(error: unknown, token?: string): StateError {
  const message = token
    ? redactToken(error instanceof Error ? error.message : String(error), token)
    : error instanceof Error ? error.message : String(error);
  if (error instanceof StateError) return new StateError(error.code, message);
  if (error instanceof GithubAuthError || error instanceof GithubApiError) {
    return new StateError("INVALID_INPUT", message);
  }
  return new StateError("INVALID_INPUT", message);
}

function failedEnvelope(deps: ToolDeps, taskId: string, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId }) };
}

interface LifecycleState {
  task: TaskRow;
  api: GithubLifecycleApi;
  owner: string;
  repo: string;
  pr: Awaited<ReturnType<GithubLifecycleApi["getPullRequest"]>>;
  localHead: string;
  headMatchesTask: boolean;
  ci: CiSummary;
  attested: boolean;
}

function assertDurablePrIdentity(deps: ToolDeps, state: LifecycleState): void {
  const receipt = readTaskPrReceipt(deps.db, state.task.taskId);
  if (!receipt) return;
  if (
    receipt.prNumber !== state.pr.number ||
    receipt.prUrl !== state.pr.url ||
    state.pr.headRef !== state.task.branch ||
    receipt.baseRef === null ||
    receipt.baseRef !== state.pr.baseRef
  ) {
    throw new StateError(
      "STALE_STATE",
      `任务 ${state.task.taskId} 的当前 PR number/url/head branch/base 与 durable task_pr_receipt identity 不一致；拒绝 merge mutation。`,
    );
  }
}

async function inspectLifecycle(
  deps: ToolDeps,
  taskId: string,
  options: PrLifecycleOptions,
): Promise<LifecycleState> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  assertTaskBranch(task.worktreePath, task.branch);

  let token: string;
  try {
    token = loadGithubToken(deps.layout).token;
  } catch (error) {
    throw normalizedError(error);
  }

  try {
    const readRemoteUrl = options.readRemoteUrl ?? readGithubRemoteUrl;
    const localHead = (options.readLocalHead ?? readHead)(task.worktreePath);
    const { owner, repo } = parseGithubRemote(readRemoteUrl(task.worktreePath, token));
    const api = (options.apiFactory ?? createGithubApi)(token);
    const found = await api.findPullRequest(owner, repo, task.branch, "all");
    if (!found) {
      throw new StateError(
        "INVALID_INPUT",
        `任务 ${taskId} 的分支 ${task.branch} 没有对应 GitHub PR；请先 grande_push + grande_pr_open。`,
      );
    }
    const pr = await api.getPullRequest(owner, repo, found.number);
    const [checkRuns, statuses] = await Promise.all([
      api.listCheckRuns(owner, repo, pr.headSha),
      api.listCommitStatuses(owner, repo, pr.headSha),
    ]);
    const ci = summarizeCi(checkRuns, statuses);
    const headMatchesTask = pr.headRef === task.branch && pr.headSha === localHead;
    const attested = getAttestations(deps.db, taskId).some((candidate) => candidate.commit === pr.headSha);
    return { task, api, owner, repo, pr, localHead, headMatchesTask, ci, attested };
  } catch (error) {
    throw normalizedError(error, token);
  }
}

export function createPrStatusTool(deps: ToolDeps, options: PrLifecycleOptions = {}): ToolDef {
  return {
    name: "grande_pr_status",
    description:
      "读取任务分支对应 PR 的当前 head、mergeability、CI checks/statuses 与失败诊断。" +
      "结果始终按当前 PR head SHA 现查，不缓存。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务ID；PR 从 task.branch 单向推导" } },
      required: ["taskId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    handler: async (args) => {
      const taskId = args.taskId as string;
      try {
        const state = await inspectLifecycle(deps, taskId, options);
        return {
          structuredContent: ok({
            taskId,
            data: {
              pr: state.pr,
              localHead: state.localHead,
              headMatchesTask: state.headMatchesTask,
              ci: state.ci,
              attested: state.attested,
            },
            hint: state.pr.merged
              ? `PR #${state.pr.number} 已合并。`
              : !state.headMatchesTask
                ? `PR #${state.pr.number} 的 head 与当前任务 HEAD/branch 不一致；先同步或 push，不能据旧 CI 合并。`
                : `PR #${state.pr.number} CI=${state.ci.state}${state.attested ? "，当前 SHA 有本机 attestation" : "，当前 SHA 无本机 attestation"}。`,
          }),
        };
      } catch (error) {
        return failedEnvelope(deps, taskId, error);
      }
    },
  };
}

function hostVerificationPending(
  taskId: string,
  prNumber: number,
  headSha: string,
  level: "smoke" | "full",
  state: "manual_required" | "human_gate" | "running" | "failed",
  extra: Record<string, unknown>,
  hint: string,
) {
  return {
    structuredContent: ok({
      taskId,
      data: {
        merged: false,
        prNumber,
        headSha,
        verification: { state, level, ...extra },
      },
      hint,
    }),
  };
}

export function createPrMergeTool(deps: ToolDeps, options: PrLifecycleOptions = {}): ToolDef {
  return {
    name: "grande_pr_merge",
    description:
      "合并【当前 task.branch 自己的 PR】。每次调用重新读取 PR/CI，要求本地 HEAD=PR head、当前 SHA 有 attestation、" +
      "CI 不是 pending/failed、PR 可合并；grande-gpt 自举 PR 还要求当前 plan 的 exact-SHA host verification receipt；" +
      "缺 receipt 时仅返回 verification 状态/受限 verifier job，不会在后台自动 merge。" +
      "merge 前后安全 refresh local canonical（fixed origin/current base，clean + ff-only）。" +
      "CI=none 时允许轻量项目在 attestation 门禁下继续。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务ID；不接受 repo/prNumber/branch 参数" } },
      required: ["taskId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      const taskId = args.taskId as string;
      let audit: AuditHandle | undefined;
      try {
        // Minimal V2 Task 5：explicit deploy 任务先复核 authorization（规格 §10.1），
        // 这一步发生在【任何 GitHub API 调用之前】——没有 APPROVED authorization、
        // binding 漂移或过期都直接抛错，零 GitHub 调用、零执行。
        const authorized = getExplicitDeliveryTarget(deps.db, taskId) === "deploy"
          ? await reauthorizeForMerge(deps, taskId, options)
          : null;
        const state = await inspectLifecycle(deps, taskId, options);
        const canonicalRefresher = options.canonicalRefresher ?? refreshCanonical;

        if (authorized) {
          // merge stage 还必须再次确认 current PR head、base SHA 与 binding 一致（§10.1）。
          const b = authorized.binding;
          if (
            b.prNumber !== state.pr.number ||
            b.headSha !== state.pr.headSha ||
            b.baseRef !== state.pr.baseRef ||
            b.baseSha !== state.pr.baseSha ||
            b.repoId !== state.task.repoId ||
            b.headSha !== state.localHead
          ) {
            throw new StateError(
              "STALE_STATE",
              `任务 ${taskId} 的 authorization binding 与当前 PR/本地证据不一致；本次请求零执行。`,
            );
          }
        }

        assertDurablePrIdentity(deps, state);

        if (state.pr.merged) {
          if (authorized) {
            throw new StateError(
              "STALE_STATE",
              `PR #${state.pr.number} 已在授权执行链之外被合并；fail closed，需 Human 检查后再开新授权。`,
            );
          }
          audit = beginAudit(deps.db, {
            taskId,
            tool: "grande_pr_merge",
            input: { taskId, prNumber: state.pr.number, existing: true, canonicalRefresh: true },
          });
          audit.allowed();
          if (!audit.executing()) {
            throw new StateError("STALE_STATE", `任务 ${taskId} 的 canonical refresh 审计句柄无法推进到 EXECUTING。`);
          }
          const canonicalRefresh = canonicalRefresher(deps.layout, state.task.repoId, state.pr.baseRef);
          audit.succeeded([state.task.worktreePath]);
          return {
            structuredContent: ok({
              taskId,
              data: {
                merged: true,
                existing: true,
                prNumber: state.pr.number,
                headSha: state.pr.headSha,
                ciState: state.ci.state,
                canonicalRefresh,
              },
              hint: `PR #${state.pr.number} 此前已合并；local canonical 已重新验证/刷新到 origin/${state.pr.baseRef}。`,
            }),
          };
        }
        if (state.pr.state !== "open") {
          throw new StateError("INVALID_INPUT", `PR #${state.pr.number} 当前 state=${state.pr.state}，不能合并。`);
        }
        if (state.pr.headRef !== state.task.branch) {
          throw new StateError(
            "POLICY_DENIED",
            `拒绝合并 PR #${state.pr.number}：head ${state.pr.headRef} 不是任务分支 ${state.task.branch}。`,
          );
        }
        if (state.pr.headSha !== state.localHead) {
          throw new StateError(
            "STALE_STATE",
            `拒绝合并：PR head=${state.pr.headSha}，任务本地 HEAD=${state.localHead}。` +
              `请先 push/重新读取状态；旧 SHA 的 CI 不能替新 SHA 背书。`,
          );
        }
        if (state.pr.draft) {
          throw new StateError("INVALID_INPUT", `PR #${state.pr.number} 仍是 Draft，不能自动合并。`);
        }
        if (state.pr.mergeable === null) {
          throw new StateError("STALE_STATE", `GitHub 仍在计算 PR #${state.pr.number} 的 mergeability，请稍后重试。`);
        }
        if (!state.pr.mergeable) {
          throw new StateError("MERGE_CONFLICT", `PR #${state.pr.number} 当前不可自动合并。`);
        }
        if (!state.attested) {
          throw new StateError(
            "POLICY_DENIED",
            `PR #${state.pr.number} 当前 head ${state.pr.headSha} 没有本机 attestation；` +
              `请先对当前代码运行验证并 grande_commit，旧 SHA 的验证不能复用。`,
          );
        }
        if (state.ci.state === "failed") {
          throw new StateError(
            "INVALID_INPUT",
            `PR #${state.pr.number} CI failed；先根据 grande_pr_status 的 failed diagnostics 修复并重新 push。`,
          );
        }
        if (state.ci.state === "pending") {
          throw new StateError("STALE_STATE", `PR #${state.pr.number} CI 仍在 pending，不能合并。`);
        }

        if (isHostVerificationApplicable(state.task.repoId)) {
          const current = inspectCurrentHostVerification(deps.db, state.task, state.pr.headSha);
          if (!current.receiptEligible && current.plan.level !== "none") {
            const level = current.plan.level;
            const command = manualOuterTestCommand(taskId);
            if (current.plan.manualOnlyRequired) {
              return hostVerificationPending(
                taskId,
                state.pr.number,
                state.pr.headSha,
                level,
                "human_gate",
                {
                  manualOnlyRequired: true,
                  manualOnlyFiles: current.plan.manualOnlyFiles,
                  nextAction: command,
                },
                `当前 ${level} host plan 包含 manual-only 宿主边界；必须由 Human Owner 执行：${command}`,
              );
            }

            const mode = options.hostVerificationMode ?? "manual";
            if (mode !== "auto") {
              return hostVerificationPending(
                taskId,
                state.pr.number,
                state.pr.headSha,
                level,
                "manual_required",
                { manualOnlyRequired: false, nextAction: command },
                `hostVerification.mode=manual；请执行：${command}`,
              );
            }

            const attempt = current.latestAttempt;
            if (attempt?.kind === "running") {
              return hostVerificationPending(
                taskId,
                state.pr.number,
                state.pr.headSha,
                level,
                "running",
                { jobId: attempt.jobId, coalesced: true, persisted: true },
                `matching host verifier 仍在运行：${attempt.jobId}。PASS 后不会后台 merge；再次调用 grande_pr_merge 会重新读取 PR/CI/SHA。`,
              );
            }
            if (attempt?.kind === "test") {
              return hostVerificationPending(
                taskId,
                state.pr.number,
                state.pr.headSha,
                level,
                "failed",
                {
                  kind: "test",
                  failureClass: attempt.failureClass ?? "candidate",
                  reason: attempt.reason ?? "test_failed",
                  jobId: attempt.jobId,
                  artifactPath: attempt.artifactPath,
                  artifactExcerpt: attempt.artifactExcerpt,
                  retryable: false,
                },
                `host verifier 代码测试失败（job ${attempt.jobId}）；修复代码并产生新 SHA 后再走 merge gate。`,
              );
            }
            if (current.integrityFailure || attempt?.kind === "integrity") {
              const integrity = current.integrityFailure ?? {
                failureClass: "integrity" as const,
                reason: attempt?.reason ?? "unrecognized_verifier_result",
                jobId: attempt?.jobId ?? null,
              };
              return hostVerificationPending(
                taskId,
                state.pr.number,
                state.pr.headSha,
                level,
                "human_gate",
                {
                  kind: "integrity",
                  failureClass: "integrity",
                  reason: integrity.reason,
                  jobId: integrity.jobId,
                  retryable: false,
                  nextAction: "Human inspection required before any further verification attempt",
                },
                `host verifier integrity failure (${integrity.reason})；已 fail closed 且不自动重试。Human Owner 必须检查 verifier/receipt/SHA/policy identity。`,
              );
            }
            if (attempt?.kind === "infrastructure" && attempt.infrastructureFailures >= 2) {
              return hostVerificationPending(
                taskId,
                state.pr.number,
                state.pr.headSha,
                level,
                "human_gate",
                {
                  kind: "infrastructure",
                  failureClass: attempt.failureClass ?? "infrastructure",
                  reason: attempt.reason ?? "infrastructure_failure",
                  jobId: attempt.jobId,
                  consecutiveFailures: attempt.infrastructureFailures,
                  artifactPath: attempt.artifactPath,
                  artifactExcerpt: attempt.artifactExcerpt,
                  nextAction: command,
                },
                `同一 SHA 已连续 ${attempt.infrastructureFailures} 次 verifier infrastructure failure；停止自动重试。Human Owner 可检查 artifact 后执行：${command}`,
              );
            }

            const coordinator = options.hostVerifierCoordinator;
            if (!coordinator) {
              return hostVerificationPending(
                taskId,
                state.pr.number,
                state.pr.headSha,
                level,
                "human_gate",
                { manualOnlyRequired: false, reason: "verifier_unavailable", nextAction: command },
                `auto verifier 尚未连接到当前 Gateway；请使用受信 manual fallback：${command}`,
              );
            }

            const verificationAudit = beginAudit(deps.db, {
              taskId,
              tool: "grande_pr_merge_host_verification",
              input: {
                taskId,
                prNumber: state.pr.number,
                phase: "host_verification",
                expectedHeadSha: state.pr.headSha,
                level,
                retryOf: attempt?.kind === "infrastructure" ? attempt.jobId : null,
              },
            });
            try {
              verificationAudit.allowed();
              if (!verificationAudit.executing()) {
                throw new StateError("STALE_STATE", `任务 ${taskId} 的 host verification 审计句柄无法推进到 EXECUTING。`);
              }
              const dispatch = coordinator.start({
                taskId,
                repoId: state.task.repoId,
                commit: state.pr.headSha,
                level,
              });
              verificationAudit.succeeded([]);
              return hostVerificationPending(
                taskId,
                state.pr.number,
                state.pr.headSha,
                level,
                "running",
                {
                  jobId: dispatch.jobId,
                  coalesced: dispatch.coalesced,
                  staticPlanDigest: dispatch.staticPlanDigest,
                  retryOf: attempt?.kind === "infrastructure" ? attempt.jobId : null,
                },
                attempt?.kind === "infrastructure"
                  ? `host verifier infrastructure retry 已启动：${dispatch.jobId}（retryOf=${attempt.jobId}）。本 SHA 不会再自动重试第二次。`
                  : `host verifier ${dispatch.coalesced ? "仍在运行" : "已启动"}：${dispatch.jobId}。PASS 后不会后台 merge；再次调用 grande_pr_merge 会重新读取 PR/CI/SHA。`,
              );
            } catch (error) {
              verificationAudit.failed(error instanceof Error ? error.message : String(error));
              throw error;
            }
          }
        }

        audit = beginAudit(deps.db, {
          taskId,
          tool: "grande_pr_merge",
          input: {
            taskId,
            prNumber: state.pr.number,
            expectedHeadSha: state.pr.headSha,
            ciState: state.ci.state,
            ...(authorized
              ? { authorizationId: authorized.authorizationId, bindingDigest: authorized.bindingDigest }
              : {}),
          },
        });
        audit.allowed();
        if (!audit.executing()) {
          throw new StateError("STALE_STATE", `任务 ${taskId} 的 merge 审计句柄无法推进到 EXECUTING。`);
        }

        // 规格 §10.1：APPROVED → EXECUTING 的原子 CAS 必须发生在任何外部 mutation 之前。
        // CAS 失败表示另一个请求已推进状态，本次请求零执行（连 canonical fetch 都不做）。
        if (authorized) {
          beginAuthorizedExecution(
            deps.db,
            authorized.authorizationId,
            "delivery",
            authorized.bindingDigest,
          );
        }

        // 先验证 canonical 当前就是 PR base branch、clean 且可安全追上现有 remote base。
        // 这一步失败时绝不向 GitHub 发 merge 请求，避免 remote 已变而 local 无法接住。
        canonicalRefresher(deps.layout, state.task.repoId, state.pr.baseRef);

        const merged = await state.api.mergePullRequest(
          state.owner,
          state.repo,
          state.pr.number,
          state.pr.headSha,
        );
        if (!merged.merged) {
          throw new StateError("INVALID_INPUT", `GitHub 未合并 PR #${state.pr.number}：${merged.message}`);
        }

        let canonicalRefresh: CanonicalRefreshResult;
        let mergeReceipt: ExactMergeReceipt | undefined;
        try {
          try {
            canonicalRefresh = canonicalRefresher(deps.layout, state.task.repoId, state.pr.baseRef);
          } catch (error) {
            const normalized = normalizedError(error);
            throw new StateError(
              normalized.code,
              `PR #${state.pr.number} 已在 GitHub 成功 merge，但 local canonical refresh 失败：${normalized.message}`,
            );
          }
          if (canonicalRefresh.remoteHead !== null && canonicalRefresh.after !== merged.sha) {
            throw new StateError(
              "CANONICAL_DIVERGED",
              `PR #${state.pr.number} 已 merge 为 ${merged.sha}，但 refresh 后 local canonical=${canonicalRefresh.after}；` +
                `拒绝把 release 标记为 canonical-fresh。`,
            );
          }

          if (authorized) {
            // 规格 §10.2：绝不凭 merged=true 推断 tree 正确。验证 merge commit 的
            // parents（按顺序 base/head）与 tree，然后创建固定在 mergeSha 的 clean
            // pinned release source 并把 durable receipt 落盘。任一检查失败都进入
            // UNCERTAIN（终态），不得继续 deploy。
            const verified = verifyMergedCommit({
              repoPath: canonicalRepoPath(deps.layout, state.task.repoId),
              authorizationId: authorized.authorizationId,
              baseSha: authorized.binding.baseSha,
              headSha: authorized.binding.headSha,
              mergeSha: merged.sha,
              expectedMergeTree: authorized.binding.expectedMergeTree,
            });
            const pinned = ensurePinnedReleaseSource({
              layout: deps.layout,
              repoId: state.task.repoId,
              authorizationId: authorized.authorizationId,
              mergeSha: merged.sha,
              expectedTree: authorized.binding.expectedMergeTree,
            });
            mergeReceipt = { ...verified, releaseSourceRealpath: pinned.realpath };
            persistExactMergeReceipt(deps.layout, mergeReceipt);
          }
        } catch (error) {
          if (authorized) {
            try {
              markMergeAuthorizationUncertain(
                deps.db,
                authorized,
                error instanceof Error ? error.message : String(error),
              );
            } catch {
              // 状态可能已被并发请求推进；原始错误才是调用方需要的信息。
            }
          }
          throw error;
        }

        audit.succeeded([state.task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: {
              merged: true,
              existing: false,
              prNumber: state.pr.number,
              headSha: state.pr.headSha,
              mergeSha: merged.sha,
              ciState: state.ci.state,
              canonicalRefresh,
              ...(mergeReceipt ? { mergeReceipt } : {}),
            },
            hint: `PR #${state.pr.number} 已合并（head ${state.pr.headSha}，CI=${state.ci.state}）；` +
              `local canonical 已验证/刷新到 merge SHA ${merged.sha}。`,
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failedEnvelope(deps, taskId, error);
      }
    },
  };
}

export function addPrLifecycleTools(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  return [...tools, createPrStatusTool(deps), createPrMergeTool(deps)];
}
