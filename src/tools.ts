import { err } from "./envelope.ts";
import { toToolError, redact } from "./errors.ts";
import { loadGuidance } from "./guidance.ts";
import { addLocalLoopTools } from "./localLoopTools.ts";
import { registeredIds } from "./registry.ts";
import {
  buildTools as buildCoreTools,
  type ToolDef,
  type ToolDeps,
} from "./toolsCore.ts";

export type { ToolDef, ToolDeps } from "./toolsCore.ts";

/**
 * 保持工具注册主体稳定，只在公共入口给 grande_task_open 的成功数据附加 repo guidance，
 * 再把 S2 本地闭环工具接入同一个生产工具列表。
 * guidance 在调用原处理器前加载：坏配置会以标准错误信封返回，不会先创建 worktree。
 */
export function buildTools(deps: ToolDeps): ToolDef[] {
  const tools = buildCoreTools(deps);
  const taskOpen = tools.find((tool) => tool.name === "grande_task_open");
  if (taskOpen) {
    const coreHandler = taskOpen.handler;
    taskOpen.handler = async (args) => {
      const repoId = args.repoId as string;
      let registered = false;
      try {
        registered = typeof repoId === "string" && registeredIds(deps.layout).has(repoId);
      } catch {
        // 注册表自身的错误继续交给原处理器及其统一 wrap 转换，避免在这里复制规则。
        return coreHandler(args);
      }
      if (!registered) return coreHandler(args);

      let guidance: string | undefined;
      try {
        guidance = loadGuidance(deps.layout, repoId);
      } catch (error) {
        const toolError = toToolError(error);
        toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
        return {
          structuredContent: err({
            ...toolError,
            taskId: typeof args.taskId === "string" ? args.taskId : null,
          }),
        };
      }

      const result = await coreHandler(args);
      const envelope = result.structuredContent as {
        ok?: unknown;
        data?: Record<string, unknown>;
      };
      if (envelope.ok === true && envelope.data && guidance !== undefined) {
        envelope.data.guidance = guidance;
      }
      return result;
    };
  }

  return addLocalLoopTools(deps, tools);
}
