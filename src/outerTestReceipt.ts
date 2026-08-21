import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import { GitExecError, safeGit } from "./gitExec.ts";
import type { RunnableHostVerificationLevel } from "./hostVerification.ts";
import { getJob } from "./jobs.ts";
import { getTask } from "./tasks.ts";

export interface OuterTestReceiptV1 {
  taskId: string;
  commit: string;
  profile: string;
  files: string[];
  passedAt: number;
}

/** Backward-compatible public name for the pre-V2 manual receipt. */
export type OuterTestReceipt = OuterTestReceiptV1;

export interface HostVerifierResourceLimits {
  wallTimeoutMs: number;
  maxRssMb: number;
  maxOutputBytes: number;
}

export interface HostToolchainIdentity {
  node: string;
  pnpm: string;
  lockfileSha256: string;
}

export interface OuterTestReceiptV2 {
  version: 2;
  mode: "manual" | "auto";
  taskId: string;
  repoId: string;
  commit: string;
  level: RunnableHostVerificationLevel;
  profile: string;
  files: string[];
  planDigest: string;
  jobId: string;
  startedAt: number;
  endedAt: number;
  hostToolchain: HostToolchainIdentity;
}

export type AnyOuterTestReceipt = OuterTestReceiptV1 | OuterTestReceiptV2;

export interface OuterTestPlanDigestInput {
  level: RunnableHostVerificationLevel;
  files: readonly string[];
  policyVersion: number;
  resourceLimits: HostVerifierResourceLimits;
  loopbackPorts: readonly number[];
}

export interface TrustedFinalizedHostVerifierJob extends OuterTestPlanDigestInput {
  trustedVerifier: true;
  state: "passed";
  mode: "manual" | "auto";
  taskId: string;
  repoId: string;
  commit: string;
  profile: string;
  jobId: string;
  startedAt: number;
  endedAt: number;
  hostToolchain: HostToolchainIdentity;
}

export interface TrustedHostVerifierSummary extends OuterTestPlanDigestInput {
  kind: "host-verifier-v2";
  mode: "manual" | "auto";
  repoId: string;
  commit: string;
  hostToolchain: HostToolchainIdentity;
}

export interface OuterTestReceiptExpectation {
  taskId: string;
  repoId: string;
  commit: string;
  requiredLevel: RunnableHostVerificationLevel;
  planDigest: string;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validToolchain(value: unknown): value is HostToolchainIdentity {
  if (!value || typeof value !== "object") return false;
  const toolchain = value as Partial<HostToolchainIdentity>;
  return typeof toolchain.node === "string" && toolchain.node.length > 0
    && typeof toolchain.pnpm === "string" && toolchain.pnpm.length > 0
    && typeof toolchain.lockfileSha256 === "string" && /^[0-9a-f]{64}$/u.test(toolchain.lockfileSha256);
}

function validFiles(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((file) => typeof file === "string" && file.length > 0);
}

function validLimits(value: unknown): value is HostVerifierResourceLimits {
  if (!value || typeof value !== "object") return false;
  const limits = value as Partial<HostVerifierResourceLimits>;
  return finitePositive(limits.wallTimeoutMs)
    && finitePositive(limits.maxRssMb)
    && finitePositive(limits.maxOutputBytes);
}

function validPorts(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length <= 8
    && value.every((port) => Number.isInteger(port) && port >= 1 && port <= 65_535)
    && new Set(value).size === value.length;
}

function validTrustedSummary(value: unknown): value is TrustedHostVerifierSummary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<TrustedHostVerifierSummary>;
  return summary.kind === "host-verifier-v2"
    && (summary.mode === "manual" || summary.mode === "auto")
    && typeof summary.repoId === "string" && summary.repoId.length > 0
    && typeof summary.commit === "string" && summary.commit.length > 0
    && (summary.level === "smoke" || summary.level === "full")
    && validFiles(summary.files)
    && Number.isInteger(summary.policyVersion) && (summary.policyVersion ?? 0) > 0
    && validLimits(summary.resourceLimits)
    && validPorts(summary.loopbackPorts)
    && validToolchain(summary.hostToolchain);
}

function validV1(value: unknown, taskId: string): value is OuterTestReceiptV1 {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<OuterTestReceiptV1>;
  return receipt.taskId === taskId
    && typeof receipt.commit === "string" && receipt.commit.length > 0
    && typeof receipt.profile === "string" && receipt.profile.length > 0
    && Array.isArray(receipt.files) && receipt.files.every((file) => typeof file === "string")
    && typeof receipt.passedAt === "number" && Number.isFinite(receipt.passedAt);
}

