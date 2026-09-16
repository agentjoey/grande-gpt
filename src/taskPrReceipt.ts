import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";

const SHA_RE = /^[0-9a-f]{40}$/u;

export interface TaskPrReceipt {
  taskId: string;
  prNumber: number;
  prUrl: string;
  headSha: string | null;
  baseRef: string | null;
  baseSha: string | null;
  mergeSha: string | null;
  openedAt: number;
  mergedAt: number | null;
  updatedAt: number;
}

export interface TaskPrOpenedInput {
  taskId: string;
  prNumber: number;
  prUrl: string;
  headSha: string | null;
  baseRef: string | null;
  baseSha: string | null;
}

export interface TaskPrMergedInput extends Omit<TaskPrOpenedInput, "headSha" | "baseRef"> {
  headSha: string;
  baseRef: string;
  mergeSha: string;
}

function assertSha(value: string, field: string): void {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new StateError("INVALID_INPUT", `${field} 必须是 40 位十六进制 SHA。`);
  }
}

function validateOpened(input: TaskPrOpenedInput): void {
  if (!input.taskId) throw new StateError("INVALID_INPUT", "taskId 不能为空。");
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    throw new StateError("INVALID_INPUT", "prNumber 必须是正整数。");
  }
  if (!input.prUrl) throw new StateError("INVALID_INPUT", "prUrl 不能为空。");
  if (input.headSha !== null) assertSha(input.headSha, "headSha");
  if (input.baseRef !== null && input.baseRef.length === 0) {
    throw new StateError("INVALID_INPUT", "baseRef 不能是空字符串。");
  }
  if (input.baseSha !== null) assertSha(input.baseSha, "baseSha");
}

function row(value: unknown): TaskPrReceipt | null {
  if (!value) return null;
  return value as TaskPrReceipt;
}

function load(db: DatabaseSync, taskId: string): TaskPrReceipt | null {
  return row(db.prepare(
    `SELECT taskId,prNumber,prUrl,headSha,baseRef,baseSha,mergeSha,openedAt,mergedAt,updatedAt
       FROM task_pr_receipt WHERE taskId=?`,
  ).get(taskId));
}

function identityMismatch(existing: TaskPrReceipt, input: TaskPrOpenedInput): string | null {
  if (existing.prNumber !== input.prNumber) return "prNumber";
  if (existing.prUrl !== input.prUrl) return "prUrl";
  return null;
}

function mergedEvidenceMismatch(
  existing: TaskPrReceipt,
  input: TaskPrOpenedInput,
  allowBaseShaFill: boolean,
): string | null {
  if (input.headSha !== null && existing.headSha !== input.headSha) return "headSha";
  if (input.baseRef !== null && existing.baseRef !== input.baseRef) return "baseRef";
  if (
    input.baseSha !== null &&
    existing.baseSha !== input.baseSha &&
    !(allowBaseShaFill && existing.baseSha === null)
  ) return "baseSha";
  return null;
}

function upsertOpened(
  db: DatabaseSync,
  input: TaskPrOpenedInput,
  now: number,
  allowMergedBaseShaFill = false,
): TaskPrReceipt {
  validateOpened(input);
  const existing = load(db, input.taskId);
  if (!existing) {
    db.prepare(
      `INSERT INTO task_pr_receipt
         (taskId,prNumber,prUrl,headSha,baseRef,baseSha,mergeSha,openedAt,mergedAt,updatedAt)
       VALUES (?,?,?,?,?,?,NULL,?,NULL,?)`,
    ).run(
      input.taskId,
      input.prNumber,
      input.prUrl,
      input.headSha,
      input.baseRef,
      input.baseSha,
      now,
      now,
    );
    return load(db, input.taskId)!;
  }

  const identity = identityMismatch(existing, input);
  if (identity) {
    throw new StateError(
      "STALE_STATE",
      `task ${input.taskId} 的 PR identity 不可变；${identity} 与 durable receipt 不一致。`,
    );
  }

  if (existing.mergeSha !== null) {
    const mismatch = mergedEvidenceMismatch(existing, input, allowMergedBaseShaFill);
    if (mismatch) {
      throw new StateError(
        "STALE_STATE",
        `task ${input.taskId} 已 merged；exact ${mismatch} 证据不可变。`,
      );
    }
    if (allowMergedBaseShaFill && existing.baseSha === null && input.baseSha !== null) {
      db.prepare(
        "UPDATE task_pr_receipt SET baseSha=?, updatedAt=? WHERE taskId=? AND mergeSha IS NOT NULL AND baseSha IS NULL",
      ).run(input.baseSha, now, input.taskId);
      return load(db, input.taskId)!;
    }
    return existing;
  }

  // PR 未 merge 前，head/base 是「当前观测值」而不是 immutable identity：CI 修复后
  // 同一 PR 可以继续 push，base 也可能前进或被显式 retarget。null 不清空已有证据。
  const nextHeadSha = input.headSha ?? existing.headSha;
  const nextBaseRef = input.baseRef ?? existing.baseRef;
  const nextBaseSha = input.baseSha ?? existing.baseSha;
  if (
    nextHeadSha !== existing.headSha ||
    nextBaseRef !== existing.baseRef ||
    nextBaseSha !== existing.baseSha
  ) {
    db.prepare(
      "UPDATE task_pr_receipt SET headSha=?, baseRef=?, baseSha=?, updatedAt=? WHERE taskId=? AND mergeSha IS NULL",
    ).run(nextHeadSha, nextBaseRef, nextBaseSha, now, input.taskId);
  }
  return load(db, input.taskId)!;
}

function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
}

export function readTaskPrReceipt(db: DatabaseSync, taskId: string): TaskPrReceipt | null {
  return load(db, taskId);
}

export function recordTaskPrOpened(
  db: DatabaseSync,
  input: TaskPrOpenedInput,
  now = Date.now(),
): TaskPrReceipt {
  return transaction(db, () => upsertOpened(db, input, now));
}

export function recordTaskPrMerged(
  db: DatabaseSync,
  input: TaskPrMergedInput,
  now = Date.now(),
): TaskPrReceipt {
  validateOpened(input);
  // Types do not validate runtime inputs: a merge milestone cannot contain unknown head/base.
  assertSha(input.headSha, "headSha");
  if (typeof input.baseRef !== "string" || input.baseRef.trim().length === 0) {
    throw new StateError("INVALID_INPUT", "merged receipt 必须包含非空 baseRef。");
  }
  assertSha(input.mergeSha, "mergeSha");
  return transaction(db, () => {
    const opened = upsertOpened(db, input, now, true);
    if (opened.mergeSha !== null) {
      if (opened.mergeSha !== input.mergeSha) {
        throw new StateError(
          "STALE_STATE",
          `task ${input.taskId} 的 merge evidence 不可变；已有 mergeSha=${opened.mergeSha}。`,
        );
      }
      return opened;
    }
    db.prepare(
      "UPDATE task_pr_receipt SET mergeSha=?, mergedAt=?, updatedAt=? WHERE taskId=? AND mergeSha IS NULL",
    ).run(input.mergeSha, now, now, input.taskId);
    return load(db, input.taskId)!;
  });
}
