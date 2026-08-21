import { createHash } from "node:crypto";
import { parse } from "yaml";
import { beginAudit, type AuditHandle } from "./audit.ts";
import { err, ok } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import { getJob, TERMINAL } from "./jobs.ts";
import { getProfile } from "./profiles.ts";
import { MAX_REPO_READ_BYTES, repoRead } from "./repoFile.ts";
import { getTask, type TaskRow } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

export type DeploymentAction =
  | { kind: "profile"; profile: string }
  | { kind: "capability"; provider: string; name: string; arguments: Record<string, unknown> };

export interface DeploymentSpec {
  deploy: DeploymentAction;
  verify: DeploymentAction;
  rollback?: DeploymentAction;
}

export interface DeploymentToolOptions {
  requireMerged?: (taskId: string) => Promise<{ merged: boolean; mergeSha?: string }>;
}

interface DeploymentReceipt {
  taskId: string;
  specDigest: string;
  mergeSha?: string;
  deployRef: string;
  verifyRef: string;
  rollbackRef?: string;
  deployComplete: boolean;
  deployJobId?: string;
  deployedAt?: number;
  verifyComplete: boolean;
  verifyJobId?: string;
  verifiedAt?: number;
  rollbackJobId?: string;
  rolledBackAt?: number;
}

function invalid(message: string): never {
  throw new StateError("INVALID_INPUT", `deploy spec 不合法：${message}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} 必须是 object。`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${field} 包含未知字段 ${key}。`);
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} 必须是非空字符串。`);
  return value.trim();
}

function argumentsObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  const out = record(value, field);
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

function parseAction(value: unknown, field: string): DeploymentAction {
  const action = record(value, field);
  onlyKeys(action, ["profile", "capability"], field);
  const hasProfile = action.profile !== undefined;
  const hasCapability = action.capability !== undefined;
  if (hasProfile === hasCapability) invalid(`${field} 必须且只能选择 profile 或 capability。`);

  if (hasProfile) return { kind: "profile", profile: text(action.profile, `${field}.profile`) };

  const capability = record(action.capability, `${field}.capability`);
  onlyKeys(capability, ["provider", "name", "arguments"], `${field}.capability`);
  return {
    kind: "capability",
    provider: text(capability.provider, `${field}.capability.provider`),
    name: text(capability.name, `${field}.capability.name`),
    arguments: argumentsObject(capability.arguments, `${field}.capability.arguments`),
  };
}

/**
 * Repo 只声明【使用哪个已批准的执行机制】，从不提供任意 command/argv。
 * 固定文件 `.grande/deploy.yaml` 通过 repoRead 读取，沿用仓库路径/符号链接安全边界。
 */