function validV2(value: unknown, taskId: string): value is OuterTestReceiptV2 {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<OuterTestReceiptV2>;
  return receipt.version === 2
    && (receipt.mode === "manual" || receipt.mode === "auto")
    && receipt.taskId === taskId
    && typeof receipt.repoId === "string" && receipt.repoId.length > 0
    && typeof receipt.commit === "string" && receipt.commit.length > 0
    && (receipt.level === "smoke" || receipt.level === "full")
    && typeof receipt.profile === "string" && receipt.profile.length > 0
    && validFiles(receipt.files)
    && typeof receipt.planDigest === "string" && /^sha256:[0-9a-f]{64}$/u.test(receipt.planDigest)
    && typeof receipt.jobId === "string" && receipt.jobId.length > 0
    && finitePositive(receipt.startedAt)
    && finitePositive(receipt.endedAt)
    && receipt.endedAt >= receipt.startedAt
    && validToolchain(receipt.hostToolchain);
}

export function computeOuterTestPlanDigest(input: OuterTestPlanDigestInput): string {
  if (input.level !== "smoke" && input.level !== "full") throw new Error("host verification level must be smoke or full");
  if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1) throw new Error("host verifier policy version must be positive");
  const files = [...input.files];
  if (!validFiles(files)) throw new Error("host verifier plan files must be non-empty strings");
  const ports = [...input.loopbackPorts];
  if (!validPorts(ports)) throw new Error("invalid host verifier loopback ports");
  if (!validLimits(input.resourceLimits)) throw new Error("invalid host verifier resource limits");
  const { wallTimeoutMs, maxRssMb, maxOutputBytes } = input.resourceLimits;
  const normalized = {
    files: files.sort(),
    level: input.level,
    loopbackPorts: ports.sort((a, b) => a - b),
    policyVersion: input.policyVersion,
    resourceLimits: { maxOutputBytes, maxRssMb, wallTimeoutMs },
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

export function parseOuterTestReceipt(json: string, taskId: string): AnyOuterTestReceipt | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (validV2(value, taskId)) return value;
    if (validV1(value, taskId)) return value;
    return null;
  } catch {
    return null;
  }
}

/**
 * V2 is the only auto-eligible format. V1 may be accepted only by an explicit
 * manual-transition caller while manual mode remains the trusted fallback.
 */
export function isOuterTestReceiptEligible(
  receipt: AnyOuterTestReceipt,
  expected: OuterTestReceiptExpectation,
  options: { allowLegacyManualTransition?: boolean } = {},
): boolean {
  if (!("version" in receipt)) {
    return options.allowLegacyManualTransition === true
      && receipt.taskId === expected.taskId
      && receipt.commit === expected.commit;
  }
  const sufficientLevel = receipt.level === "full" || receipt.level === expected.requiredLevel;
  return receipt.taskId === expected.taskId
    && receipt.repoId === expected.repoId
    && receipt.commit === expected.commit
    && receipt.planDigest === expected.planDigest
    && sufficientLevel;
}

/**
 * Parent-only V2 constructor. It accepts one trusted finalized verifier record,
 * not caller-selected receipt fields/stdout/artifacts/env.
 */
export function recordTrustedOuterTestPassV2(job: TrustedFinalizedHostVerifierJob): OuterTestReceiptV2 {
  if (job.trustedVerifier !== true) throw new Error("trusted verifier job required");
  if (job.state !== "passed") throw new Error("final passed verifier job required");
  if (!finitePositive(job.startedAt) || !finitePositive(job.endedAt) || job.endedAt < job.startedAt) {
    throw new Error("final verifier timestamps required");
  }
  if (!validToolchain(job.hostToolchain)) throw new Error("trusted host toolchain identity required");
  const files = [...job.files].sort();
  const planDigest = computeOuterTestPlanDigest({
    level: job.level,
    files,
    policyVersion: job.policyVersion,
    resourceLimits: job.resourceLimits,
    loopbackPorts: job.loopbackPorts,
  });
  return {
    version: 2,
    mode: job.mode,
    taskId: job.taskId,
    repoId: job.repoId,
    commit: job.commit,
    level: job.level,
    profile: job.profile,
    files,
    planDigest,
    jobId: job.jobId,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    hostToolchain: { ...job.hostToolchain },
  };
}

/**
 * Persist a V2 receipt only from a real terminal DB job. The caller supplies no
 * receipt fields beyond taskId/jobId; the trusted execution plan is reconstructed
 * from the parent-written job summary.
 */
