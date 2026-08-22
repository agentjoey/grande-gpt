import { getLatestActivationReceipt } from "./activationReceipt.ts";
import { checkArgs } from "./argCheck.ts";
import { beginAudit } from "./audit.ts";
import { addCapabilityTools } from "./capabilities.ts";
import { refreshCanonical } from "./canonicalRefresh.ts";
import { addDeploymentTools } from "./deployment.ts";
import { err } from "./envelope.ts";
import { toToolError, redact, StateError } from "./errors.ts";
import { addFlowSimplification } from "./flowSimplification.ts";
import { loadGuidance } from "./guidance.ts";
import { projectHostVerifierOperationalStatus } from "./hostVerifierStatus.ts";
import { addLocalLoopTools } from "./localLoopTools.ts";
import { addOnboardingTools } from "./onboardingTools.ts";
import { createPrMergeTool, createPrStatusTool, type PrLifecycleOptions } from "./prLifecycle.ts";
import { addPrMergeD2Reconciliation } from "./prMergeD2.ts";
import { registeredIds } from "./registry.ts";
import { withRepoWriteLock } from "./repoWriteLock.ts";
import { addTaskBriefSupport } from "./taskBrief.ts";
import { getTask } from "./tasks.ts";
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

export type BuildToolsOptions = Pick<PrLifecycleOptions, "hostVerificationMode" | "hostVerifierCoordinator">;

const TASK_SCOPED_REPO_WRITES = new Set([
  "grande_commit",
  "grande_sync_base",
  "grande_push",
  "grande_pr_merge",
  "grande_deploy",
  "grande_deploy_rollback",
  "grande_task_close",
]);

/**
 * 给已有 task-scoped repo 写操作套一层 repo mutex。这里只按 taskId 反查可信
 * repoId；不存在的 task 仍交给原 handler 生成既有 TASK_NOT_FOUND 信封。
 *
 * task_open 没有既存 task，单独在 buildTools 中处理。pr_merge 只读取一次当前 PR/CI
 * 状态并立即返回或执行 destructive merge，不做 CI/verifier 轮询；因此可以与其
 * merge 前后 canonical refresh 一起保持为一个短生命周期写临界区。pr_status 不占锁。
 */
function withTaskRepoWriteLocks(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  for (const tool of tools) {
    if (!TASK_SCOPED_REPO_WRITES.has(tool.name)) continue;
    const inner = tool.handler;
    tool.handler = async (args) => {
      const taskId = typeof args.taskId === "string" ? args.taskId : null;
      if (!taskId) return inner(args);
      const task = getTask(deps.db, taskId);
      if (!task) return inner(args);
      return withRepoWriteLock(task.repoId, () => inner(args), deps.layout);
    };
  }
  return tools;
}

/**
 * 生产工具列表的唯一组装点。Task 始终是中心：
 * core → local loop → Phase 8 flow projection → S6 GitHub lifecycle → D2 merge reconciliation → S4 brief → S9 onboarding → S7 deploy → S5 capability → arg check。
 *
 * S7 的 handler 运行时需要复用 S5 capability tools，而 S5 的 native discovery 又应该
 * 看见 S7 deployment tools。这里用一个共享的 `deploymentDeps` 数组解决这个接线顺序：
 * deployment handler 闭包先持有它；deployment tools 建好后再构建 capability（因此 native
 * 快照能看见 deploy tools）；最后只把三只 capability tool 追加回 `deploymentDeps`，供 S7
 * 运行时查找。capability 自己不进入 native 快照，因此不会递归暴露。
 *
 * 没有 workflow engine；每层只在已有 Task 上补一个垂直缺口。
 */
