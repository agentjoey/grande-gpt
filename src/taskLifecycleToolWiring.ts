import { beginAudit } from "./audit.ts";
import { err, ok } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import { listJobs, TERMINAL } from "./jobs.ts";
import { registeredIds } from "./registry.ts";
import { assertDiskHeadroom } from "./resourcePolicy.ts";
import { clearTaskCloseIntent } from "./taskCloseIntent.ts";
import { parseDeliveryTarget } from "./taskDeliveryTarget.ts";
import {
  openTaskWithCreating,
  prepareTaskCloseIntent,
  removeTaskWorktreeForClose,
} from "./taskLifecycleOps.ts";
import { getTask, updateTaskState } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

function failure(deps: ToolDeps, taskId: string, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId }) };
}

/**
 * Replace only task_open/task_close handlers with crash-durable equivalents while preserving
 * their public schemas/annotations and all later TaskBrief/flow wrappers.
 */
export function addTaskLifecycleCrashRecovery(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  const taskOpen = tools.find((tool) => tool.name === "grande_task_open");
  if (taskOpen) {
    const legacyOpen = taskOpen.handler;
    taskOpen.handler = async (args) => {
      const taskId = args.taskId as string;
      const repoId = args.repoId as string;
      const slug = args.slug as string;

      let registered = false;
      try {
        registered = typeof repoId === "string" && registeredIds(deps.layout).has(repoId);
      } catch {
        return legacyOpen(args);
      }
      if (!registered || getTask(deps.db, taskId)) return legacyOpen(args);

      let deliveryTarget;
      try {
        deliveryTarget = args.deliveryTarget === undefined
          ? undefined
          : parseDeliveryTarget(args.deliveryTarget);
        assertDiskHeadroom(deps.layout);
      } catch (error) {
        return failure(deps, taskId, error);
      }

      const h = beginAudit(deps.db, {
        taskId,
        tool: "grande_task_open",
        input: deliveryTarget === undefined
          ? { slug, repoId }
          : { slug, repoId, deliveryTarget },
      });
      h.allowed();
      if (!h.executing()) {
        return failure(
          deps,
          taskId,
          new StateError("STALE_STATE", `任务 ${taskId} 的审计句柄无法推进到 EXECUTING。`),
        );
      }

      try {
        const task = openTaskWithCreating(
          { db: deps.db, layout: deps.layout },
          { taskId, repoId, slug, deliveryTarget },
        );
        h.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: {
              taskId: task.taskId,
              branch: task.branch,
              baseCommit: task.baseCommit,
              worktreePath: task.worktreePath,
            },
            hint: `任务 ${task.taskId} 已创建并处于 READY 状态——分支 ${task.branch} 与 worktree 已就绪，` +
              `可以开始工作。下一步：使用 grande_repo_edit (taskId="${task.taskId}") 修改文件，` +
              `或 grande_run (taskId="${task.taskId}") 运行测试。` +
              `完成后调用 grande_task_close (taskId="${task.taskId}") 回收资源。`,
            taskContext: { branch: task.branch, filesChanged: 0, lastJob: null },
          }),
        };
      } catch (error) {
        h.failed(error instanceof Error ? error.message : String(error));
        return failure(deps, taskId, error);
      }
    };
  }

  const taskClose = tools.find((tool) => tool.name === "grande_task_close");
  if (taskClose) {
    taskClose.handler = async (args) => {
      const taskId = args.taskId as string;
      const task = getTask(deps.db, taskId);
      if (!task) return failure(deps, taskId, new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`));
      if (task.state === "CLOSED") {
        return {
          structuredContent: ok({
            taskId,
            data: {
              taskId: task.taskId,
              repoId: task.repoId,
              branch: task.branch,
              worktreePath: task.worktreePath,
            },
            hint: `任务 ${taskId} 此前已关闭（幂等）。worktree：${task.worktreePath}，分支：${task.branch}`,
            taskContext: null,
          }),
        };
      }

      const running = listJobs(deps.db, taskId).filter((job) => !TERMINAL.has(job.state));
      if (running.length > 0) {
        return failure(
          deps,
          taskId,
          new StateError(
            "JOB_RUNNING",
            `任务 ${taskId} 仍有一个在跑的 job：${running[0]!.jobId}。` +
              `请先用 grande_run_result 轮询该 job 至终态（passed/failed/timeout/killed/cancelled），再关闭任务。`,
          ),
        );
      }

      const h = beginAudit(deps.db, { taskId, tool: "grande_task_close", input: { taskId } });
      h.allowed();
      if (!h.executing()) {
        return failure(
          deps,
          taskId,
          new StateError("STALE_STATE", `任务 ${taskId} 的审计句柄无法推进到 EXECUTING。`),
        );
      }

      try {
        const intent = prepareTaskCloseIntent(deps.db, task);
        removeTaskWorktreeForClose(deps.layout, task, intent.headSha);
        updateTaskState(deps.db, taskId, "CLOSED", task.stateVersion);
        clearTaskCloseIntent(deps.db, taskId);
        h.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: {
              taskId: task.taskId,
              repoId: task.repoId,
              branch: task.branch,
              worktreePath: task.worktreePath,
            },
            hint: `任务 ${taskId} 已关闭——worktree ${task.worktreePath} 与分支 ${task.branch} 已被删除。磁盘空间已回收。`,
          }),
        };
      } catch (error) {
        h.failed(error instanceof Error ? error.message : String(error));
        return failure(deps, taskId, error);
      }
    };
  }

  return tools;
}
