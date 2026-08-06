import { checkArgs } from "./argCheck.ts";
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

  return withArgCheck(deps, addLocalLoopTools(deps, tools));
}

/**
 * 给**每一个**工具的 handler 前置一道入参校验（遗留表 #13）。
 *
 * ## 为什么接在这里
 *
 * 这是生产工具列表的**唯一出口**——`server.ts` 从这里拿，测试也从这里拿。
 * 接在 `server.ts` 的注册循环里会漏掉 `addLocalLoopTools` 之外的调用方，
 * 而「接了但没接全」正是本项目已出现 5 次的 P-A 形状。
 *
 * 注意顺序：必须在 `addLocalLoopTools` **之后**包，否则它新加的工具没有校验。
 *
 * ## 为什么不是靠 SDK 的 zod
 *
 * `server.ts` 的 `toZodSchema` 确实建出了带 `required` 的 zod schema，但那道
 * 校验只在 MCP over HTTP 这一条路径上，**且它的失败是 JSON-RPC 层的错误**，
 * 不是我们的 `ok/error` 信封——模型拿到的东西形状都不一样。这里统一成信封。
 */
function withArgCheck(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  for (const tool of tools) {
    const inner = tool.handler;
    tool.handler = async (args) => {
      try {
        checkArgs(tool, args);
      } catch (e) {
        const te = toToolError(e);
        te.message = redact(te.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
        // taskId 尽量带上：模型靠它把错误对回是哪个任务。参数本身可能就是错的，
        // 所以只在它确实是字符串时才用。
        return {
          structuredContent: err({
            ...te,
            taskId: typeof args.taskId === "string" ? args.taskId : null,
          }),
        };
      }
      return inner(args);
    };
  }
  return tools;
}
