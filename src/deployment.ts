import { createHash } from "node:crypto";
import { parse } from "yaml";
import { beginAudit, type AuditHandle } from "./audit.ts";
import {
  activeAuthorizationForTask,
  beginAuthorizedExecution,
  transitionAuthorization,
  type AuthorizationStageState,
  type DeliveryAuthorizationBinding,
  type DeliveryAuthorizationRow,
  type RollbackAuthorizationBinding,
} from "./deliveryAuthorization.ts";
import { readExactMergeReceipt, type ExactMergeReceipt } from "./deliveryMerge.ts";
import {
  assertEvidenceMatchesAuthorization,
  parseDeploymentEvidence,
  type DeploymentEvidence,
} from "./deliveryEvidence.ts";
import { startDeploymentHostJob, type StartedDeploymentHostJob } from "./deploymentHostRunner.ts";
import { err, ok } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import { getJob, TERMINAL } from "./jobs.ts";
import { getDeploymentProfile, type RunProfile } from "./profiles.ts";
import { MAX_REPO_READ_BYTES, repoRead } from "./repoFile.ts";
import { getExplicitDeliveryTarget } from "./taskDeliveryTarget.ts";
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
  /** Test seam only; production leaves this undefined and uses startDeploymentHostJob. */
  startHostProfile?: (args: { taskId: string; repoId: string; profileName: string }) => StartedDeploymentHostJob;
}

