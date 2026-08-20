import { existsSync } from "node:fs";
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
import { createPrOpenTool } from "./prOpen.ts";
import { createPushTool } from "./push.ts";
import { registeredIds } from "./registry.ts";
import { syncBase } from "./syncBase.ts";
import { compactTaskProgress, projectTaskProgress, type TaskProgress } from "./taskProgress.ts";
import { getTask, listActiveTasks, type TaskRow } from "./tasks.ts";
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
    description: "把当前本机 canonical HEAD 合入或快进到任务 worktree；绝不修改 canonical，也绝不 fetch。" +
      "返回 relation=equal/task_ahead/canonical_ahead/diverged 明确两个 HEAD 在操作前的关系。",
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
        const hint = result.relation === "equal"
          ? `任务 ${taskId} HEAD 与当前本机 canonical HEAD 相等，无需操作。`
          : result.relation === "task_ahead"
            ? `任务 ${taskId} 已包含当前 canonical HEAD，且 task 有额外提交；无需把 canonical 合入 task。`
            : result.relation === "canonical_ahead"
              ? `当前 canonical HEAD 领先 task；已在任务 worktree fast-forward 到 ${result.after}。`
              : `task 与当前 canonical 已分叉；已在任务 worktree 合入 canonical，结果 ${result.after}。`;
        return {
          structuredContent: ok({
            taskId,
            data: result,
            hint,
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

function safeProgress(deps: ToolDeps, task: TaskRow): TaskProgress | { error: string } {
  try {
    return projectTaskProgress(deps.db, task);
  } catch (error) {
    return {
      error: redact(error instanceof Error ? error.message : String(error), [deps.layout.workspaceRoot, deps.layout.controlRoot]),
    };
  }
}

function safeFilesChanged(task: TaskRow): number | null {
  try {
    return listChangedFiles(task.worktreePath, task.baseCommit).length;
  } catch {
    return null;
  }
}

function ghostDetail(deps: ToolDeps, task: TaskRow): { structuredContent: unknown } {
  const jobs = listJobs(deps.db, task.taskId);
  const progress = safeProgress(deps, task);
  return {
    structuredContent: ok({
      taskId: task.taskId,
      data: {
        taskId: task.taskId,
        repoId: task.repoId,
        branch: task.branch,
        state: task.state,
        baseCommit: task.baseCommit,
        filesChanged: null,
        recentJobs: jobs.slice(0, 5).map((job) => ({
          jobId: job.jobId,
          state: job.state,
          profile: job.profile,
          exitCode: job.exitCode,
        })),
        base: { error: "task worktree 不存在；这是 stale/ghost task，运行 grande gc 查看对账" },
        attestations: getAttestations(deps.db, task.taskId),
        progress,
      },
      hint: `任务 ${task.taskId} 的 worktree 已不存在；状态记录仍可读。运行 grande gc 查看 stale task，对账后再决定清理。`,
      taskContext: null,
    }),
  };
}

function ghostOverview(deps: ToolDeps): { structuredContent: unknown } {
  const registered = [...registeredIds(deps.layout)].sort();
  const active = listActiveTasks(deps.db).map((task) => ({
    taskId: task.taskId,
    repoId: task.repoId,
    branch: task.branch,
    state: task.state,
    filesChanged: safeFilesChanged(task),
    worktreeMissing: !existsSync(task.worktreePath),
    progress: safeProgress(deps, task),
  }));
  return {
    structuredContent: ok({
      taskId: null,
      data: { registeredRepos: registered, activeTasks: active },
      hint: `已注册仓库：${registered.join("、") || "（无）"}；活跃任务 ${active.length} 个。` +
        `其中 ${active.filter((task) => task.worktreeMissing).length} 个 worktree 缺失，可用 grande gc 对账。`,
    }),
  };
}

function wrapTaskStatusWithBase(deps: ToolDeps, tools: ToolDef[]): void {
  const status = tools.find((tool) => tool.name === "grande_task_status");
  if (!status) return;
  const coreHandler = status.handler;
  status.handler = async (args) => {
    const taskId = args.taskId as string | undefined;
    if (taskId) {
      const task = getTask(deps.db, taskId);
      if (task && !existsSync(task.worktreePath)) return ghostDetail(deps, task);
    } else if (listActiveTasks(deps.db).some((task) => !existsSync(task.worktreePath))) {
      return ghostOverview(deps);
    }

    const response = await coreHandler(args);
    const envelope = response.structuredContent as {
      ok?: unknown;
      data?: Record<string, unknown>;
      hint?: string;
    };
    if (envelope.ok !== true || !envelope.data) return response;

    if (!taskId) {
      const active = envelope.data.activeTasks;
      if (Array.isArray(active)) {
        for (const item of active) {
          if (!item || typeof item !== "object" || typeof (item as { taskId?: unknown }).taskId !== "string") continue;
          const task = getTask(deps.db, (item as { taskId: string }).taskId);
          if (task) (item as Record<string, unknown>).progress = safeProgress(deps, task);
        }
      }
      return response;
    }

    const task = getTask(deps.db, taskId);
    if (!task) return response;
    const progress = safeProgress(deps, task);
    envelope.data.progress = progress;
    if (!("error" in progress)) {
      envelope.hint = `${envelope.hint ?? ""}；${compactTaskProgress(progress)}；下一步：${progress.nextAction}`;
    }
    try {
      envelope.data.base = inspectBaseStatus(deps.layout, task);
    } catch (error) {
      envelope.data.base = {
        error: redact(error instanceof Error ? error.message : String(error), [deps.layout.workspaceRoot, deps.layout.controlRoot]),
      };
      envelope.hint = `${envelope.hint ?? ""}；base inspection 失败，但 task/progress 仍可用。`;
    }
    try {
      envelope.data.attestations = getAttestations(deps.db, taskId);
    } catch (error) {
      envelope.data.attestations = [];
      envelope.hint = `${envelope.hint ?? ""}；attestation 读取失败：` +
        redact(error instanceof Error ? error.message : String(error), [deps.layout.workspaceRoot, deps.layout.controlRoot]);
    }
    return response;
  };
}

export function addLocalLoopTools(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  wrapRunWithVerificationContext(deps, tools);
  wrapTaskStatusWithBase(deps, tools);
  return [
    ...tools,
    commitTool(deps),
    syncBaseTool(deps),
    createPushTool(deps),
    createPrOpenTool(deps),
  ];
}
