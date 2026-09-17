import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { expireAuthorizationIfDue } from "./authorizationExpiry.ts";
import { StateError } from "./errors.ts";

/**
 * Minimal V2 Task 2：durable delivery authorization 与 forward-only CAS 状态机。
 * 设计来源：docs/superpowers/specs/2026-09-04-...-design.md §8。
 *
 * 安全不变量：
 * - binding 以 canonical JSON（对象键字典序）序列化，digest = sha256；任何字段漂移
 *   （head/base SHA、tree、target、policy、runtime build、toolset identity……）都改变
 *   digest，使旧 authorization 失配。
 * - approval nonce 至少 256 bit，由 challenge 在服务端生成，每次 challenge 轮换，
 *   库中只存 SHA-256 digest——明文 nonce 只出现在 challenge 的响应里。
 * - 审批有效期固定 15 分钟（APPROVAL_TTL_MS），进入 EXECUTING 后另有 60 分钟
 *   execution deadline（EXECUTION_TTL_MS）；两者都是固定常量，不接受配置。
 * - 所有状态转移都是带 expected status（+ binding digest / nonce digest）的单事务
 *   CAS；CAS 失败表示另一个请求已推进状态，本次请求零执行。
 * - approver 身份只来自调用方传入的、已由 Access 验证过的 identity，绝不从
 *   binding 或请求体的其他字段里读。
 */

export const APPROVAL_TTL_MS = 15 * 60_000;
export const EXECUTION_TTL_MS = 60 * 60_000;

export type AuthorizationKind = "delivery" | "rollback";
export type AuthorizationStatus =
  | "READY" | "APPROVED" | "EXECUTING"
  | "REJECTED" | "REVOKED" | "STALE" | "EXPIRED"
  | "SUCCEEDED" | "FAILED" | "UNCERTAIN";
export type AuthorizationStageState = "pending" | "running" | "succeeded" | "failed" | "uncertain";

export interface AuthorizationStages {
  merge?: { state: AuthorizationStageState; receiptId?: string };
  deploy?: { state: AuthorizationStageState; receiptId?: string; jobId?: string };
  verify?: { state: AuthorizationStageState; receiptId?: string; jobId?: string };
  rollback?: { state: AuthorizationStageState; receiptId?: string; jobId?: string };
}

export interface AuthorizationCommonBinding {
  authorizationKind: AuthorizationKind;
  taskId: string;
  repoId: string;
  worktreeRealpath: string;
  deliveryTarget: "deploy";
  deployTarget: string;
  deploySpecDigest: string;
  policyDigest: string;
  runtimeBuild: string;
  toolsetEpoch: number;
  toolsDigest: string;
  createdAt: number;
  expiresAt: number;
}

export interface DeliveryAuthorizationBinding extends AuthorizationCommonBinding {
  authorizationKind: "delivery";
  prNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  mergeMethod: "merge";
  expectedMergeTree: string;
  deployRef: string;
  verifyRef: string;
}

export interface RollbackAuthorizationBinding extends AuthorizationCommonBinding {
  authorizationKind: "rollback";
  currentDeploymentId: string;
  currentSourceSha: string;
  rollbackDeploymentId: string;
  rollbackSourceSha: string;
  rollbackArtifactDigest?: string;
  rollbackRef: string;
}

export type AuthorizationBinding = DeliveryAuthorizationBinding | RollbackAuthorizationBinding;

export interface DeliveryAuthorizationRow {
  authorizationId: string;
  kind: AuthorizationKind;
  taskId: string;
  binding: AuthorizationBinding;
  bindingDigest: string;
  status: AuthorizationStatus;
  stages: AuthorizationStages;
  expiresAt: number;
}

export interface CreateAuthorizationInput {
  kind: AuthorizationKind;
  taskId: string;
  binding: AuthorizationBinding;
  stages: AuthorizationStages;
  now?: number;
}

/** 已由 Console Access 验证过的审批人身份；绝不接受请求体自报的身份。 */
export interface ApprovalIdentity {
  sub: string;
  email: string;
}

export interface ApprovalRequest {
  authorizationId: string;
  bindingDigest: string;
  approvalNonce: string;
  identity: ApprovalIdentity;
  now?: number;
}