interface DeploymentReceipt {
  taskId: string;
  specDigest: string;
  mergeSha?: string;
  deployRef: string;
  verifyRef: string;
  rollbackRef?: string;
  deployComplete: boolean;
  /** D2: production capability may have committed remotely even if its response was lost. */
  deployUncertain?: boolean;
  deployJobId?: string;
  deployedAt?: number;
  verifyComplete: boolean;
  verifyJobId?: string;
  verifiedAt?: number;
  rollbackJobId?: string;
  rolledBackAt?: number;
  /** V2：authorization-gated capability 部署的 durable 证据。 */
  authorizationId?: string;
  merge?: { baseSha: string; headSha: string; mergeSha: string; mergeTree: string };
  deployEvidence?: DeploymentEvidence;
  verifyEvidence?: DeploymentEvidence;
  stages?: { deploy?: AuthorizationStageState; verify?: AuthorizationStageState; rollback?: AuthorizationStageState };
  /** V2 rollback：独立的 rollback authorization；绝不复用 delivery authorization。 */
  rollbackAuthorizationId?: string;
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

function assertProfileRole(
  deps: ToolDeps,
  task: TaskRow,
  action: DeploymentAction,
  role: "deploy" | "verify" | "rollback",
): RunProfile | undefined {
  if (action.kind !== "profile") return undefined;
  let profile: RunProfile;
  try {
    profile = getDeploymentProfile(deps.layout, task.repoId, action.profile);
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
  return profile;
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

async function invokeCapabilityAction(
  tools: ToolDef[],
  task: TaskRow,
  action: Extract<DeploymentAction, { kind: "capability" }>,
  role: "deploy" | "verify" | "rollback",
): Promise<Record<string, unknown>> {
  const invoke = toolByName(tools, "grande_capability_invoke");
  return unwrap(await invoke.handler({
    provider: action.provider,
    name: action.name,
    taskId: task.taskId,
    arguments: action.arguments,
  }), `${role} capability`);
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
  options: DeploymentToolOptions,
): Promise<ActionResult> {
  const profile = assertProfileRole(deps, task, action, role);
  await assertCapabilityRole(tools, action, role);

  if (action.kind === "profile") {
    if (profile?.execution === "deployment-host") {
      if (role === "rollback") {
        throw new StateError(
          "POLICY_DENIED",
          `deployment-host profile ${task.repoId}/${action.profile} 只允许 grande_deploy / grande_deploy_verify；rollback 不得使用 trusted host execution。`,
        );
      }
      const started = options.startHostProfile
        ? options.startHostProfile({ taskId: task.taskId, repoId: task.repoId, profileName: action.profile })
        : startDeploymentHostJob(
            { db: deps.db, layout: deps.layout },
            { taskId: task.taskId, repoId: task.repoId, profileName: action.profile },
          );
      return { complete: false, jobId: started.jobId };
    }

    const run = toolByName(tools, "grande_run");
    const data = unwrap(await run.handler({ taskId: task.taskId, profile: action.profile }), `${role} profile`);
    if (typeof data.jobId !== "string") throw new StateError("INVALID_INPUT", `${role} profile 未返回 jobId。`);
    return { complete: false, jobId: data.jobId };
  }

  await invokeCapabilityAction(tools, task, action, role);
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

function currentState(receipt: DeploymentReceipt): "uncertain" | "deploying" | "deployed" | "verifying" | "DONE" {
  if (receipt.deployUncertain) return "uncertain";
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

function baseReceipt(
  taskId: string,
  spec: DeploymentSpec,
  merged: { merged: boolean; mergeSha?: string },
): DeploymentReceipt {
  return {
    taskId,
    specDigest: digestSpec(spec),
    ...(merged.mergeSha ? { mergeSha: merged.mergeSha } : {}),
    deployRef: actionRef(spec.deploy)!,
    verifyRef: actionRef(spec.verify)!,
    ...(spec.rollback ? { rollbackRef: actionRef(spec.rollback) } : {}),
    deployComplete: false,
    verifyComplete: false,
  };
}

function uncertainDeployEnvelope(taskId: string, existing: boolean, deployRef: string) {
  return {
    structuredContent: ok({
      taskId,
      data: { state: "uncertain", existing, retryable: false, deployRef },
      hint: "production deploy capability 的响应未能确认。远端可能已经产生副作用；GrandeGPT 不会自动重试。Human Owner 必须先在部署平台确认真实状态，再决定后续动作。",
    }),
  };
}

/**
 * Minimal V2 Task 6 slice 3：deliveryTarget="deploy" 时 capability deploy/verify 走
 * authorization-gated 路径。legacy 路径（无显式 target 或 target!=="deploy"）完全不变。
 */
interface V2Context {
  auth: DeliveryAuthorizationRow;
  binding: DeliveryAuthorizationBinding;
  mergeReceipt: ExactMergeReceipt;
}

/**
 * 任何新的 capability deploy/verify side effect 之前的前置检查：
 * 同一 task 的活跃 delivery authorization 必须处于 EXECUTING；executionDeadlineAt 从
 * durable row 读且未过期；exact merge receipt 必须存在且 base/head/tree 与 binding
 * 逐字段一致；当前 spec 的 deploy/verify action ref 必须等于 binding 的 ref。
 * 任一不符都在 side effect 之前 fail closed（不改变 authorization 状态）。
 */
function requireV2Authorization(deps: ToolDeps, taskId: string, spec: DeploymentSpec): V2Context {
  const auth = activeAuthorizationForTask(deps.db, taskId);
  if (!auth || auth.kind !== "delivery" || auth.status !== "EXECUTING") {
    throw new StateError(
      "POLICY_DENIED",
      `任务 ${taskId} 没有处于 EXECUTING 的活跃 delivery authorization；拒绝 deploy/verify side effect。`,
    );
  }
  const row = deps.db
    .prepare("SELECT executionDeadlineAt FROM delivery_authorization WHERE authorizationId=?")
    .get(auth.authorizationId) as { executionDeadlineAt: number | null } | undefined;
  if (!row || typeof row.executionDeadlineAt !== "number" || row.executionDeadlineAt <= Date.now()) {
    throw new StateError(
      "AUTH_EXPIRED",
      `authorization ${auth.authorizationId} 已过 execution deadline；拒绝新的 side effect，需要新审批。`,
    );
  }
  const binding = auth.binding as DeliveryAuthorizationBinding;
  const mergeReceipt = readExactMergeReceipt(deps.layout, auth.authorizationId);
  if (!mergeReceipt) {
    throw new StateError(
      "POLICY_DENIED",
      `authorization ${auth.authorizationId} 缺少 exact merge receipt；merge 证据未落账前拒绝部署。`,
    );
  }
  if (
    mergeReceipt.baseSha !== binding.baseSha ||
    mergeReceipt.headSha !== binding.headSha ||
    mergeReceipt.mergeTree !== binding.expectedMergeTree
  ) {
    throw new StateError(
      "POLICY_DENIED",
      "exact merge receipt 的 base/head/tree 与 authorization binding 不一致；拒绝部署。",
    );
  }
  if (actionRef(spec.deploy) !== binding.deployRef || actionRef(spec.verify) !== binding.verifyRef) {
    throw new StateError(
      "POLICY_DENIED",
      "当前 .grande/deploy.yaml 的 deploy/verify action ref 与 authorization binding 不一致；拒绝执行。",
    );
  }
  return { auth, binding, mergeReceipt };
}

function v2Transition(
  deps: ToolDeps,
  auth: DeliveryAuthorizationRow,
  to: "SUCCEEDED" | "FAILED" | "UNCERTAIN",
  stage: "deploy" | "verify" | "rollback",
  state: AuthorizationStageState,
  reason: string,
): void {
  transitionAuthorization(
    deps.db,
    auth.authorizationId,
    auth.bindingDigest,
    "EXECUTING",
    to,
    { ...auth.stages, [stage]: { state } },
    reason,
  );
}

/** capability 的结构化结果里取证据；schema 校验失败等价于证据缺失/非法/有歧义。 */
function capabilityEvidence(result: Record<string, unknown>): DeploymentEvidence {
  return parseDeploymentEvidence(result.result);
}

/** V2 profile 证据只来自 deploymentHostRunner 落账的 job.summary.evidence，绝不是 stdout/stderr。 */
function evidenceFromJobSummary(job: { summary: Record<string, unknown> | null }): DeploymentEvidence {
  const summary = job.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new StateError("EVIDENCE_INVALID", "deployment-host job 缺少 durable summary；证据不可用。 ");
  }
  if (summary.evidenceError !== undefined) {
    const detail = summary.evidenceError as { code?: unknown; message?: unknown };
    throw new StateError(
      "EVIDENCE_INVALID",
      `deployment-host runner 证据错误（${typeof detail?.code === "string" ? detail.code : "unknown"}）：` +
        `${typeof detail?.message === "string" ? detail.message : "无详情"}`,
    );
  }
  return parseDeploymentEvidence(summary.evidence);
}

function assertSameAuthorization(ctx: V2Context, receipt: DeploymentReceipt): void {
  if (ctx.auth.authorizationId !== receipt.authorizationId) {
    throw new StateError(
      "POLICY_DENIED",
      "活跃 authorization 与 deployment receipt 不是同一条；拒绝继续。",
    );
  }
}

/**
 * 重入早退的 fail-closed 门禁：deployment receipt 只属于其落账时的 authorization。
 * 旧审批进终态后 Human 开了新审批时，旧 receipt（哪怕 DONE/failed/rolled-back）
 * 绝不能给新 authorization 背书——拒绝继续，而不是复用旧 receipt 谎报状态。无活跃
 * authorization 时（旧审批已终态、未开新审批），重入观察旧终态是合法幂等语义。
 * rollback 早退用 boundAuthorizationId=receipt.rollbackAuthorizationId 复用同一语义；
 * 错误消息刻意不带旧 authorization id，避免向新授权泄漏旧授权身份。
 */
function assertReceiptBoundToActiveAuthorization(
  deps: ToolDeps,
  taskId: string,
  receipt: DeploymentReceipt,
  boundAuthorizationId: string | undefined = receipt.authorizationId,
): void {
  const active = activeAuthorizationForTask(deps.db, taskId);
  if (active && active.authorizationId !== boundAuthorizationId) {
    throw new StateError(
      "STALE_STATE",
      "deployment receipt 是在另一条已终态的 authorization 下落账的，与当前活跃 authorization 不符；" +
        "拒绝复用旧 receipt 的早退结果。请开新 Task 重新部署。",
    );
  }
}

/** V2 只走 deployment-host runner（有受控证据通道）；普通 grande_run job 没有证据面。 */
function assertV2HostProfile(
  deps: ToolDeps,
  task: TaskRow,
  action: DeploymentAction,
  role: "deploy" | "verify",
): void {
  if (action.kind !== "profile") return;
  const profile = assertProfileRole(deps, task, action, role);
  if (profile?.execution !== "deployment-host") {
    throw new StateError(
      "INVALID_INPUT",
      `V2 ${role} profile ${task.repoId}/${action.profile} 必须 execution: deployment-host；` +
        "普通 job 没有受控证据通道。",
    );
  }
}

function startV2HostJob(
  deps: ToolDeps,
  task: TaskRow,
  profileName: string,
  options: DeploymentToolOptions,
): string {
  const started = options.startHostProfile
    ? options.startHostProfile({ taskId: task.taskId, repoId: task.repoId, profileName })
    : startDeploymentHostJob(
        { db: deps.db, layout: deps.layout },
        { taskId: task.taskId, repoId: task.repoId, profileName },
      );
  return started.jobId;
}

async function v2Deploy(
  deps: ToolDeps,
  tools: ToolDef[],
  task: TaskRow,
  spec: DeploymentSpec,
  options: DeploymentToolOptions,
): Promise<{ structuredContent: unknown }> {
  const taskId = task.taskId;
  const existing = loadReceipt(deps, taskId);
  if (existing) {
    ensureReceiptMatches(existing, spec);
    assertReceiptBoundToActiveAuthorization(deps, taskId, existing);
    if (existing.deployUncertain) return uncertainDeployEnvelope(taskId, true, existing.deployRef);
    return {
      structuredContent: ok({
        taskId,
        data: {
          state: existing.stages?.deploy === "failed" ? "failed" : currentState(existing),
          authorizationId: existing.authorizationId,
          existing: true,
          deployRef: existing.deployRef,
          ...(existing.deployJobId ? { jobId: existing.deployJobId } : {}),
        },
        hint: `任务 ${taskId} 已有同一 deploy spec 的 V2 receipt，未重复部署。`,
      }),
    };
  }

  const ctx = requireV2Authorization(deps, taskId, spec);
  if (spec.deploy.kind === "profile") {
    // V2 profile deploy：恰好一个 durable job；重入只观察，绝不重启（与 legacy 的
    // failed-job 重启语义不同——V2 的 job 失败只能由 verify 观察后把 authorization
    // 置为 FAILED）。
    assertV2HostProfile(deps, task, spec.deploy, "deploy");
    const jobId = startV2HostJob(deps, task, spec.deploy.profile, options);
    const receipt: DeploymentReceipt = {
      ...baseReceipt(taskId, spec, { merged: true, mergeSha: ctx.mergeReceipt.mergeSha }),
      authorizationId: ctx.auth.authorizationId,
      merge: {
        baseSha: ctx.mergeReceipt.baseSha,
        headSha: ctx.mergeReceipt.headSha,
        mergeSha: ctx.mergeReceipt.mergeSha,
        mergeTree: ctx.mergeReceipt.mergeTree,
      },
      stages: { deploy: "running", verify: "pending" },
      deployJobId: jobId,
    };
    saveReceipt(deps, receipt);
    return {
      structuredContent: ok({
        taskId,
        data: { state: "deploying", jobId, authorizationId: ctx.auth.authorizationId, deployRef: receipt.deployRef },
        hint: `V2 部署 profile 已启动（job ${jobId}）；稍后调用 grande_deploy_verify 观察 job 并校验证据。`,
      }),
    };
  }
  await assertCapabilityRole(tools, spec.deploy, "deploy");

  // Uncertainty-first：先落 deployUncertain 的 durable receipt 再 invoke——响应丢失
  // 绝不导致盲目重试。证据只来自 capability schema 校验后的结构化结果。
  const receipt: DeploymentReceipt = {
    ...baseReceipt(taskId, spec, { merged: true, mergeSha: ctx.mergeReceipt.mergeSha }),
    authorizationId: ctx.auth.authorizationId,
    merge: {
      baseSha: ctx.mergeReceipt.baseSha,
      headSha: ctx.mergeReceipt.headSha,
      mergeSha: ctx.mergeReceipt.mergeSha,
      mergeTree: ctx.mergeReceipt.mergeTree,
    },
    stages: { deploy: "running", verify: "pending" },
    deployUncertain: true,
  };
  saveReceipt(deps, receipt);

  const toUncertain = (reason: string) => {
    receipt.stages = { deploy: "uncertain", verify: "pending" };
    saveReceipt(deps, receipt);
    v2Transition(deps, ctx.auth, "UNCERTAIN", "deploy", "uncertain", reason);
    return uncertainDeployEnvelope(taskId, false, receipt.deployRef);
  };

  let result: Record<string, unknown>;
  try {
    result = await invokeCapabilityAction(tools, task, spec.deploy, "deploy");
  } catch (error) {
    return toUncertain(error instanceof Error ? error.message : String(error));
  }
  let evidence: DeploymentEvidence;
  try {
    evidence = capabilityEvidence(result);
  } catch (error) {
    return toUncertain(error instanceof Error ? error.message : String(error));
  }
  try {
    assertEvidenceMatchesAuthorization(evidence, {
      target: ctx.binding.deployTarget,
      sourceSha: ctx.mergeReceipt.mergeSha,
    });
  } catch (error) {
    receipt.deployUncertain = false;
    receipt.deployEvidence = evidence;
    receipt.stages = { deploy: "failed", verify: "pending" };
    saveReceipt(deps, receipt);
    v2Transition(deps, ctx.auth, "FAILED", "deploy", "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }

  receipt.deployUncertain = false;
  receipt.deployComplete = true;
  receipt.deployedAt = Date.now();
  receipt.deployEvidence = evidence;
  receipt.stages = { deploy: "succeeded", verify: "pending" };
  saveReceipt(deps, receipt);
  return {
    structuredContent: ok({
      taskId,
      data: { state: "deployed", authorizationId: ctx.auth.authorizationId, deployRef: receipt.deployRef, deployEvidence: evidence },
      hint: "V2 部署调用已完成且证据匹配 authorization；下一步 grande_deploy_verify。",
    }),
  };
}

async function v2Verify(
  deps: ToolDeps,
  tools: ToolDef[],
  task: TaskRow,
  spec: DeploymentSpec,
  options: DeploymentToolOptions,
): Promise<{ structuredContent: unknown }> {
  const taskId = task.taskId;
  const receipt = loadReceipt(deps, taskId);
  if (!receipt?.authorizationId) {
    throw new StateError("INVALID_INPUT", `任务 ${taskId} 没有 V2 deployment receipt；必须先 grande_deploy。`);
  }
  ensureReceiptMatches(receipt, spec);
  assertReceiptBoundToActiveAuthorization(deps, taskId, receipt);
  if (receipt.deployUncertain) return uncertainDeployEnvelope(taskId, true, receipt.deployRef);
  if (receipt.verifyComplete) {
    return { structuredContent: ok({ taskId, data: { state: "DONE", existing: true }, hint: `任务 ${taskId} 已部署并验证完成。` }) };
  }

  // profile deploy：观察 durable job。running 只报 pending；failed 置 FAILED 且绝不自动重启；
  // passed 只从 job.summary.evidence 取证据并重新校验身份。
  if (!receipt.deployComplete) {
    if (spec.deploy.kind !== "profile" || !receipt.deployJobId) {
      throw new StateError("INVALID_INPUT", "deployment receipt 缺少可观察的 deploy job/证据。 ");
    }
    const state = profileJobState(deps, task, receipt.deployJobId, spec.deploy.profile);
    if (state === "running") {
      return { structuredContent: ok({ taskId, data: { state: "deploying", jobId: receipt.deployJobId }, hint: "V2 部署 job 仍在运行。" }) };
    }
    const ctx = requireV2Authorization(deps, taskId, spec);
    assertSameAuthorization(ctx, receipt);
    if (state === "failed") {
      receipt.stages = { ...receipt.stages, deploy: "failed" };
      saveReceipt(deps, receipt);
      v2Transition(deps, ctx.auth, "FAILED", "deploy", "failed", `部署 job ${receipt.deployJobId} 未通过。`);
      throw new StateError("INVALID_INPUT", `V2 部署 job ${receipt.deployJobId} 未通过；authorization 已置 FAILED，绝不自动重试。`);
    }
    const job = getJob(deps.db, receipt.deployJobId)!;
    let evidence: DeploymentEvidence;
    try {
      evidence = evidenceFromJobSummary(job);
    } catch (error) {
      receipt.stages = { ...receipt.stages, deploy: "uncertain" };
      saveReceipt(deps, receipt);
      v2Transition(deps, ctx.auth, "UNCERTAIN", "deploy", "uncertain", error instanceof Error ? error.message : String(error));
      return uncertainDeployEnvelope(taskId, false, receipt.deployRef);
    }
    try {
      assertEvidenceMatchesAuthorization(evidence, {
        target: ctx.binding.deployTarget,
        sourceSha: ctx.mergeReceipt.mergeSha,
      });
    } catch (error) {
      receipt.deployEvidence = evidence;
      receipt.stages = { ...receipt.stages, deploy: "failed" };
      saveReceipt(deps, receipt);
      v2Transition(deps, ctx.auth, "FAILED", "deploy", "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
    receipt.deployComplete = true;
    receipt.deployedAt = Date.now();
    receipt.deployEvidence = evidence;
    receipt.stages = { ...receipt.stages, deploy: "succeeded" };
    saveReceipt(deps, receipt);
  }
  if (!receipt.deployEvidence) {
    throw new StateError("INVALID_INPUT", "deployment receipt 缺少 deployEvidence；不能 verify。 ");
  }

  // profile verify：同样的观察语义；证据还必须与 deployEvidence 四字段完全一致。
  if (spec.verify.kind === "profile") {
    if (receipt.verifyJobId) {
      const state = profileJobState(deps, task, receipt.verifyJobId, spec.verify.profile);
      if (state === "running") {
        return { structuredContent: ok({ taskId, data: { state: "verifying", jobId: receipt.verifyJobId }, hint: "V2 验证 job 仍在运行。" }) };
      }
      const ctx = requireV2Authorization(deps, taskId, spec);
      assertSameAuthorization(ctx, receipt);
      if (state === "failed") {
        receipt.stages = { ...receipt.stages, verify: "failed" };
        saveReceipt(deps, receipt);
        v2Transition(deps, ctx.auth, "FAILED", "verify", "failed", `验证 job ${receipt.verifyJobId} 未通过。`);
        throw new StateError("INVALID_INPUT", `V2 验证 job ${receipt.verifyJobId} 未通过；authorization 已置 FAILED，绝不自动重试。`);
      }
      const job = getJob(deps.db, receipt.verifyJobId)!;
      let evidence: DeploymentEvidence;
      try {
        evidence = evidenceFromJobSummary(job);
      } catch (error) {
        receipt.stages = { ...receipt.stages, verify: "uncertain" };
        saveReceipt(deps, receipt);
        v2Transition(deps, ctx.auth, "UNCERTAIN", "verify", "uncertain", error instanceof Error ? error.message : String(error));
        return uncertainDeployEnvelope(taskId, false, receipt.verifyRef);
      }
      const expected = receipt.deployEvidence;
      const identityMismatch =
        evidence.deploymentId !== expected.deploymentId ||
        evidence.target !== expected.target ||
        evidence.sourceSha !== expected.sourceSha ||
        (evidence.artifactDigest ?? null) !== (expected.artifactDigest ?? null);
      if (identityMismatch) {
        const error = new StateError(
          "EVIDENCE_MISMATCH",
          "verify evidence 的 deploymentId/target/sourceSha/artifactDigest 与 deployEvidence 不一致。",
        );
        receipt.verifyEvidence = evidence;
        receipt.stages = { ...receipt.stages, verify: "failed" };
        saveReceipt(deps, receipt);
        v2Transition(deps, ctx.auth, "FAILED", "verify", "failed", error.message);
        throw error;
      }
      receipt.verifyComplete = true;
      receipt.verifiedAt = Date.now();
      receipt.verifyEvidence = evidence;
      receipt.stages = { ...receipt.stages, verify: "succeeded" };
      saveReceipt(deps, receipt);
      transitionAuthorization(
        deps.db,
        ctx.auth.authorizationId,
        ctx.auth.bindingDigest,
        "EXECUTING",
        "SUCCEEDED",
        { ...ctx.auth.stages, deploy: { state: "succeeded" }, verify: { state: "succeeded" } },
      );
      return { structuredContent: ok({ taskId, data: { state: "DONE", authorizationId: ctx.auth.authorizationId, verifyEvidence: evidence }, hint: `任务 ${taskId} 部署验证通过，DONE。` }) };
    }

    const ctx = requireV2Authorization(deps, taskId, spec);
    assertSameAuthorization(ctx, receipt);
    assertV2HostProfile(deps, task, spec.verify, "verify");
    const jobId = startV2HostJob(deps, task, spec.verify.profile, options);
    receipt.verifyJobId = jobId;
    receipt.stages = { ...receipt.stages, verify: "running" };
    saveReceipt(deps, receipt);
    return {
      structuredContent: ok({
        taskId,
        data: { state: "verifying", jobId, authorizationId: ctx.auth.authorizationId },
        hint: `V2 验证 profile 已启动（job ${jobId}）；稍后再次调用 grande_deploy_verify。`,
      }),
    };
  }

  const ctx = requireV2Authorization(deps, taskId, spec);
  assertSameAuthorization(ctx, receipt);
  await assertCapabilityRole(tools, spec.verify, "verify");

  // Uncertainty-first 重入：stages.verify==="running" 只可能是上次调用在 invoke
  // 与结果落账之间崩溃留下的状态；远端副作用未知，置 UNCERTAIN 且绝不二次 invoke
  //（与 capability deploy 的 deployUncertain 先落账、rollback 的 running→UNCERTAIN 一致）。
  if (receipt.stages?.verify === "running") {
    receipt.stages = { ...receipt.stages, verify: "uncertain" };
    saveReceipt(deps, receipt);
    v2Transition(
      deps,
      ctx.auth,
      "UNCERTAIN",
      "verify",
      "uncertain",
      "capability verify 在 running 状态重入：上次调用结果未落账，远端副作用未知，绝不二次 invoke。",
    );
    return uncertainDeployEnvelope(taskId, true, receipt.verifyRef);
  }

  receipt.stages = { ...receipt.stages, verify: "running" };
  saveReceipt(deps, receipt);

  const toUncertain = (reason: string) => {
    receipt.stages = { ...receipt.stages, verify: "uncertain" };
    saveReceipt(deps, receipt);
    v2Transition(deps, ctx.auth, "UNCERTAIN", "verify", "uncertain", reason);
    return uncertainDeployEnvelope(taskId, false, receipt.verifyRef);
  };

  let result: Record<string, unknown>;
  try {
    result = await invokeCapabilityAction(tools, task, spec.verify, "verify");
  } catch (error) {
    return toUncertain(error instanceof Error ? error.message : String(error));
  }
  let evidence: DeploymentEvidence;
  try {
    evidence = capabilityEvidence(result);
  } catch (error) {
    return toUncertain(error instanceof Error ? error.message : String(error));
  }
  const expected = receipt.deployEvidence;
  const identityMismatch =
    evidence.deploymentId !== expected.deploymentId ||
    evidence.target !== expected.target ||
    evidence.sourceSha !== expected.sourceSha ||
    (evidence.artifactDigest ?? null) !== (expected.artifactDigest ?? null);
  if (identityMismatch) {
    const error = new StateError(
      "EVIDENCE_MISMATCH",
      "verify evidence 的 deploymentId/target/sourceSha/artifactDigest 与 deployEvidence 不一致。",
    );
    receipt.verifyEvidence = evidence;
    receipt.stages = { ...receipt.stages, verify: "failed" };
    saveReceipt(deps, receipt);
    v2Transition(deps, ctx.auth, "FAILED", "verify", "failed", error.message);
    throw error;
  }

  receipt.verifyComplete = true;
  receipt.verifiedAt = Date.now();
  receipt.verifyEvidence = evidence;
  receipt.stages = { ...receipt.stages, verify: "succeeded" };
  saveReceipt(deps, receipt);
  transitionAuthorization(
    deps.db,
    ctx.auth.authorizationId,
    ctx.auth.bindingDigest,
    "EXECUTING",
    "SUCCEEDED",
    { ...ctx.auth.stages, deploy: { state: "succeeded" }, verify: { state: "succeeded" } },
  );
  return { structuredContent: ok({ taskId, data: { state: "DONE", authorizationId: ctx.auth.authorizationId, verifyEvidence: evidence }, hint: `任务 ${taskId} 部署验证通过，DONE。` }) };
}

/**
 * Minimal V2 Task 6 slice 5：deliveryTarget="deploy" 时的 authorization-gated rollback。
 * legacy rollback（无显式 target）完全不变。
 */
const ROLLBACK_ID_ALIASES = new Set(["previous", "prev", "latest", "current", "last", "head"]);
const EXACT_SHA_RE = /^[0-9a-f]{40}$/;

/** rollback 目标身份必须是精确值；previous/prev/latest/current/last/head 等相对别名一律拒绝。 */
function assertExactRollbackTarget(binding: RollbackAuthorizationBinding): void {
  const id = binding.rollbackDeploymentId;
  if (typeof id !== "string" || id.trim() === "" || ROLLBACK_ID_ALIASES.has(id.trim().toLowerCase())) {
    throw new StateError(
      "INVALID_INPUT",
      `rollbackDeploymentId ${JSON.stringify(id)} 是相对别名或空值；V2 rollback 只接受精确 deploymentId。`,
    );
  }
  if (!EXACT_SHA_RE.test(binding.rollbackSourceSha)) {
    throw new StateError(
      "INVALID_INPUT",
      `rollbackSourceSha ${JSON.stringify(binding.rollbackSourceSha)} 不是精确 40 位小写十六进制；拒绝别名。`,
    );
  }
}

function uncertainRollbackEnvelope(taskId: string, existing: boolean, rollbackRef: string) {
  return {
    structuredContent: ok({
      taskId,
      data: { state: "uncertain", existing, retryable: false, rollbackRef },
      hint: "rollback capability 的响应未能确认。远端可能已经回滚；GrandeGPT 不会自动重试。Human Owner 必须先确认平台真实状态。",
    }),
  };
}

async function v2Rollback(
  deps: ToolDeps,
  tools: ToolDef[],
  task: TaskRow,
  spec: DeploymentSpec,
): Promise<{ structuredContent: unknown }> {
  const taskId = task.taskId;
  if (!spec.rollback) {
    throw new StateError("INVALID_INPUT", "repo 没有声明 rollback；不会猜一个通用回滚方案。 ");
  }
  const receipt = loadReceipt(deps, taskId);
  if (!receipt?.authorizationId) {
    throw new StateError("INVALID_INPUT", `任务 ${taskId} 没有 V2 deployment receipt；拒绝脱离真实部署记录单独 rollback。`);
  }
  ensureReceiptMatches(receipt, spec);
  const rollbackRef = actionRef(spec.rollback)!;

  // 终态/已有 rollback receipt 的幂等重入：只观察 durable receipt，绝不重试。
  if (receipt.rollbackAuthorizationId !== undefined) {
    // 与 v2Deploy/v2Verify 同源的绑定门禁：旧 rollback receipt 的早退结果
    // （succeeded/uncertain/failed）绝不能给新活跃 authorization 背书。
    assertReceiptBoundToActiveAuthorization(deps, taskId, receipt, receipt.rollbackAuthorizationId);
    const stage = receipt.stages?.rollback;
    if (stage === "succeeded") {
      return {
        structuredContent: ok({
          taskId,
          data: { state: "rolled-back", existing: true, rollbackAuthorizationId: receipt.rollbackAuthorizationId },
          hint: "rollback 已完成；同一 receipt 幂等返回。",
        }),
      };
    }
    if (stage === "uncertain") return uncertainRollbackEnvelope(taskId, true, rollbackRef);
    if (stage === "failed") {
      throw new StateError("POLICY_DENIED", "rollback 已置 FAILED；绝不自动重试。 ");
    }
    // stage "running"：首次调用在 invoke 后响应丢失。允许 EXECUTING 重入观察同一条
    // durable receipt，但绝不第二次 invoke——按 lost result 置 UNCERTAIN。
    const auth = activeAuthorizationForTask(deps.db, taskId);
    if (!auth || auth.authorizationId !== receipt.rollbackAuthorizationId || auth.status !== "EXECUTING") {
      throw new StateError("POLICY_DENIED", "rollback receipt 处于 running，但同一条 rollback authorization 不在 EXECUTING；拒绝继续。 ");
    }
    const row = deps.db
      .prepare("SELECT executionDeadlineAt FROM delivery_authorization WHERE authorizationId=?")
      .get(auth.authorizationId) as { executionDeadlineAt: number | null } | undefined;
    if (!row || typeof row.executionDeadlineAt !== "number" || row.executionDeadlineAt <= Date.now()) {
      throw new StateError("AUTH_EXPIRED", `rollback authorization ${auth.authorizationId} 已过 execution deadline。`);
    }
    receipt.stages = { ...receipt.stages, rollback: "uncertain" };
    saveReceipt(deps, receipt);
    transitionAuthorization(
      deps.db, auth.authorizationId, auth.bindingDigest, "EXECUTING", "UNCERTAIN",
      { ...auth.stages, rollback: { state: "uncertain" } },
      "rollback invoke 响应丢失；按 lost result 处理。",
    );
    return uncertainRollbackEnvelope(taskId, false, rollbackRef);
  }

  const auth = activeAuthorizationForTask(deps.db, taskId);
  if (!auth) {
    throw new StateError("POLICY_DENIED", `任务 ${taskId} 没有活跃 authorization；V2 rollback 需要独立审批。`);
  }
  if (auth.kind === "delivery") {
    throw new StateError(
      "POLICY_DENIED",
      `活跃 authorization ${auth.authorizationId} 是 delivery kind；rollback 必须使用独立的 rollback authorization，绝不复用 delivery 授权。`,
    );
  }
  const binding = auth.binding as RollbackAuthorizationBinding;

  if (auth.status !== "APPROVED") {
    throw new StateError(
      "POLICY_DENIED",
      `rollback authorization 状态 ${auth.status}；只有 APPROVED 可以启动首次 rollback，EXECUTING 仅用于重入观察同一条 receipt。`,
    );
  }
  if (!receipt.deployEvidence) {
    throw new StateError("INVALID_INPUT", "deployment receipt 缺少 deployEvidence；rollback 没有可绑定的精确当前身份。 ");
  }
  if (
    binding.currentDeploymentId !== receipt.deployEvidence.deploymentId ||
    binding.currentSourceSha !== receipt.deployEvidence.sourceSha
  ) {
    throw new StateError(
      "POLICY_DENIED",
      "binding 的 currentDeploymentId/currentSourceSha 与 durable deployEvidence 不一致；拒绝 rollback。",
    );
  }
  if (rollbackRef !== binding.rollbackRef) {
    throw new StateError(
      "POLICY_DENIED",
      `当前 spec rollback ref ${rollbackRef} 与 binding.rollbackRef ${binding.rollbackRef} 不一致；拒绝执行。`,
    );
  }
  assertExactRollbackTarget(binding);
  if (spec.rollback.kind !== "capability") {
    throw new StateError("INVALID_INPUT", "V2 rollback 当前只支持 capability rollback；profile job 不在本 slice。 ");
  }
  await assertCapabilityRole(tools, spec.rollback, "rollback");

  // 审批有效期由 beginAuthorizedExecution 内部检查；通过后立即进入 EXECUTING 并记录
  // execution deadline，随后才发生第一个外部 rollback side effect。
  const executing = beginAuthorizedExecution(deps.db, auth.authorizationId, "rollback", auth.bindingDigest);
  receipt.rollbackAuthorizationId = auth.authorizationId;
  receipt.stages = { ...receipt.stages, rollback: "running" };
  saveReceipt(deps, receipt);

  const toUncertain = (reason: string) => {
    receipt.stages = { ...receipt.stages, rollback: "uncertain" };
    saveReceipt(deps, receipt);
    v2Transition(deps, executing, "UNCERTAIN", "rollback", "uncertain", reason);
    return uncertainRollbackEnvelope(taskId, false, rollbackRef);
  };

  let result: Record<string, unknown>;
  try {
    result = await invokeCapabilityAction(tools, task, spec.rollback, "rollback");
  } catch (error) {
    return toUncertain(error instanceof Error ? error.message : String(error));
  }
  let evidence: DeploymentEvidence;
  try {
    evidence = capabilityEvidence(result);
  } catch (error) {
    return toUncertain(error instanceof Error ? error.message : String(error));
  }
  try {
    assertEvidenceMatchesAuthorization(evidence, {
      target: binding.deployTarget,
      sourceSha: binding.rollbackSourceSha,
      ...(binding.rollbackArtifactDigest !== undefined ? { artifactDigest: binding.rollbackArtifactDigest } : {}),
    });
    if (evidence.deploymentId !== binding.rollbackDeploymentId) {
      throw new StateError("EVIDENCE_MISMATCH", "rollback evidence 的 deploymentId 与 binding.rollbackDeploymentId 不一致。");
    }
  } catch (error) {
    receipt.stages = { ...receipt.stages, rollback: "failed" };
    saveReceipt(deps, receipt);
    v2Transition(deps, executing, "FAILED", "rollback", "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }

  receipt.rolledBackAt = Date.now();
  receipt.stages = { ...receipt.stages, rollback: "succeeded" };
  saveReceipt(deps, receipt);
  transitionAuthorization(
    deps.db, auth.authorizationId, auth.bindingDigest, "EXECUTING", "SUCCEEDED",
    { ...auth.stages, rollback: { state: "succeeded" } },
  );
  return {
    structuredContent: ok({
      taskId,
      data: { state: "rolled-back", rollbackAuthorizationId: auth.authorizationId, rollbackEvidence: evidence },
      hint: "V2 rollback 完成，rollback authorization 已置 SUCCEEDED。",
    }),
  };
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
        if (getExplicitDeliveryTarget(deps.db, taskId) === "deploy") {
          return await v2Deploy(deps, tools, task, spec, options);
        }
        const existing = loadReceipt(deps, taskId);
        if (existing) {
          ensureReceiptMatches(existing, spec);
          if (existing.deployUncertain) {
            return uncertainDeployEnvelope(taskId, true, existing.deployRef);
          }
          const retryFailedProfileDeploy =
            spec.deploy.kind === "profile" &&
            !existing.deployComplete &&
            existing.deployJobId !== undefined &&
            profileJobState(deps, task, existing.deployJobId, spec.deploy.profile) === "failed";
          if (!retryFailedProfileDeploy) {
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
        }

        const merged = await (options.requireMerged
          ? options.requireMerged(taskId)
          : defaultRequireMerged(tools, taskId));
        if (!merged.merged) {
          throw new StateError("POLICY_DENIED", `任务 ${taskId} 的 PR 尚未 merge，拒绝部署。`);
        }

        audit = beginToolAudit(deps, taskId, "grande_deploy", { taskId, specDigest: digestSpec(spec) });

        if (spec.deploy.kind === "capability") {
          // Validate the approved production capability before persisting intent. Once
          // invocation can begin, persist uncertainty first: a crash/timeout after the
          // remote side effect but before the response must never cause a blind retry.
          await assertCapabilityRole(tools, spec.deploy, "deploy");
          const receipt = { ...baseReceipt(taskId, spec, merged), deployUncertain: true };
          saveReceipt(deps, receipt);
          try {
            await invokeCapabilityAction(tools, task, spec.deploy, "deploy");
          } catch (error) {
            audit.failed(error instanceof Error ? error.message : String(error));
            return uncertainDeployEnvelope(taskId, false, receipt.deployRef);
          }
          receipt.deployUncertain = false;
          receipt.deployComplete = true;
          receipt.deployedAt = Date.now();
          saveReceipt(deps, receipt);
          audit.succeeded([task.worktreePath]);
          return {
            structuredContent: ok({
              taskId,
              data: { state: "deployed", deployRef: receipt.deployRef },
              hint: "部署调用已完成；下一步 grande_deploy_verify。",
            }),
          };
        }

        const result = await executeAction(deps, tools, task, spec.deploy, "deploy", options);
        const receipt: DeploymentReceipt = {
          ...baseReceipt(taskId, spec, merged),
          deployComplete: result.complete,
          ...(result.jobId ? { deployJobId: result.jobId } : {}),
          ...(result.complete ? { deployedAt: Date.now() } : {}),
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
              ? "部署调用已完成；下一步 grande_deploy_verify。"
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
        if (getExplicitDeliveryTarget(deps.db, taskId) === "deploy") {
          return await v2Verify(deps, tools, task, spec, options);
        }
        const receipt = loadReceipt(deps, taskId);
        if (!receipt) {
          throw new StateError("INVALID_INPUT", `任务 ${taskId} 没有 deployment receipt；必须先 grande_deploy。`);
        }
        ensureReceiptMatches(receipt, spec);
        if (receipt.deployUncertain) {
          return uncertainDeployEnvelope(taskId, true, receipt.deployRef);
        }

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
        const result = await executeAction(deps, tools, task, spec.verify, "verify", options);
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
        if (getExplicitDeliveryTarget(deps.db, taskId) === "deploy") {
          return await v2Rollback(deps, tools, task, spec);
        }
        if (!spec.rollback) throw new StateError("INVALID_INPUT", "repo 没有声明 rollback；不会猜一个通用回滚方案。 ");
        const receipt = loadReceipt(deps, taskId);
        if (!receipt) throw new StateError("INVALID_INPUT", "没有 deployment receipt，拒绝脱离真实部署记录单独 rollback。 ");
        ensureReceiptMatches(receipt, spec);
        if (receipt.deployUncertain) {
          throw new StateError(
            "POLICY_DENIED",
            "deployment 外部状态尚未确认；不会自动 rollback 一个可能成功、也可能未执行的 deployment。Human Owner 必须先确认平台真实状态。",
          );
        }

        audit = beginToolAudit(deps, taskId, "grande_deploy_rollback", { taskId, rollbackRef: actionRef(spec.rollback) });
        const result = await executeAction(deps, tools, task, spec.rollback, "rollback", options);
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