export function loadDeploymentSpec(worktreePath: string): DeploymentSpec {
  let parsed: unknown;
  try {
    const result = repoRead(worktreePath, ".grande/deploy.yaml", { maxBytes: MAX_REPO_READ_BYTES });
    if (result.truncated) {
      throw new StateError(
        "INVALID_INPUT",
        `.grande/deploy.yaml 超过 ${MAX_REPO_READ_BYTES} 字节，拒绝解析截断的部署配置。`,
      );
    }
    parsed = parse(result.content);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError(
      "INVALID_INPUT",
      `无法读取/解析 .grande/deploy.yaml：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = record(parsed, "顶层");
  onlyKeys(root, ["deploy", "verify", "rollback"], "顶层");
  if (root.deploy === undefined) invalid("缺少 deploy。 ");
  if (root.verify === undefined) invalid("缺少 verify；没有验证不能进入 DONE。 ");
  return {
    deploy: parseAction(root.deploy, "deploy"),
    verify: parseAction(root.verify, "verify"),
    ...(root.rollback !== undefined ? { rollback: parseAction(root.rollback, "rollback") } : {}),
  };
}

function digestSpec(spec: DeploymentSpec): string {
  return createHash("sha256").update(JSON.stringify(spec), "utf8").digest("hex");
}

function actionRef(action: DeploymentAction | undefined): string | undefined {
  if (!action) return undefined;
  return action.kind === "profile"
    ? `profile:${action.profile}`
    : `capability:${action.provider}/${action.name}`;
}

function saveReceipt(deps: ToolDeps, receipt: DeploymentReceipt): void {
  deps.db.prepare(
    `INSERT INTO deployment_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)
     ON CONFLICT(taskId) DO UPDATE SET receiptJson=excluded.receiptJson, updatedAt=excluded.updatedAt`,
  ).run(receipt.taskId, JSON.stringify(receipt), Date.now());
}

function loadReceipt(deps: ToolDeps, taskId: string): DeploymentReceipt | undefined {
  const row = deps.db.prepare("SELECT receiptJson FROM deployment_receipt WHERE taskId=?").get(taskId) as
    | { receiptJson: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.receiptJson) as DeploymentReceipt;
  } catch (error) {
    throw new StateError(
      "INVALID_INPUT",
      `任务 ${taskId} 的 deployment receipt 损坏：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function taskOrThrow(deps: ToolDeps, taskId: string): TaskRow {
  const task = getTask(deps.db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  return task;
}

function toolByName(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new StateError("INVALID_INPUT", `部署闭环需要 ${name}，但生产工具列表里没有它。`);
  return tool;
}

function unwrap(response: { structuredContent: unknown }, action: string): Record<string, unknown> {
  const envelope = response.structuredContent as {
    ok?: unknown;
    data?: unknown;
    error?: { message?: unknown };
  };
  if (envelope.ok !== true) {
    throw new StateError(
      "INVALID_INPUT",
      `${action} 失败：${typeof envelope.error?.message === "string" ? envelope.error.message : "下游工具返回失败"}`,
    );
  }
  return envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : {};
}

function assertProfileRole(deps: ToolDeps, task: TaskRow, action: DeploymentAction, role: "deploy" | "verify" | "rollback"): void {
  if (action.kind !== "profile") return;
  try {
    getProfile(deps.layout, task.repoId, action.profile);
  } catch (error) {
    throw new StateError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
  }
  if (role === "deploy" && !/^deploy(?:-|$)/.test(action.profile)) {
    throw new StateError(
      "POLICY_DENIED",
      `deploy.profile=${action.profile} 不是 deploy/deploy-*；repo 不能把普通测试 profile 冒充生产部署。`,
    );
  }
  if (role === "rollback" && !/^rollback(?:-|$)/.test(action.profile)) {
    throw new StateError(
      "POLICY_DENIED",
      `rollback.profile=${action.profile} 不是 rollback/rollback-*。`,
    );
  }
}

async function assertCapabilityRole(
  tools: ToolDef[],
  action: DeploymentAction,
  role: "deploy" | "verify" | "rollback",
): Promise<void> {
  if (action.kind !== "capability") return;
  const inspect = toolByName(tools, "grande_capability_inspect");
  const data = unwrap(await inspect.handler({ provider: action.provider, name: action.name }), "capability inspect");
  const capability = data.capability as { risk?: unknown } | undefined;
  const risk = capability?.risk;
  const allowed = role === "deploy"
    ? risk === "production"
    : role === "verify"
      ? risk === "read"
      : risk === "production" || risk === "destructive";
  if (!allowed) {
    throw new StateError(
      "POLICY_DENIED",
      `${role} capability ${action.provider}/${action.name} 的 risk=${String(risk)} 不符合角色要求：` +
        (role === "deploy" ? "必须 production" : role === "verify" ? "必须 read" : "必须 production/destructive"),
    );
  }
}

interface ActionResult {
  complete: boolean;
  jobId?: string;
}

async function executeAction(
  deps: ToolDeps,
  tools: ToolDef[],
  task: TaskRow,
  action: DeploymentAction,
  role: "deploy" | "verify" | "rollback",
): Promise<ActionResult> {
  assertProfileRole(deps, task, action, role);
  await assertCapabilityRole(tools, action, role);

  if (action.kind === "profile") {
    const run = toolByName(tools, "grande_run");
    const data = unwrap(await run.handler({ taskId: task.taskId, profile: action.profile }), `${role} profile`);
    if (typeof data.jobId !== "string") throw new StateError("INVALID_INPUT", `${role} profile 未返回 jobId。`);
    return { complete: false, jobId: data.jobId };
  }

  const invoke = toolByName(tools, "grande_capability_invoke");
  unwrap(await invoke.handler({
    provider: action.provider,
    name: action.name,
    taskId: task.taskId,
    arguments: action.arguments,
  }), `${role} capability`);
  return { complete: true };
}

function profileJobState(deps: ToolDeps, task: TaskRow, jobId: string, expectedProfile: string): "running" | "passed" | "failed" {
  const job = getJob(deps.db, jobId);
  if (!job) throw new StateError("JOB_NOT_FOUND", `deployment job ${jobId} 不存在。`);
  if (job.taskId !== task.taskId || job.profile !== expectedProfile) {
    throw new StateError(
      "POLICY_DENIED",
      `deployment receipt 的 job ${jobId} 不属于任务/profile ${task.taskId}/${expectedProfile}。`,
    );
  }
  if (!TERMINAL.has(job.state)) return "running";
  return job.state === "passed" && job.exitCode === 0 ? "passed" : "failed";
}

function currentState(receipt: DeploymentReceipt): "deploying" | "deployed" | "verifying" | "DONE" {
  if (receipt.verifyComplete) return "DONE";
  if (receipt.verifyJobId) return "verifying";
  return receipt.deployComplete ? "deployed" : "deploying";
}

function failedEnvelope(deps: ToolDeps, taskId: string, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId }) };
}