export function persistTrustedOuterTestPassV2(
  db: DatabaseSync,
  taskId: string,
  jobId: string,
): OuterTestReceiptV2 {
  const task = getTask(db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  const job = getJob(db, jobId);
  if (!job) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
  if (job.taskId !== taskId) throw new StateError("STALE_STATE", "verifier job task binding mismatch");
  if (job.state !== "passed" || job.exitCode !== 0 || job.endedAt === null) {
    throw new StateError("POLICY_DENIED", "only a terminal passed verifier job can issue a V2 receipt");
  }
  if (job.profile !== "host-verifier") throw new StateError("POLICY_DENIED", "trusted host verifier profile required");
  if (!validTrustedSummary(job.summary)) throw new StateError("POLICY_DENIED", "trusted host verifier summary required");
  if (job.summary.repoId !== task.repoId) throw new StateError("STALE_STATE", "verifier repo binding mismatch");

  const receipt = recordTrustedOuterTestPassV2({
    trustedVerifier: true,
    state: "passed",
    mode: job.summary.mode,
    taskId,
    repoId: job.summary.repoId,
    commit: job.summary.commit,
    level: job.summary.level,
    profile: job.profile,
    files: job.summary.files,
    policyVersion: job.summary.policyVersion,
    resourceLimits: job.summary.resourceLimits,
    loopbackPorts: job.summary.loopbackPorts,
    jobId,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    hostToolchain: job.summary.hostToolchain,
  });

  db.prepare(
    `INSERT INTO outer_test_receipt (taskId,receiptJson,updatedAt)
     VALUES (?,?,?)
     ON CONFLICT(taskId) DO UPDATE SET receiptJson=excluded.receiptJson, updatedAt=excluded.updatedAt`,
  ).run(taskId, JSON.stringify(receipt), receipt.endedAt);
  return receipt;
}

/**
 * 读取最近一次 host outer-test receipt。损坏/未知格式 receipt 一律按不存在处理：
 * merge gate 必须 fail closed，不能让不可解析的本机状态替当前 SHA 背书。
 */
export function getOuterTestReceipt(db: DatabaseSync, taskId: string): AnyOuterTestReceipt | null {
  const row = db.prepare("SELECT receiptJson FROM outer_test_receipt WHERE taskId=?").get(taskId) as
    | { receiptJson: string }
    | undefined;
  return row ? parseOuterTestReceipt(row.receiptJson, taskId) : null;
}

export function hasCurrentOuterTestReceipt(db: DatabaseSync, taskId: string, commit: string): boolean {
  return getOuterTestReceipt(db, taskId)?.commit === commit;
}

function assertTaskWorktree(db: DatabaseSync, taskId: string, worktreePath: string): void {
  const task = getTask(db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  if (task.worktreePath !== worktreePath) {
    throw new StateError("INVALID_INPUT", `任务 ${taskId} 的 worktree 与 outer-test 验收目标不一致。`);
  }
}

function gitDetail(error: unknown): string {
  if (error instanceof GitExecError) return error.message.replace(/^git failed:\s*/u, "");
  return error instanceof Error ? error.message : String(error);
}

function readCleanHead(taskId: string, worktreePath: string): string {
  let status: string;
  try {
    status = safeGit.local(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  } catch (error) {
    throw new StateError("INVALID_INPUT", `检查 outer-test task worktree 失败：${gitDetail(error)}`);
  }
  if (status.trim().length > 0) {
    throw new StateError(
      "POLICY_DENIED",
      `任务 ${taskId} 的 worktree 有未提交变化；拒绝为当前 HEAD 签发 outer-test receipt。`,
    );
  }

  try {
    return safeGit.local(worktreePath, ["rev-parse", "HEAD"]).trim();
  } catch (error) {
    throw new StateError("INVALID_INPUT", `读取 outer-test task HEAD 失败：${gitDetail(error)}`);
  }
}

/** host outer-test 启动前锁定一个 clean task HEAD；成功后必须仍是同一 SHA。 */
export function prepareOuterTestRun(db: DatabaseSync, taskId: string, worktreePath: string): string {
  assertTaskWorktree(db, taskId, worktreePath);
  return readCleanHead(taskId, worktreePath);
}

/**
 * Transitional V1 manual receipt writer. C3 will route manual outer-test through
 * the same restricted verifier and V2 path; until then this preserves the proven
 * exact-clean-HEAD manual fallback.
 */
export function recordOuterTestPass(
  db: DatabaseSync,
  taskId: string,
  worktreePath: string,
  profile: string,
  files: string[],
  passedAt = Date.now(),
  expectedCommit?: string,
): OuterTestReceiptV1 {
  assertTaskWorktree(db, taskId, worktreePath);
  const commit = readCleanHead(taskId, worktreePath);
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new StateError(
      "STALE_STATE",
      `任务 ${taskId} 的 HEAD 在 outer-test 运行期间从 ${expectedCommit} 变化为 ${commit}；拒绝签发 receipt。`,
    );
  }

  const receipt: OuterTestReceiptV1 = { taskId, commit, profile, files: [...files], passedAt };
  db.prepare(
    `INSERT INTO outer_test_receipt (taskId,receiptJson,updatedAt)
     VALUES (?,?,?)
     ON CONFLICT(taskId) DO UPDATE SET receiptJson=excluded.receiptJson, updatedAt=excluded.updatedAt`,
  ).run(taskId, JSON.stringify(receipt), passedAt);
  return receipt;
}
