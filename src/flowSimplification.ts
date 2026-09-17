import { existsSync } from "node:fs";
import { classifyDevelopmentRisk, type DevelopmentRiskLevel } from "./developmentRisk.ts";
import {
  projectDeliveryTargetProgress,
  resolveDeliveryTarget,
  type DeliveryTarget,
} from "./deliveryTarget.ts";
import { waitForTerminalJob } from "./jobWait.ts";
import { TERMINAL } from "./jobs.ts";
import { jobReport } from "./runner.ts";
import { compactTaskProgress, type TaskProgress } from "./taskProgress.ts";
import { readTaskPrReceipt } from "./taskPrReceipt.ts";
import { getTask } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";
import { listChangedFiles } from "./worktree.ts";

export const RUN_BOUNDED_WAIT_MS = 5_000;

interface FlowProgress extends TaskProgress {
  deliveryTarget: DeliveryTarget;
  developmentRisk: DevelopmentRiskLevel;
}

function developmentRiskForTask(task: NonNullable<ReturnType<typeof getTask>>): DevelopmentRiskLevel {
  try {
    return classifyDevelopmentRisk(listChangedFiles(task.worktreePath, task.baseCommit));
  } catch {
    // Missing/unreadable worktree is not evidence that the task is safe.
    return "L3";
  }
}

function projectFlowProgress(deps: ToolDeps, taskId: string, value: unknown): FlowProgress | null {
  if (!value || typeof value !== "object" || "error" in value) return null;
  const task = getTask(deps.db, taskId);
  if (!task) return null;
  const target = resolveDeliveryTarget(deps.db, task);
  const risk = developmentRiskForTask(task);
  const projected = projectDeliveryTargetProgress(value as TaskProgress, target, taskId);
  return Object.assign(projected, { deliveryTarget: target, developmentRisk: risk });
}

function wrapRun(deps: ToolDeps, tools: ToolDef[]): void {
  const run = tools.find((tool) => tool.name === "grande_run");
  if (!run) return;

  const originalRunPrefix = "在沙箱中异步执行一个 profile 命令，立即返回 jobId 供后续查询。";
  const profileDiscovery = run.description.startsWith(originalRunPrefix)
    ? run.description.slice(originalRunPrefix.length)
    : run.description;
  run.description = "在沙箱中执行一个 profile。短 job 会在固定 bounded wait 内直接返回终态；" +
    "超过预算则返回稳定 jobId，后续通过 grande_run_result 恢复/查询。" +
    profileDiscovery;

  const profileProperty = run.inputSchema.properties.profile;
  if (profileProperty && typeof profileProperty === "object" && !Array.isArray(profileProperty)) {
    (profileProperty as { description?: string }).description = "要执行的 profile 名称";
  }

  const inner = run.handler;
  run.handler = async (args) => {
    const response = await inner(args);
    const envelope = response.structuredContent as {
      ok?: unknown;
      data?: Record<string, unknown>;
      hint?: string;
    };
    const jobId = envelope.ok === true && typeof envelope.data?.jobId === "string"
      ? envelope.data.jobId
      : null;
    if (!jobId) return response;

    try {
      await waitForTerminalJob(deps.db, jobId, { timeoutMs: RUN_BOUNDED_WAIT_MS });
      const report = jobReport(deps.db, jobId);
      envelope.data!.boundedWaitMs = RUN_BOUNDED_WAIT_MS;
      if (TERMINAL.has(report.state)) {
        envelope.data!.state = report.state;
        envelope.data!.terminalResult = report;
        envelope.hint = `Job ${jobId} 在 bounded wait 内结束：${report.state}` +
          `${report.exitCode !== null ? `，exitCode=${report.exitCode}` : ""}；本次 grande_run 已包含终态结果。`;
      } else {
        envelope.hint = `Job ${jobId} 超过 ${RUN_BOUNDED_WAIT_MS / 1000} 秒 bounded wait 仍在运行；` +
          `保留稳定 jobId，请按 pollAfterSeconds 使用 grande_run_result。`;
      }
    } catch (error) {
      envelope.hint = `${envelope.hint ?? ""}；bounded wait 观察失败，不影响已启动 job：` +
        `${error instanceof Error ? error.message : String(error)}`;
    }
    return response;
  };
}

function wrapTaskStatus(deps: ToolDeps, tools: ToolDef[]): void {
  const status = tools.find((tool) => tool.name === "grande_task_status");
  if (!status) return;

  const inner = status.handler;
  status.handler = async (args) => {
    const response = await inner(args);
    const envelope = response.structuredContent as {
      ok?: unknown;
      data?: Record<string, unknown>;
      hint?: string;
    };
    if (envelope.ok !== true || !envelope.data) return response;

    const taskId = typeof args.taskId === "string" ? args.taskId : null;
    if (taskId) {
      const task = getTask(deps.db, taskId);
      const source = envelope.data.progress as TaskProgress | undefined;
      const archived = task?.state === "CLOSED" && !existsSync(task.worktreePath)
        && source?.completed === true && source.blocker === null && !source.cleanupRequired
        && readTaskPrReceipt(deps.db, taskId)?.mergeSha != null;
      // Preserve genuine ghost/recovery warnings; successful, evidenced cleanup is not a ghost.
      if (typeof envelope.hint === "string" && envelope.hint.includes("grande gc") && !archived) return response;
      const projected = projectFlowProgress(deps, taskId, envelope.data.progress);
      if (!projected) return response;
      envelope.data.progress = projected;
      envelope.data.deliveryTarget = projected.deliveryTarget;
      envelope.data.developmentRisk = projected.developmentRisk;
      if (archived && projected.completed && projected.blocker === null) {
        envelope.data.base = { relation: "archived", detail: "Task 已关闭，worktree 已清理；不再比较本地 HEAD" };
      }
      envelope.hint = `deliveryTarget=${projected.deliveryTarget}；developmentRisk=${projected.developmentRisk}；` +
        `${compactTaskProgress(projected)}；下一步：${projected.nextAction}`;
      return response;
    }

    const active = envelope.data.activeTasks;
    if (!Array.isArray(active)) return response;
    for (const item of active) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.taskId !== "string") continue;
      const projected = projectFlowProgress(deps, row.taskId, row.progress);
      if (!projected) continue;
      row.progress = projected;
      row.deliveryTarget = projected.deliveryTarget;
      row.developmentRisk = projected.developmentRisk;
    }
    return response;
  };
}

/**
 * Phase 8 response-layer simplification. It changes no tool name, validation shape,
 * annotation, lifecycle table, runner ownership, or merge authority. Runtime-only
 * profile discovery stays in the top-level description rather than the hashed schema.
 */
export function addFlowSimplification(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  wrapRun(deps, tools);
  wrapTaskStatus(deps, tools);
  return tools;
}
