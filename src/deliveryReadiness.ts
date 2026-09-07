import type { DatabaseSync } from "node:sqlite";
import { beginAudit } from "./audit.ts";
import {
  APPROVAL_TTL_MS,
  activeAuthorizationForTask,
  bindingDigestOf,
  createAuthorization,
  transitionAuthorization,
  type AuthorizationStages,
  type AuthorizationStatus,
  type DeliveryAuthorizationBinding,
} from "./deliveryAuthorization.ts";
import { StateError } from "./errors.ts";
import { listJobs, TERMINAL } from "./jobs.ts";
import { getExplicitDeliveryTarget } from "./taskDeliveryTarget.ts";
import { getTask, type TaskRow } from "./tasks.ts";

/**
 * Minimal V2 Task 3：exact readiness 与 immutable authorization binding。
 * 设计来源：docs/superpowers/specs/2026-09-04-...-design.md §7/§8。
 *
 * 安全不变量：
 * - 所有 readiness 证据都经由注入的 deps 从【可信控制平面 reader】读取；本模块
 *   不接受 repo 内容、请求体或 Agent 自报的任何字段。计划列出的六个 reader
 *   之外增加 `readWorktreeState` 与 `readRuntimeIdentity`：worktree 状态与
 *   runtime/tool identity 同样必须可注入，测试才能独立 vary 这些维度。
 * - preparation 零外部副作用：不 mutate GitHub、canonical、deployment 或
 *   worktree。任何条件不满足时只抛 blocker——delivery_authorization 表保持
 *   为空，账本里不出现成功的 grande_delivery_prepare 记录。
 * - binding 恰好包含规格 §8.1 的字段，digest 走 deliveryAuthorization.ts 的
 *   canonical JSON + SHA-256；任何字段漂移都改变 digest，旧 authorization 在
 *   revalidate 时被置为 STALE，本次请求零执行。
 * - proposal 创建经现有审计账本记录（grande_delivery_prepare），input 只含
 *   {taskId, bindingDigest} 的摘要——不写 nonce、不写明文 binding JSON；
 *   stale/expire 事件同样落账（grande_delivery_revalidate）。
 */

export interface DeliveryReadinessDeps {
  /** 现查当前 PR：number/baseRef/baseSha/headSha/state，绝不缓存。 */
  readPullRequest(taskId: string): Promise<{
    number: number;
    baseRef: string;
    baseSha: string;
    headSha: string;
    state: "open" | "closed";
  }>;
  /** current head SHA 的 required CI 三态。 */
  readRequiredCi(taskId: string, headSha: string): Promise<"success" | "pending" | "failed">;
  /** 精确绑定 headSha 的本机 attestation；没有返回 null。 */
  readAttestation(taskId: string, headSha: string): { commit: string; jobId: string } | null;
  /** 精确绑定 headSha 的 V2 Host verification receipt；没有/不合格返回 null。 */
  readHostVerification(taskId: string, headSha: string): { commit: string; jobId: string; planDigest: string } | null;
  /** `git merge-tree --write-tree <baseSha> <headSha>` 的唯一 tree identity；失败即 blocker。 */
  computeExpectedMergeTree(repoId: string, baseSha: string, headSha: string): string;
  /**
   * 可信 action resolver：deployTarget 必须由它按 profile/capability 注册与已绑定参数
   * 规范化得到；deploySpecDigest/policyDigest 只覆盖本次交付真正引用的可信记录。
   */
  resolveDeployAction(taskId: string): {
    deployTarget: string;
    deployRef: string;
    verifyRef: string;
    deploySpecDigest: string;
    policyDigest: string;
  };
  /** 任务 worktree 的本机状态（realpath 需已 canonical 化）。 */
  readWorktreeState(taskId: string): { headSha: string; clean: boolean; realpath: string };
  /** Gateway runtime build 与 toolset identity（toolsetIdentity.ts 同源）。 */
  readRuntimeIdentity(): { runtimeBuild: string; toolsetEpoch: number; toolsDigest: string };
}