/** 状态机前向边（规格 §8.4）；终态没有出边，不可变。 */
const FORWARD: Readonly<Record<AuthorizationStatus, ReadonlySet<AuthorizationStatus>>> = {
  READY: new Set(["APPROVED", "REJECTED", "STALE", "EXPIRED"]),
  APPROVED: new Set(["EXECUTING", "REVOKED", "STALE", "EXPIRED"]),
  EXECUTING: new Set(["SUCCEEDED", "FAILED", "UNCERTAIN", "STALE", "EXPIRED"]),
  REJECTED: new Set(),
  REVOKED: new Set(),
  STALE: new Set(),
  EXPIRED: new Set(),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  UNCERTAIN: new Set(),
};

const ACTIVE_STATUSES = new Set<AuthorizationStatus>(["READY", "APPROVED", "EXECUTING"]);

/** canonical JSON：对象键递归按字典序排列，数组保持顺序。undefined 字段被省略。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** binding 的 canonical digest——所有精确性比较都走它，而不是逐字段比较。 */
export function bindingDigestOf(binding: AuthorizationBinding): string {
  return `sha256:${sha256hex(JSON.stringify(canonicalize(binding)))}`;
}

interface StoredRow extends DeliveryAuthorizationRow {
  nonceDigest: string | null;
  approverSub: string | null;
  approverEmail: string | null;
  approvedAt: number | null;
  executingAt: number | null;
  executionDeadlineAt: number | null;
}

function toRow(r: Record<string, unknown>): StoredRow {
  const binding = JSON.parse(r.bindingJson as string) as AuthorizationBinding;
  return {
    authorizationId: r.authorizationId as string,
    kind: r.kind as AuthorizationKind,
    taskId: r.taskId as string,
    binding,
    bindingDigest: r.bindingDigest as string,
    status: r.status as AuthorizationStatus,
    stages: JSON.parse(r.stageJson as string) as AuthorizationStages,
    expiresAt: binding.expiresAt,
    nonceDigest: (r.nonceDigest as string | null) ?? null,
    approverSub: (r.approverSub as string | null) ?? null,
    approverEmail: (r.approverEmail as string | null) ?? null,
    approvedAt: (r.approvedAt as number | null) ?? null,
    executingAt: (r.executingAt as number | null) ?? null,
    executionDeadlineAt: (r.executionDeadlineAt as number | null) ?? null,
  };
}

function publicRow(r: StoredRow): DeliveryAuthorizationRow {
  return {
    authorizationId: r.authorizationId,
    kind: r.kind,
    taskId: r.taskId,
    binding: r.binding,
    bindingDigest: r.bindingDigest,
    status: r.status,
    stages: r.stages,
    expiresAt: r.expiresAt,
  };
}

function loadRow(db: DatabaseSync, authorizationId: string): StoredRow {
  const r = db
    .prepare("SELECT * FROM delivery_authorization WHERE authorizationId=?")
    .get(authorizationId) as Record<string, unknown> | undefined;
  if (!r) {
    throw new StateError(
      "AUTH_NOT_FOUND",
      `authorization ${authorizationId} 不存在。`,
    );
  }
  return toRow(r);
}

/** 在已持有的写事务里执行一次 CAS 更新；影响行数不是 1 即并发失败，零执行抛错。 */
function casRun(db: DatabaseSync, sql: string, params: readonly (string | number | null)[]): void {
  const result = db.prepare(sql).run(...params);
  if (Number(result.changes) !== 1) {
    throw new StateError(
      "STALE_STATE",
      "CAS 失败：authorization 状态已被另一个请求推进，本次请求零执行。",
    );
  }
}

/** BEGIN IMMEDIATE 临界区包装：读 → 校验 → CAS 写收敛成一次写事务。 */
function inWriteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 连接可能已处于无法回滚的状态；原始错误才是调用方需要的信息。
    }
    throw error;
  }
}

/**
 * 创建 READY proposal。同一 task 最多一条 READY|APPROVED|EXECUTING（部分唯一索引
 * 兜底，这里先给出结构化错误）；旧行进入终态后以新 authorizationId 创建，保留审计历史。
 */
