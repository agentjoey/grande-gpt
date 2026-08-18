import { checkArgs } from "./argCheck.ts";
import { addCapabilityTools } from "./capabilities.ts";
import { addDeploymentTools } from "./deployment.ts";
import { err } from "./envelope.ts";
import { toToolError, redact } from "./errors.ts";
import { loadGuidance } from "./guidance.ts";
import { addLocalLoopTools } from "./localLoopTools.ts";
import { addPrLifecycleTools } from "./prLifecycle.ts";
import { registeredIds } from "./registry.ts";
import { addTaskBriefSupport } from "./taskBrief.ts";
import { stableToolDefinitions, toolsetIdentity } from "./toolsetIdentity.ts";
import {
  buildTools as buildCoreTools,
  type ToolDef,
  type ToolDeps,
} from "./toolsCore.ts";

export type { ToolDef, ToolDeps } from "./toolsCore.ts";
export {
  TOOLSET_EPOCH,
  gatewayBuildIdentity,
  stableToolDefinitions,
  toolsetIdentity,
  type ToolsetIdentity,
} from "./toolsetIdentity.ts";

/**
 * 生产工具列表的唯一组装点。Task 始终是中心：
 * core → local loop → S6 GitHub lifecycle → S4 brief → S7 deploy → S5 capability → arg check。
 *
 * S7 的 handler 运行时需要复用 S5 capability tools，而 S5 的 native discovery 又应该
 * 看见 S7 deployment tools。这里用一个共享的 `deploymentDeps` 数组解决这个接线顺序：
 * deployment handler 闭包先持有它；deployment tools 建好后再构建 capability（因此 native
 * 快照能看见 deploy tools）；最后只把三只 capability tool 追加回 `deploymentDeps`，供 S7
 * 运行时查找。capability 自己不进入 native 快照，因此不会递归暴露。
 *
 * 没有 workflow engine；每层只在已有 Task 上补一个垂直缺口。
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

  const local = addLocalLoopTools(deps, tools);
  const github = addPrLifecycleTools(deps, local);
  const withBrief = addTaskBriefSupport(deps, github);

  // 共享引用：createDeploymentTools 内部会闭包捕获这个数组。
  const deploymentDeps = [...withBrief];
  const withDeployment = addDeploymentTools(deps, deploymentDeps);

  // native provider 的快照发生在 deploy tools 已经存在之后，所以 discover/list 完整。
  const withCapabilities = addCapabilityTools(deps, withDeployment);
  const capabilityTools = withCapabilities.slice(withDeployment.length);
  deploymentDeps.push(...capabilityTools);

  // 最后一层只规范化 tools/list 可见的顺序/对象键，不改变 handler wiring 或契约含义。
  return stableToolDefinitions(withToolsetIdentity(withArgCheck(deps, withCapabilities)));
}

/**
 * 通过现有 grande_task_status 暴露 server-side toolset identity；不新增 MCP tool。
 * identity 在完整 23-tool 列表组装完之后一次性计算，handler 包装不进入 digest。
 */
function withToolsetIdentity(tools: ToolDef[]): ToolDef[] {
  const identity = toolsetIdentity(tools);
  const status = tools.find((tool) => tool.name === "grande_task_status");
  if (!status) return tools;

  const inner = status.handler;
  status.handler = async (args) => {
    const response = await inner(args);
    const envelope = response.structuredContent as { ok?: unknown; data?: Record<string, unknown> };
    if (envelope.ok === true && envelope.data) Object.assign(envelope.data, identity);
    return response;
  };
  return tools;
}

/**
 * 给**每一个**工具的 handler 前置一道入参校验（遗留表 #13）。
 * 必须在所有 add*Tools/support 之后包，否则后加工具没有统一信封式参数错误。
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