export interface PreparedDeliveryAuthorization {
  state: "READY";
  authorizationId: string;
  bindingDigest: string;
  expiresAt: number;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** deployTarget 是 resolver 规范化后的稳定 identity，有长度与字符边界，不是自由文本。 */
const TARGET_RE = /^[\x20-\x7e]{1,200}$/;

const TERMINAL_STATUSES: ReadonlySet<AuthorizationStatus> = new Set([
  "REJECTED",
  "REVOKED",
  "STALE",
  "EXPIRED",
  "SUCCEEDED",
  "FAILED",
  "UNCERTAIN",
]);

function blocked(code: string, message: string): never {
  throw new StateError(code, `delivery readiness blocked：${message}`);
}

interface BindingEvidence {
  task: TaskRow;
  worktree: { headSha: string; clean: boolean; realpath: string };
  pr: { number: number; baseRef: string; baseSha: string; headSha: string; state: "open" | "closed" };
  action: {
    deployTarget: string;
    deployRef: string;
    verifyRef: string;
    deploySpecDigest: string;
    policyDigest: string;
  };
  expectedMergeTree: string;
  runtime: { runtimeBuild: string; toolsetEpoch: number; toolsDigest: string };
}

/**
 * 只读取 binding 需要的证据，不做就绪裁决——prepare 与 revalidate 共用同一份
 * 读取路径，保证「创建时绑定的值」与「复核时重算的值」来自同一组可信来源。
 */
async function readBindingEvidence(
  db: DatabaseSync,
  taskId: string,
  deps: DeliveryReadinessDeps,
): Promise<BindingEvidence> {
  const task = getTask(db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  const worktree = deps.readWorktreeState(taskId);
  const pr = await deps.readPullRequest(taskId);
  const action = deps.resolveDeployAction(taskId);
  const expectedMergeTree = deps.computeExpectedMergeTree(task.repoId, pr.baseSha, pr.headSha);
  const runtime = deps.readRuntimeIdentity();
  return { task, worktree, pr, action, expectedMergeTree, runtime };
}

/** 用规格 §8.1 的精确字段集构造 delivery binding（键序由 canonical digest 兜底）。 */
function buildBinding(
  taskId: string,
  evidence: BindingEvidence,
  createdAt: number,
): DeliveryAuthorizationBinding {
  return {
    authorizationKind: "delivery",
    taskId,
    repoId: evidence.task.repoId,
    worktreeRealpath: evidence.worktree.realpath,
    deliveryTarget: "deploy",
    deployTarget: evidence.action.deployTarget,
    deploySpecDigest: evidence.action.deploySpecDigest,
    policyDigest: evidence.action.policyDigest,
    runtimeBuild: evidence.runtime.runtimeBuild,
    toolsetEpoch: evidence.runtime.toolsetEpoch,
    toolsDigest: evidence.runtime.toolsDigest,
    createdAt,
    expiresAt: createdAt + APPROVAL_TTL_MS,
    prNumber: evidence.pr.number,
    baseRef: evidence.pr.baseRef,
    baseSha: evidence.pr.baseSha,
    headSha: evidence.pr.headSha,
    mergeMethod: "merge",
    expectedMergeTree: evidence.expectedMergeTree,
    deployRef: evidence.action.deployRef,
    verifyRef: evidence.action.verifyRef,
  };
}

function assertSha(value: string, field: string): void {
  if (!SHA_RE.test(value)) {
    blocked("INVALID_INPUT", `${field} 不是 40 位十六进制 SHA（收到 ${JSON.stringify(value)}），拒绝绑定不精确的身份。`);
  }
}

function assertDigest(value: string, field: string): void {
  if (!DIGEST_RE.test(value)) {
    blocked("POLICY_DENIED", `可信 resolver 返回的 ${field} 不是 sha256:<64hex>（收到 ${JSON.stringify(value)}）。`);
  }
}

/**
 * 规格 §7.2 的就绪条件全集。任何一条不满足都只抛 blocker：不写
 * delivery_authorization、不落成功审计、不产生任何外部副作用。
 */
async function assertReady(
  db: DatabaseSync,
  taskId: string,
  deps: DeliveryReadinessDeps,
  evidence: BindingEvidence,
): Promise<void> {
  if (getExplicitDeliveryTarget(db, taskId) !== "deploy") {
    blocked(
      "POLICY_DENIED",
      `任务 ${taskId} 没有显式且不可变的 deliveryTarget=deploy（Task 1）；` +
        "local/pr 任务不进入 production approval flow，也不能凭证据投影自动升级。",
    );
  }
  const running = listJobs(db, taskId).filter((job) => !TERMINAL.has(job.state));
  if (running.length > 0) {
    throw new StateError(
      "JOB_RUNNING",
      `delivery readiness blocked：任务 ${taskId} 仍有非终态 job（${running.map((job) => job.jobId).join("、")}）。`,
    );
  }

  const worktree = evidence.worktree;
  if (!worktree.clean) {
    throw new StateError("WORKTREE_DIRTY", `delivery readiness blocked：任务 ${taskId} 的 worktree 有未提交改动。`);
  }
  if (typeof worktree.realpath !== "string" || worktree.realpath.length === 0) {
    blocked("INVALID_INPUT", "worktree realpath 为空。");
  }

  const pr = evidence.pr;
  if (pr.state !== "open") {
    blocked("INVALID_INPUT", `PR #${pr.number} 当前 state=${pr.state}，不能准备交付授权。`);
  }
  assertSha(pr.headSha, "PR headSha");
  assertSha(pr.baseSha, "PR baseSha");
  if (typeof pr.baseRef !== "string" || pr.baseRef.trim().length === 0) {
    blocked("INVALID_INPUT", "PR baseRef 为空。");
  }
  if (pr.headSha !== worktree.headSha) {
    blocked(
      "STALE_STATE",
      `PR head=${pr.headSha} 与任务本地 HEAD=${worktree.headSha} 不一致；` +
        "旧 SHA 的 CI/attestation/Host 证据不能替新 SHA 背书。",
    );
  }

  const ci = await deps.readRequiredCi(taskId, pr.headSha);
  if (ci === "pending") blocked("STALE_STATE", `PR head ${pr.headSha} 的 required CI 仍在 pending。`);
  if (ci === "failed") blocked("INVALID_INPUT", `PR head ${pr.headSha} 的 required CI failed。`);

  const attestation = deps.readAttestation(taskId, pr.headSha);
  if (!attestation || attestation.commit !== pr.headSha) {
    blocked("POLICY_DENIED", `PR head ${pr.headSha} 没有精确绑定的本机 attestation。`);
  }
  const host = deps.readHostVerification(taskId, pr.headSha);
  if (!host || host.commit !== pr.headSha) {
    blocked("POLICY_DENIED", `PR head ${pr.headSha} 没有精确绑定的 Host verification receipt。`);
  }

  const action = evidence.action;
  if (
    typeof action.deployTarget !== "string" ||
    !TARGET_RE.test(action.deployTarget) ||
    action.deployTarget.trim().length === 0
  ) {
    blocked(
      "POLICY_DENIED",
      "deployTarget 缺失或形状非法：target identity 必须由可信 action resolver 规范化得到，不接受自由文本。",
    );
  }
  if (typeof action.deployRef !== "string" || action.deployRef.trim().length === 0) {
    blocked("POLICY_DENIED", "可信 resolver 返回的 deployRef 为空。");
  }
  if (typeof action.verifyRef !== "string" || action.verifyRef.trim().length === 0) {
    blocked("POLICY_DENIED", "可信 resolver 返回的 verifyRef 为空。");
  }
  assertDigest(action.deploySpecDigest, "deploySpecDigest");
  assertDigest(action.policyDigest, "policyDigest");

  assertSha(evidence.expectedMergeTree, "expectedMergeTree");

  const runtime = evidence.runtime;
  if (typeof runtime.runtimeBuild !== "string" || runtime.runtimeBuild.trim().length === 0) {
    blocked("INVALID_INPUT", "Gateway runtime build identity 缺失。");
  }
  if (!Number.isInteger(runtime.toolsetEpoch) || runtime.toolsetEpoch < 1) {
    blocked("INVALID_INPUT", `toolsetEpoch 必须是 ≥1 的整数，收到 ${JSON.stringify(runtime.toolsetEpoch)}。`);
  }
  if (!DIGEST_RE.test(runtime.toolsDigest)) {
    blocked("INVALID_INPUT", "toolsDigest 不是 sha256:<64hex>；toolset identity 不完整。");
  }
}

const INITIAL_STAGES: AuthorizationStages = {
  merge: { state: "pending" },
  deploy: { state: "pending" },
  verify: { state: "pending" },
};

/**
 * 规格 §7.2：全部就绪条件满足时创建恰好一条 READY proposal，并经现有审计账本
 * 记录一次成功的 grande_delivery_prepare（input 只有 {taskId, bindingDigest} 的
 * 摘要——不写 nonce，不写明文 binding JSON）。任何 blocker 都在写路径之前抛出。
 */
export async function prepareDeliveryAuthorization(
  db: DatabaseSync,
  taskId: string,
  deps: DeliveryReadinessDeps,
): Promise<PreparedDeliveryAuthorization> {
  const evidence = await readBindingEvidence(db, taskId, deps);
  await assertReady(db, taskId, deps, evidence);
  if (activeAuthorizationForTask(db, taskId)) {
    blocked(
      "STALE_STATE",
      `任务 ${taskId} 已存在活跃的 delivery authorization；须等其进入终态后才能创建新 proposal。`,
    );
  }

  const binding = buildBinding(taskId, evidence, Date.now());
  const digest = bindingDigestOf(binding);
  const audit = beginAudit(db, {
    taskId,
    tool: "grande_delivery_prepare",
    input: { taskId, bindingDigest: digest },
  });
  audit.allowed();
  if (!audit.executing()) {
    throw new StateError("STALE_STATE", `任务 ${taskId} 的 delivery prepare 审计句柄无法推进到 EXECUTING。`);
  }
  try {
    const row = createAuthorization(db, { kind: "delivery", taskId, binding, stages: INITIAL_STAGES });
    audit.succeeded([]); // preparation 无文件系统副作用
    return {
      state: "READY",
      authorizationId: row.authorizationId,
      bindingDigest: row.bindingDigest,
      expiresAt: row.expiresAt,
    };
  } catch (error) {
    audit.failed(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

interface StoredBindingRow {
  taskId: string;
  status: AuthorizationStatus;
  binding: DeliveryAuthorizationBinding;
  bindingDigest: string;
  stages: AuthorizationStages;
}

function loadDeliveryRow(db: DatabaseSync, authorizationId: string): StoredBindingRow {
  const raw = db
    .prepare("SELECT taskId,status,bindingJson,bindingDigest,stageJson FROM delivery_authorization WHERE authorizationId=?")
    .get(authorizationId) as Record<string, unknown> | undefined;
  if (!raw) {
    throw new StateError("AUTH_NOT_FOUND", `authorization ${authorizationId} 不存在。`);
  }
  const binding = JSON.parse(raw.bindingJson as string) as DeliveryAuthorizationBinding;
  if (binding.authorizationKind !== "delivery") {
    throw new StateError(
      "INVALID_INPUT",
      `authorization ${authorizationId} 是 kind=${binding.authorizationKind}；rollback proposal 不走 delivery readiness 复核。`,
    );
  }
  return {
    taskId: raw.taskId as string,
    status: raw.status as AuthorizationStatus,
    binding,
    bindingDigest: raw.bindingDigest as string,
    stages: JSON.parse(raw.stageJson as string) as AuthorizationStages,
  };
}

/**
 * stale/expire 是规格 §13 必须落账的事件：authorizationId/taskId/bindingDigest 进
 * 审计 input 摘要，不含 nonce/JWT。CAS 由 transitionAuthorization 承担。
 */
function markTerminal(
  db: DatabaseSync,
  row: StoredBindingRow,
  authorizationId: string,
  outcome: "STALE" | "EXPIRED",
  reason: string,
): void {
  const audit = beginAudit(db, {
    taskId: row.taskId,
    tool: "grande_delivery_revalidate",
    input: { authorizationId, bindingDigest: row.bindingDigest, outcome, taskId: row.taskId },
  });
  audit.allowed();
  if (!audit.executing()) {
    throw new StateError("STALE_STATE", `任务 ${row.taskId} 的 delivery revalidate 审计句柄无法推进到 EXECUTING。`);
  }
  try {
    transitionAuthorization(db, authorizationId, row.bindingDigest, row.status, outcome, row.stages, reason);
    audit.succeeded([]);
  } catch (error) {
    audit.failed(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * 复核 durable binding：从同一组可信来源重算全部 binding 字段（时间戳取 durable
 * 值，不复位审批有效期），比较 canonical digest。
 *
 * - 一致：返回 durable binding，状态不变；
 * - 任何字段漂移：CAS 置为 STALE（规格 §11，零执行）并抛 STALE_STATE；
 * - 已过审批有效期：CAS 置为 EXPIRED 并抛 AUTH_EXPIRED；
 * - 终态行不可再复核（STALE_STATE）。
 */
export async function revalidateDeliveryBinding(
  db: DatabaseSync,
  authorizationId: string,
  deps: DeliveryReadinessDeps,
): Promise<DeliveryAuthorizationBinding> {
  const row = loadDeliveryRow(db, authorizationId);
  if (TERMINAL_STATUSES.has(row.status)) {
    throw new StateError(
      "STALE_STATE",
      `authorization ${authorizationId} 已处于终态 ${row.status}，不能再复核。`,
    );
  }
  if (row.binding.expiresAt <= Date.now()) {
    markTerminal(db, row, authorizationId, "EXPIRED", "审批有效期已过（expiresAt 到达）。");
    throw new StateError(
      "AUTH_EXPIRED",
      `authorization ${authorizationId} 已过审批有效期，已置为 EXPIRED；需要新审批。`,
    );
  }

  const evidence = await readBindingEvidence(db, row.taskId, deps);
  const recomputed = buildBinding(row.taskId, evidence, row.binding.createdAt);
  if (bindingDigestOf(recomputed) !== row.bindingDigest) {
    markTerminal(db, row, authorizationId, "STALE", "trusted evidence 漂移，binding digest 不再匹配。");
    throw new StateError(
      "STALE_STATE",
      `authorization ${authorizationId} 的 binding 与当前可信证据不一致，已置为 STALE；本次请求零执行。`,
    );
  }
  return row.binding;
}