export function createAuthorization(
  db: DatabaseSync,
  input: CreateAuthorizationInput,
): DeliveryAuthorizationRow {
  const { binding } = input;
  if (input.kind !== "delivery" && input.kind !== "rollback") {
    throw new StateError("INVALID_INPUT", `未知 authorization kind：${JSON.stringify(input.kind)}。`);
  }
  if (binding.authorizationKind !== input.kind) {
    throw new StateError(
      "INVALID_INPUT",
      `kind ${JSON.stringify(input.kind)} 与 binding.authorizationKind ` +
        `${JSON.stringify(binding.authorizationKind)} 不一致。`,
    );
  }
  if (binding.taskId !== input.taskId) {
    throw new StateError("INVALID_INPUT", "binding.taskId 与 input.taskId 不一致。");
  }
  if (binding.deliveryTarget !== "deploy") {
    throw new StateError("INVALID_INPUT", 'V2 authorization 只服务 deliveryTarget="deploy"。');
  }
  // 审批有效期是固定 15 分钟的常量，不允许调用方自定时长。
  if (binding.expiresAt !== binding.createdAt + APPROVAL_TTL_MS) {
    throw new StateError(
      "INVALID_INPUT",
      `审批有效期必须恰好是 ${APPROVAL_TTL_MS}ms（createdAt+TTL），收到 expiresAt-createdAt=` +
        `${binding.expiresAt - binding.createdAt}ms。`,
    );
  }
  const now = input.now ?? Date.now();
  if (binding.expiresAt <= now) {
    throw new StateError("AUTH_EXPIRED", "authorization proposal 创建时已过期（expired）。");
  }
  // Converge only this task before admission. The insert transaction below rechecks
  // the active slot after any competing expiry, execution, or proposal creation.
  const previous = activeAuthorizationForTask(db, input.taskId);
  if (previous && (previous.status === "READY" || previous.status === "APPROVED") && previous.expiresAt <= now) {
    expireAuthorizationIfDue(db, previous.authorizationId, now);
  }
  const digest = bindingDigestOf(binding);
  const authorizationId = `authz_${randomUUID()}`;
  return inWriteTransaction(db, () => {
    const active = db
      .prepare(
        "SELECT authorizationId FROM delivery_authorization " +
          "WHERE taskId=? AND status IN ('READY','APPROVED','EXECUTING')",
      )
      .get(input.taskId) as { authorizationId: string } | undefined;
    if (active) {
      throw new StateError(
        "STALE_STATE",
        `任务 ${input.taskId} 已存在活跃 authorization ${active.authorizationId}；` +
          "须等其进入终态后才能创建新 proposal。",
      );
    }
    db.prepare(
      `INSERT INTO delivery_authorization
         (authorizationId,kind,taskId,bindingJson,bindingDigest,nonceDigest,status,
          approverSub,approverEmail,approvedAt,executingAt,executionDeadlineAt,
          stageJson,reason,createdAt,updatedAt)
       VALUES (?,?,?,?,?,NULL,'READY',NULL,NULL,NULL,NULL,NULL,?,?,?,?)`,
    ).run(
      authorizationId, input.kind, input.taskId,
      JSON.stringify(canonicalize(binding)), digest,
      JSON.stringify(input.stages), null, binding.createdAt, now,
    );
    return publicRow(loadRow(db, authorizationId));
  });
}

/**
 * 轮换一次性 challenge nonce：生成 ≥256 bit 随机数，库里只留 SHA-256 digest。
 * 明文 nonce 只通过返回值交给本次 challenge 的响应，不落库、不入日志。
 */
export function rotateAuthorizationChallenge(
  db: DatabaseSync,
  authorizationId: string,
  bindingDigest: string,
  now?: number,
): { row: DeliveryAuthorizationRow; approvalNonce: string } {
  const at = now ?? Date.now();
  return inWriteTransaction(db, () => {
    const row = loadRow(db, authorizationId);
    if (row.bindingDigest !== bindingDigest) {
      throw new StateError("STALE_STATE", "bindingDigest 与 durable authorization 不一致。");
    }
    if (row.status !== "READY") {
      throw new StateError(
        "STALE_STATE",
        `只有 READY 状态可以 challenge，当前状态 ${row.status}。`,
      );
    }
    if (row.expiresAt <= at) {
      throw new StateError("AUTH_EXPIRED", "authorization 已过审批有效期（expired），不能 challenge。");
    }
    const approvalNonce = randomBytes(32).toString("base64url");
    casRun(
      db,
      "UPDATE delivery_authorization SET nonceDigest=?, updatedAt=? " +
        "WHERE authorizationId=? AND status='READY' AND bindingDigest=?",
      [sha256hex(approvalNonce), at, authorizationId, bindingDigest],
    );
    return { row: publicRow(loadRow(db, authorizationId)), approvalNonce };
  });
}

