import { err, ok } from "./envelope.ts";
import { redact, toToolError } from "./errors.ts";
import { requestJobCancellation } from "./jobCancellation.ts";
import { assertTaskId } from "./paths.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

/** The supervisor owns signals; this public tool only records a task/job-bound request. */
export function createJobCancellationTool(deps: ToolDeps): ToolDef {
  return {
    name: "grande_job_cancel",
    description: "请求取消当前 Gateway supervisor 拥有的指定 task/job。不能取消 production deployment，不接受 PID、signal 或命令；请求成功不代表进程已退出，通过 grande_run_result 观察终态。",
    inputSchema: { type: "object", properties: {
      taskId: { type: "string", description: "job 所属的真实任务ID" },
      jobId: { type: "string", description: "要取消的受管 job ID" },
    }, required: ["taskId", "jobId"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: async (args) => {
      const taskId = args.taskId as string;
      try {
        assertTaskId(taskId);
        assertTaskId(args.jobId as string);
        const result = requestJobCancellation(deps.db, taskId, args.jobId as string);
        return { structuredContent: ok({ taskId, data: result,
          hint: result.requested ? "取消请求已记录；额度保持占用直到 supervisor 确认执行结束。" : "job 已终态，原结果未修改。",
        }) };
      } catch (error) {
        const failure = toToolError(error);
        failure.message = redact(failure.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
        return { structuredContent: err({ ...failure, taskId }) };
      }
    },
  };
}