async function defaultRequireMerged(tools: ToolDef[], taskId: string): Promise<{ merged: boolean; mergeSha?: string }> {
  const status = toolByName(tools, "grande_pr_status");
  const data = unwrap(await status.handler({ taskId }), "PR status");
  const pr = data.pr as { merged?: unknown } | undefined;
  return { merged: pr?.merged === true };
}

function ensureReceiptMatches(receipt: DeploymentReceipt, spec: DeploymentSpec): void {
  const digest = digestSpec(spec);
  if (receipt.specDigest !== digest) {
    throw new StateError(
      "STALE_STATE",
      "部署后 .grande/deploy.yaml 已发生变化；不能用旧 deployment receipt 给新 spec 的 verify 背书。请开新 Task 重新部署。",
    );
  }
}

function beginToolAudit(deps: ToolDeps, taskId: string, tool: string, input: Record<string, unknown>): AuditHandle {
  const audit = beginAudit(deps.db, { taskId, tool, input });
  audit.allowed();
  if (!audit.executing()) throw new StateError("STALE_STATE", `${tool} 审计句柄无法推进到 EXECUTING。`);
  return audit;
}

export function createDeploymentTools(
  deps: ToolDeps,
  tools: ToolDef[],
  options: DeploymentToolOptions = {},
): ToolDef[] {
  const taskSchema = {
    type: "object" as const,
    properties: { taskId: { type: "string", description: "任务ID；部署配置固定从该 Task worktree 读取" } },
    required: ["taskId"],
  };

  const deployTool: ToolDef = {
    name: "grande_deploy",
    description:
      "merge 后按 repo 的 .grande/deploy.yaml 调用【已批准】deploy profile 或 production capability。" +
      "repo 不能提供任意 command/argv；成功后留下轻量 receipt 供 verify 绑定同一份 spec。",
    inputSchema: taskSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      const taskId = args.taskId as string;
      let audit: AuditHandle | undefined;
      try {
        const task = taskOrThrow(deps, taskId);
        const spec = loadDeploymentSpec(task.worktreePath);
        const existing = loadReceipt(deps, taskId);
        if (existing) {
          ensureReceiptMatches(existing, spec);
          return {
            structuredContent: ok({
              taskId,
              data: {
                state: currentState(existing),
                jobId: existing.deployJobId ?? existing.verifyJobId,
                existing: true,
              },
              hint: `任务 ${taskId} 已有同一 deploy spec 的 receipt，未重复部署。`,
            }),
          };
        }

        const merged = await (options.requireMerged
          ? options.requireMerged(taskId)
          : defaultRequireMerged(tools, taskId));
        if (!merged.merged) {
          throw new StateError("POLICY_DENIED", `任务 ${taskId} 的 PR 尚未 merge，拒绝部署。`);
        }

        audit = beginToolAudit(deps, taskId, "grande_deploy", { taskId, specDigest: digestSpec(spec) });
        const result = await executeAction(deps, tools, task, spec.deploy, "deploy");
        const receipt: DeploymentReceipt = {
          taskId,
          specDigest: digestSpec(spec),
          ...(merged.mergeSha ? { mergeSha: merged.mergeSha } : {}),
          deployRef: actionRef(spec.deploy)!,
          verifyRef: actionRef(spec.verify)!,
          ...(spec.rollback ? { rollbackRef: actionRef(spec.rollback) } : {}),
          deployComplete: result.complete,
          ...(result.jobId ? { deployJobId: result.jobId } : {}),
          ...(result.complete ? { deployedAt: Date.now() } : {}),
          verifyComplete: false,
        };
        saveReceipt(deps, receipt);
        audit.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: {
              state: result.complete ? "deployed" : "deploying",
              ...(result.jobId ? { jobId: result.jobId } : {}),
              deployRef: receipt.deployRef,
            },
            hint: result.complete
              ? `部署调用已完成；下一步 grande_deploy_verify。`
              : `部署 profile 已启动（job ${result.jobId}）；稍后再次调用 grande_deploy_verify，它会检查 job 并继续验证。`,
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failedEnvelope(deps, taskId, error);
      }
    },
  };

  const verifyTool: ToolDef = {
    name: "grande_deploy_verify",
    description:
      "验证最近一次 grande_deploy。profile deploy/verify 可异步重入；只有 deploy 与 verify 都成功且 spec 未变化才返回 DONE。",
    inputSchema: taskSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (args) => {
      const taskId = args.taskId as string;
      let audit: AuditHandle | undefined;
      try {
        const task = taskOrThrow(deps, taskId);
        const spec = loadDeploymentSpec(task.worktreePath);
        const receipt = loadReceipt(deps, taskId);
        if (!receipt) {
          throw new StateError("INVALID_INPUT", `任务 ${taskId} 没有 deployment receipt；必须先 grande_deploy。`);
        }
        ensureReceiptMatches(receipt, spec);

        if (!receipt.deployComplete) {
          if (spec.deploy.kind !== "profile" || !receipt.deployJobId) {
            throw new StateError("INVALID_INPUT", "deployment receipt 缺少可验证的 deploy job。 ");
          }
          const state = profileJobState(deps, task, receipt.deployJobId, spec.deploy.profile);
          if (state === "running") {
            return { structuredContent: ok({ taskId, data: { state: "deploying", jobId: receipt.deployJobId }, hint: "部署 job 仍在运行。" }) };
          }
          if (state === "failed") {
            throw new StateError("INVALID_INPUT", `部署 job ${receipt.deployJobId} 未通过，不能进入 verify。`);
          }
          receipt.deployComplete = true;
          receipt.deployedAt = Date.now();
          saveReceipt(deps, receipt);
        }

        if (receipt.verifyComplete) {
          return { structuredContent: ok({ taskId, data: { state: "DONE", existing: true }, hint: `任务 ${taskId} 已部署并验证完成。` }) };
        }

        if (receipt.verifyJobId) {
          if (spec.verify.kind !== "profile") {
            throw new StateError("INVALID_INPUT", "deployment receipt 的 verifyJobId 与当前 capability verify spec 不一致。 ");
          }
          const state = profileJobState(deps, task, receipt.verifyJobId, spec.verify.profile);
          if (state === "running") {
            return { structuredContent: ok({ taskId, data: { state: "verifying", jobId: receipt.verifyJobId }, hint: "验证 job 仍在运行。" }) };
          }
          if (state === "failed") {
            throw new StateError("INVALID_INPUT", `验证 job ${receipt.verifyJobId} 失败；deployment 不能标记 DONE。`);
          }
          audit = beginToolAudit(deps, taskId, "grande_deploy_verify", { taskId, verifyJobId: receipt.verifyJobId });
          receipt.verifyComplete = true;
          receipt.verifiedAt = Date.now();
          saveReceipt(deps, receipt);
          audit.succeeded([task.worktreePath]);
          return { structuredContent: ok({ taskId, data: { state: "DONE" }, hint: `任务 ${taskId} 部署验证通过，DONE。` }) };
        }

        audit = beginToolAudit(deps, taskId, "grande_deploy_verify", { taskId, verifyRef: actionRef(spec.verify) });
        const result = await executeAction(deps, tools, task, spec.verify, "verify");
        if (result.complete) {
          receipt.verifyComplete = true;
          receipt.verifiedAt = Date.now();
          saveReceipt(deps, receipt);
          audit.succeeded([task.worktreePath]);
          return { structuredContent: ok({ taskId, data: { state: "DONE" }, hint: `任务 ${taskId} 部署验证通过，DONE。` }) };
        }

        receipt.verifyJobId = result.jobId;
        saveReceipt(deps, receipt);
        audit.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: { state: "verifying", jobId: result.jobId },
            hint: `验证 profile 已启动（job ${result.jobId}）；稍后再次调用 grande_deploy_verify。`,
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failedEnvelope(deps, taskId, error);
      }
    },
  };

  const rollbackTool: ToolDef = {
    name: "grande_deploy_rollback",
    description:
      "调用 repo 在 .grande/deploy.yaml 里【已有声明】的 rollback profile/capability。" +
      "GrandeGPT 不生成通用 rollback 机制，也不接受任意 rollback command。",
    inputSchema: taskSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      const taskId = args.taskId as string;
      let audit: AuditHandle | undefined;
      try {
        const task = taskOrThrow(deps, taskId);
        const spec = loadDeploymentSpec(task.worktreePath);
        if (!spec.rollback) throw new StateError("INVALID_INPUT", "repo 没有声明 rollback；不会猜一个通用回滚方案。 ");
        const receipt = loadReceipt(deps, taskId);
        if (!receipt) throw new StateError("INVALID_INPUT", "没有 deployment receipt，拒绝脱离真实部署记录单独 rollback。 ");
        ensureReceiptMatches(receipt, spec);

        audit = beginToolAudit(deps, taskId, "grande_deploy_rollback", { taskId, rollbackRef: actionRef(spec.rollback) });
        const result = await executeAction(deps, tools, task, spec.rollback, "rollback");
        if (result.jobId) receipt.rollbackJobId = result.jobId;
        if (result.complete) receipt.rolledBackAt = Date.now();
        saveReceipt(deps, receipt);
        audit.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: {
              state: result.complete ? "rolled-back" : "rolling-back",
              ...(result.jobId ? { jobId: result.jobId } : {}),
            },
            hint: result.complete ? "已有平台 rollback 已完成。" : `rollback profile 已启动（job ${result.jobId}）。`,
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failedEnvelope(deps, taskId, error);
      }
    },
  };

  return [deployTool, verifyTool, rollbackTool];
}

export function addDeploymentTools(
  deps: ToolDeps,
  tools: ToolDef[],
  options: DeploymentToolOptions = {},
): ToolDef[] {
  return [...tools, ...createDeploymentTools(deps, tools, options)];
}