export function buildTools(deps: ToolDeps, options: BuildToolsOptions = {}): ToolDef[] {
  const tools = buildCoreTools(deps);
  const taskOpen = tools.find((tool) => tool.name === "grande_task_open");
  if (taskOpen) {
    const coreHandler = taskOpen.handler;
    taskOpen.handler = async (args) => {
      const repoId = args.repoId as string;
      const taskId = args.taskId as string;
      let registered = false;
      try {
        registered = typeof repoId === "string" && registeredIds(deps.layout).has(repoId);
      } catch {
        return coreHandler(args);
      }
      if (!registered) return coreHandler(args);
      if (typeof taskId === "string" && getTask(deps.db, taskId)) return coreHandler(args);

      return withRepoWriteLock(repoId, async () => {
        if (typeof taskId === "string" && getTask(deps.db, taskId)) return coreHandler(args);

        let canonicalRefresh: ReturnType<typeof refreshCanonical>;
        const refreshAudit = beginAudit(deps.db, {
          taskId,
          tool: "grande_task_open",
          input: { repoId, phase: "canonical_refresh" },
        });
        refreshAudit.allowed();
        if (!refreshAudit.executing()) {
          const error = new StateError("STALE_STATE", `任务 ${taskId} 的 canonical refresh 审计句柄无法推进到 EXECUTING。`);
          refreshAudit.failed(error.message);
          const toolError = toToolError(error);
          return { structuredContent: err({ ...toolError, taskId }) };
        }
        try {
          canonicalRefresh = refreshCanonical(deps.layout, repoId);
          refreshAudit.succeeded([]);
        } catch (error) {
          refreshAudit.failed(error instanceof Error ? error.message : String(error));
          const toolError = toToolError(error);
          toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
          return { structuredContent: err({ ...toolError, taskId }) };
        }

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
        if (envelope.ok === true && envelope.data) {
          envelope.data.canonicalRefresh = canonicalRefresh;
          if (guidance !== undefined) envelope.data.guidance = guidance;
        }
        return result;
      }, deps.layout);
    };
  }

  const local = addLocalLoopTools(deps, tools, {
    hostVerificationMode: options.hostVerificationMode,
  });
  const simplified = addFlowSimplification(deps, local);
  const githubBase = [...simplified, createPrStatusTool(deps), createPrMergeTool(deps, options)];
  const github = addPrMergeD2Reconciliation(deps, githubBase);
  const withBrief = addTaskBriefSupport(deps, github);
  const withOnboarding = addOnboardingTools(deps, withBrief);

  const deploymentDeps = [...withOnboarding];
  const withDeployment = addDeploymentTools(deps, deploymentDeps);

  const withCapabilities = addCapabilityTools(deps, withDeployment);
  const capabilityTools = withCapabilities.slice(withDeployment.length);
  deploymentDeps.push(...capabilityTools);

  const serialized = withTaskRepoWriteLocks(deps, withCapabilities);
  return stableToolDefinitions(withToolsetIdentity(
    deps,
    withArgCheck(deps, serialized),
    options.hostVerificationMode ?? "manual",
  ));
}

/**
 * 通过现有 grande_task_status 暴露 server-side toolset identity、最小 Host Verifier
 * operational snapshot 与最近 production activation receipt；不新增额外 MCP tool。
 * 这些都只包装 response，handler 包装不进入 tool contract digest。
 */
function withToolsetIdentity(
  deps: ToolDeps,
  tools: ToolDef[],
  hostVerificationMode: "manual" | "auto",
): ToolDef[] {
  const identity = toolsetIdentity(tools);
  const status = tools.find((tool) => tool.name === "grande_task_status");
  if (!status) return tools;

  const inner = status.handler;
  status.handler = async (args) => {
    const response = await inner(args);
    const envelope = response.structuredContent as { ok?: unknown; data?: Record<string, unknown> };
    if (envelope.ok === true && envelope.data) {
      Object.assign(envelope.data, identity);
      envelope.data.activationReceipt = getLatestActivationReceipt(deps.db);
      const progress = envelope.data.progress;
      const taskHead = progress && typeof progress === "object" && typeof (progress as { taskHead?: unknown }).taskHead === "string"
        ? (progress as { taskHead: string }).taskHead
        : null;
      envelope.data.hostVerifier = projectHostVerifierOperationalStatus(deps.db, {
        mode: hostVerificationMode,
        verifierBuild: identity.gatewayBuild,
        currentSha: taskHead,
        currentTaskId: typeof args.taskId === "string" ? args.taskId : null,
      });
    }
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
