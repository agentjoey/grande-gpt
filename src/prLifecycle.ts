import { execFileSync } from "node:child_process";
import { getAttestations } from "./attestation.ts";
import { beginAudit, type AuditHandle } from "./audit.ts";
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
import { parseGithubRemote, readGithubRemoteUrl } from "./prOpen.ts";
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

  // GitHub statuses 按最新在前返回；同一个 context 只看第一条，旧失败不能覆盖新成功。
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

export interface PrLifecycleOptions {
  apiFactory?: ApiFactory;
  readRemoteUrl?: RemoteReader;
  readLocalHead?: HeadReader;
}

function readHead(worktreePath: string): string {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    throw new StateError("INVALID_INPUT", `读取任务 HEAD 失败：${e.stderr ? String(e.stderr).trim() : e.message}`);
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

async function inspectLifecycle(
  deps: ToolDeps,
  taskId: string,
  options: PrLifecycleOptions,
): Promise<LifecycleState> {
  const task = getTask(deps.db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);

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

export function createPrMergeTool(deps: ToolDeps, options: PrLifecycleOptions = {}): ToolDef {
  return {
    name: "grande_pr_merge",
    description:
      "合并【当前 task.branch 自己的 PR】。每次调用重新读取 PR/CI，要求本地 HEAD=PR head、当前 SHA 有 attestation、" +
      "CI 不是 pending/failed、PR 可合并；merge 请求携带 expected head SHA。CI=none 时允许轻量项目在 attestation 门禁下继续。",
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
        const state = await inspectLifecycle(deps, taskId, options);

        if (state.pr.merged) {
          return {
            structuredContent: ok({
              taskId,
              data: {
                merged: true,
                existing: true,
                prNumber: state.pr.number,
                headSha: state.pr.headSha,
                ciState: state.ci.state,
              },
              hint: `PR #${state.pr.number} 此前已合并（幂等）。`,
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

        audit = beginAudit(deps.db, {
          taskId,
          tool: "grande_pr_merge",
          input: { taskId, prNumber: state.pr.number, expectedHeadSha: state.pr.headSha, ciState: state.ci.state },
        });
        audit.allowed();
        if (!audit.executing()) {
          throw new StateError("STALE_STATE", `任务 ${taskId} 的 merge 审计句柄无法推进到 EXECUTING。`);
        }

        const merged = await state.api.mergePullRequest(
          state.owner,
          state.repo,
          state.pr.number,
          state.pr.headSha,
        );
        if (!merged.merged) {
          throw new StateError("INVALID_INPUT", `GitHub 未合并 PR #${state.pr.number}：${merged.message}`);
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
            },
            hint: `PR #${state.pr.number} 已合并（head ${state.pr.headSha}，CI=${state.ci.state}）。`,
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