function assertFreshAndMatchingNonce(row: StoredRow, input: ApprovalRequest): void {
  if (row.bindingDigest !== input.bindingDigest) {
    throw new StateError("STALE_STATE", "bindingDigest 与 durable authorization 不一致。");
  }
  const at = input.now ?? Date.now();
  if (row.expiresAt <= at) {
    throw new StateError("AUTH_EXPIRED", "authorization 已过审批有效期（expired）。");
  }
  if (row.nonceDigest === null || row.nonceDigest !== sha256hex(input.approvalNonce)) {
    throw new StateError("AUTH_NONCE", "approval nonce 不匹配或已被轮换。");
  }
}

/**
 * READY → APPROVED。审批成功后 nonce 即失效——同一请求的响应丢失重放（digest+nonce
 * 都与库中记录一致）只返回已存在的相同状态，不触发新的转移，更不会触发执行。
 */
export function approveAuthorization(
  db: DatabaseSync,
  input: ApprovalRequest,
): DeliveryAuthorizationRow {
  return inWriteTransaction(db, () => {
    const row = loadRow(db, input.authorizationId);
    if (row.status !== "READY") {
      // 重放只认 approve 自己产生的状态及其自然后继（EXECUTING）：零执行返回当前
      // 状态。REJECTED/REVOKED 等与本请求无关的终态不属于重放，必须抛错。
      if ((row.status === "APPROVED" || row.status === "EXECUTING") &&
          row.bindingDigest === input.bindingDigest &&
          row.nonceDigest !== null &&
          row.nonceDigest === sha256hex(input.approvalNonce)) {
        return publicRow(row);
      }
      throw new StateError(
        "STALE_STATE",
        `CAS 失败：authorization 已处于 ${row.status}，不能重复 approve。`,
      );
    }
    assertFreshAndMatchingNonce(row, input);
    const at = input.now ?? Date.now();
    casRun(
      db,
      "UPDATE delivery_authorization SET status='APPROVED', approverSub=?, approverEmail=?, " +
        "approvedAt=?, updatedAt=? " +
        "WHERE authorizationId=? AND status='READY' AND bindingDigest=? AND nonceDigest=?",
      [
        input.identity.sub, input.identity.email, at, at,
        input.authorizationId, input.bindingDigest, row.nonceDigest,
      ],
    );
    return publicRow(loadRow(db, input.authorizationId));
  });
}

/**
 * READY → REJECTED；尚未开始执行的 APPROVED → REVOKED（规格 §9.3）。
 * EXECUTING 及以后不可由 reject 撤销——已发生的 side effect 只能走运维路径。
 */
export function rejectAuthorization(
  db: DatabaseSync,
  input: ApprovalRequest,
): DeliveryAuthorizationRow {
  return inWriteTransaction(db, () => {
    const row = loadRow(db, input.authorizationId);
    if (row.status === "REJECTED" || row.status === "REVOKED") {
      if (row.bindingDigest === input.bindingDigest &&
          row.nonceDigest !== null &&
          row.nonceDigest === sha256hex(input.approvalNonce)) {
        return publicRow(row); // 重放：零执行返回同一终态。
      }
      throw new StateError("STALE_STATE", `authorization 已终态 ${row.status}。`);
    }
    if (row.status !== "READY" && row.status !== "APPROVED") {
      throw new StateError(
        "STALE_STATE",
        `CAS 失败：authorization 已处于 ${row.status}，reject 不能撤销。`,
      );
    }
    assertFreshAndMatchingNonce(row, input);
    const at = input.now ?? Date.now();
    casRun(
      db,
      "UPDATE delivery_authorization SET " +
        "status=CASE WHEN status='READY' THEN 'REJECTED' ELSE 'REVOKED' END, " +
        "approverSub=?, approverEmail=?, updatedAt=? " +
        "WHERE authorizationId=? AND status IN ('READY','APPROVED') AND bindingDigest=? AND nonceDigest=?",
      [
        input.identity.sub, input.identity.email, at,
        input.authorizationId, input.bindingDigest, row.nonceDigest,
      ],
    );
    return publicRow(loadRow(db, input.authorizationId));
  });
}

