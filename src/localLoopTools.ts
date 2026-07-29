import type { AuditHandle } from "./audit.ts";
import { beginAudit } from "./audit.ts";
import {
  captureVerificationContext,
  getAttestations,
  issueAttestation,
  prepareAttestationCandidate,
  recordRunVerificationContext,
  type CandidateResult,
  type VerificationContext,
} from "./attestation.ts";
import { inspectBaseStatus } from "./baseStatus.ts";
import { assertCommitPolicy } from "./commitPolicy.ts";
import { commitWorktree } from "./commit.ts";
import { err, ok, type TaskContext } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import { listJobs } from "./jobs.ts";
import { syncBase } from "./syncBase.ts";
import { getTask } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";
import { listChangedFiles } from "./worktree.ts";

function taskContext(deps: ToolDeps, taskId: string): TaskContext | null {
  const task = getTask(deps.db, taskId);
  if (!task) return null;
  try {
    const jobs = listJobs(deps.db, taskId);
    return {
      branch: task.branch,
      filesChanged: listChangedFiles(task.worktreePath, task.baseCommit).length,
      lastJob: jobs.length > 0 ? `${jobs[0]!.jobId} (${jobs[0]!.state})` : null,
    };
  } catch {
    return null;
  }
}

function failedEnvelope(deps: ToolDeps, taskId: string, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId }) };
}

function captureCandidate(deps: ToolDeps, taskId: string, worktreePath: string): CandidateResult {
  try {
    const current = captureVerificationContext(deps.layout, worktreePath);
    return prepareAttestationCandidate(deps.db, taskId, current.workspaceDigest);
  } catch (error) {
    return {
      issued: false,
      reason: `无法建立本机验证记录：${error instanceof Error ? error.message : String(error)}。提交仍可继续，但不签发 attestation。`,
    };
  }
}

function commitTool(deps: ToolDeps): ToolDef {
  return {
    name: "grande_commit",
    description: "把任务 worktree 的全部改动提交到任务分支。提交身份来自控制平面，所有 git 调用都禁用 hooks；策略可要求当前工作区先通过指定 profile。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务ID" },
        message: { type: "string", description: "提交说明；Grande-Task/Grande-Attestation 尾注由 Gateway 可信追加" },
      },
      required: ["taskId", "message"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args) => {
      const taskId = args.taskId as string;
      let audit: AuditHandle | undefined;
      try {
        const task = getTask(deps.db, taskId);
        if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
        audit = beginAudit(deps.db, {
          taskId,
          tool: "grande_commit",
          input: { message: args.message },
        });

        try {
          assertCommitPolicy(deps.db, deps.layout, task);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          audit.denied(reason);
          throw error;
        }

        audit.allowed();
        if (!audit.executing()) {
          throw new StateError("STALE_STATE", `任务 ${taskId} 的提交审计句柄无法推进到 EXECUTING。`);
        }

        const candidate = captureCandidate(deps, taskId, task.worktreePath);
        const attestationId = candidate.issued ? candidate.candidate.attestationId : "none";
        const result = commitWorktree(
          deps.layout,
          task.worktreePath,
          taskId,
          args.message as string,
          attestationId,
        );
        const attestation = candidate.issued
          ? { issued: true as const, ...issueAttestation(deps.db, candidate.candidate, result.commit) }
          : candidate;

        audit.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: { ...result, attestation },
            hint: `任务 ${taskId} 已提交 ${result.filesChanged} 个文件，commit ${result.commit}` +
              (attestation.issued ? `；已写入本机验证记录 ${attestation.attestationId}` : `；${attestation.reason}`),
            taskContext: taskContext(deps, taskId),
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failedEnvelope(deps, taskId, error);
      }
    },
  };
}

function syncBaseTool(deps: ToolDeps): ToolDef {
  return {
    name: "grande_sync_base",
    description: "把任务分支同步到本机 canonical HEAD。操作前建立 checkpoint；可快进或 merge，冲突时会 abort 并恢复原状。绝不 fetch。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务ID" },
      },
      required: ["taskId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args) => {
      const taskId = args.taskId as string;
      let audit: AuditHandle | undefined;
      try {
        const task = getTask(deps.db, taskId);
        if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
        audit = beginAudit(deps.db, { taskId, tool: "grande_sync_base", input: { taskId } });
        audit.allowed();
        if (!audit.executing()) {
          throw new StateError("STALE_STATE", `任务 ${taskId} 的同步审计句柄无法推进到 EXECUTING。`);
        }
        const result = syncBase(deps.layout, task);
        audit.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: result,
            hint: result.action === "up-to-date"
              ? `任务 ${taskId} 已与本机 canonical HEAD 保持一致，无需同步。`
              : `任务 ${taskId} 已通过 ${result.action} 同步到 ${result.after}。`,
            taskContext: taskContext(deps, taskId),
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failedEnvelope(deps, taskId, error);
      }
    },
  };
}

function wrapRunWithVerificationContext(deps: ToolDeps, tools: ToolDef[]): void {
  const run = tools.find((tool) => tool.name === "grande_run");
  if (!run) return;
  const coreHandler = run.handler;
  run.handler = async (args) => {
    const taskId = args.taskId as string;
    const task = getTask(deps.db, taskId);
    let context: VerificationContext | undefined;
    if (task) {
      try {
        // 必须在 core handler 真正启动 run 之前捕获，之后再读已经太晚。
        context = captureVerificationContext(deps.layout, task.worktreePath);
      } catch {
        // 验证上下文记录失败不应阻止用户运行 profile；只是这次 run 不能用于 attestation。
      }
    }

    const response = await coreHandler(args);
    const envelope = response.structuredContent as {
      ok?: unknown;
      data?: { jobId?: unknown };
      hint?: string;
    };
    if (envelope.ok === true && context && typeof envelope.data?.jobId === "string") {
      try {
        recordRunVerificationContext(deps.db, envelope.data.jobId, context);
      } catch (error) {
        envelope.hint = `${envelope.hint ?? ""}；本机验证上下文记录失败：` +
          `${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return response;
  };
}

function wrapTaskStatusWithBase(deps: ToolDeps, tools: ToolDef[]): void {
  const status = tools.find((tool) => tool.name === "grande_task_status");
  if (!status) return;
  const coreHandler = status.handler;
  status.handler = async (args) => {
    const response = await coreHandler(args);
    const taskId = args.taskId as string | undefined;
    if (!taskId) return response;
    const envelope = response.structuredContent as {
      ok?: unknown;
      data?: Record<string, unknown>;
    };
    if (envelope.ok !== true || !envelope.data) return response;
    const task = getTask(deps.db, taskId);
    if (!task) return response;
    try {
      envelope.data.base = inspectBaseStatus(deps.layout, task);
      envelope.data.attestations = getAttestations(deps.db, taskId);
      return response;
    } catch (error) {
      return failedEnvelope(deps, taskId, error);
    }
  };
}

export function addLocalLoopTools(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  wrapRunWithVerificationContext(deps, tools);
  wrapTaskStatusWithBase(deps, tools);
  return [...tools, commitTool(deps), syncBaseTool(deps)];
}