/**
 * APPROVED → EXECUTING：计划中第一个 side-effect stage 在任何外部 mutation 前调用。
 * 必须在审批有效期（expiresAt）前完成这次 CAS；进入 EXECUTING 后记录固定的 60 分钟
 * execution deadline。重复调用是 CAS 失败——side effect 只能被启动一次。
 */
export function beginAuthorizedExecution(
  db: DatabaseSync,
  authorizationId: string,
  kind: AuthorizationKind,
  bindingDigest: string,
  now?: number,
): DeliveryAuthorizationRow {
  const at = now ?? Date.now();
  return inWriteTransaction(db, () => {
    const row = loadRow(db, authorizationId);
    if (row.kind !== kind) {
      throw new StateError(
        "INVALID_INPUT",
        `authorization kind ${row.kind} 与调用 stage 要求的 ${kind} 不匹配。`,
      );
    }
    if (row.bindingDigest !== bindingDigest) {
      throw new StateError("STALE_STATE", "bindingDigest 与 durable authorization 不一致。");
    }
    if (row.status !== "APPROVED") {
      throw new StateError(
        "STALE_STATE",
        `CAS 失败：authorization 已处于 ${row.status}，不能从 APPROVED 启动执行。`,
      );
    }
    if (row.expiresAt <= at) {
      throw new StateError(
        "AUTH_EXPIRED",
        "authorization 已过审批有效期（expired），不能启动执行；需要新审批。",
      );
    }
    casRun(
      db,
      "UPDATE delivery_authorization SET status='EXECUTING', executingAt=?, " +
        "executionDeadlineAt=?, updatedAt=? " +
        "WHERE authorizationId=? AND status='APPROVED' AND bindingDigest=?",
      [at, at + EXECUTION_TTL_MS, at, authorizationId, bindingDigest],
    );
    return publicRow(loadRow(db, authorizationId));
  });
}

/**
 * 通用前向转移（EXECUTING → SUCCEEDED/FAILED/UNCERTAIN/STALE/EXPIRED 等）。
 * 只接受规格 §8.4 状态机里的合法边，且必须携带 expected current status 与
 * binding digest 做 SQLite CAS（§8.4）——digest 与 durable row 不符即 STALE_STATE，
 * 本次请求零执行，status/stageJson/reason 均不变。
 */
export function transitionAuthorization(
  db: DatabaseSync,
  authorizationId: string,
  bindingDigest: string,
  from: AuthorizationStatus,
  to: AuthorizationStatus,
  stages: AuthorizationStages,
  reason?: string,
): DeliveryAuthorizationRow {
  if (!FORWARD[from]?.has(to)) {
    throw new StateError("STALE_STATE", `非法状态转移（illegal state transition）：${from} → ${to}。`);
  }
  const at = Date.now();
  return inWriteTransaction(db, () => {
    const row = loadRow(db, authorizationId); // 不存在时抛 AUTH_NOT_FOUND
    if (row.bindingDigest !== bindingDigest) {
      throw new StateError("STALE_STATE", "bindingDigest 与 durable authorization 不一致。");
    }
    casRun(
      db,
      "UPDATE delivery_authorization SET status=?, stageJson=?, reason=?, updatedAt=? " +
        "WHERE authorizationId=? AND status=? AND bindingDigest=?",
      [to, JSON.stringify(stages), reason ?? null, at, authorizationId, from, bindingDigest],
    );
    return publicRow(loadRow(db, authorizationId));
  });
}

/** 同一 task 唯一（部分唯一索引保证）的非终态 authorization；没有则 undefined。 */
export function activeAuthorizationForTask(
  db: DatabaseSync,
  taskId: string,
): DeliveryAuthorizationRow | undefined {
  const r = db
    .prepare(
      "SELECT * FROM delivery_authorization " +
        "WHERE taskId=? AND status IN ('READY','APPROVED','EXECUTING') LIMIT 1",
    )
    .get(taskId) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  const row = toRow(r);
  if (!ACTIVE_STATUSES.has(row.status)) return undefined;
  return publicRow(row);
}
