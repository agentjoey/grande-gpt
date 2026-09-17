import type { DatabaseSync } from "node:sqlite";
import { beginAudit } from "./audit.ts";
import type { AuthorizationBinding, AuthorizationStatus } from "./deliveryAuthorization.ts";
import { StateError } from "./errors.ts";

export interface AuthorizationExpiryReconciliationResult {
  expired: number;
}

interface CandidateRow {
  authorizationId: string;
  taskId: string;
  bindingJson: string;
  bindingDigest: string;
  status: AuthorizationStatus;
}

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
      // Preserve the original failure.
    }
    throw error;
  }
}

function expiresAtOf(row: CandidateRow): number {
  const binding = JSON.parse(row.bindingJson) as AuthorizationBinding;
  return binding.expiresAt;
}

/**
 * Expire one approval-TTL row if and only if it is still READY/APPROVED and due.
 * The state CAS and successful audit event share one SQLite transaction.
 */
export function expireAuthorizationIfDue(
  db: DatabaseSync,
  authorizationId: string,
  now = Date.now(),
  auditTool = "grande_authorization_expiry_reconcile",
): boolean {
  return inWriteTransaction(db, () => {
    const current = db
      .prepare(
        "SELECT authorizationId,taskId,bindingJson,bindingDigest,status " +
          "FROM delivery_authorization WHERE authorizationId=?",
      )
      .get(authorizationId) as CandidateRow | undefined;
    if (!current) return false;
    if (current.status !== "READY" && current.status !== "APPROVED") return false;
    const expiresAt = expiresAtOf(current);
    if (expiresAt > now) return false;

    const auditInput = auditTool === "grande_delivery_revalidate"
      ? {
          authorizationId: current.authorizationId,
          bindingDigest: current.bindingDigest,
          outcome: "EXPIRED",
          taskId: current.taskId,
        }
      : {
          authorizationId: current.authorizationId,
          taskId: current.taskId,
          bindingDigest: current.bindingDigest,
          fromStatus: current.status,
          outcome: "EXPIRED",
          expiresAt,
        };
    const audit = beginAudit(db, {
      taskId: current.taskId,
      tool: auditTool,
      input: auditInput,
    });
    if (!audit.allowed() || !audit.executing()) {
      throw new StateError("STALE_STATE", "authorization expiry audit 无法原子推进到 EXECUTING。");
    }

    const update = db.prepare(
      "UPDATE delivery_authorization SET status='EXPIRED', reason=?, updatedAt=? " +
        "WHERE authorizationId=? AND status=? AND bindingDigest=?",
    ).run(
      "approval authorization expired",
      now,
      current.authorizationId,
      current.status,
      current.bindingDigest,
    );
    if (Number(update.changes) !== 1) {
      throw new StateError(
        "STALE_STATE",
        "CAS 失败：authorization 已被另一个请求推进，本次 expiry reconciliation 零执行。",
      );
    }
    if (!audit.succeeded([])) {
      throw new StateError("STALE_STATE", "authorization expiry audit 无法原子终结为 SUCCEEDED。");
    }
    return true;
  });
}

/**
 * Converge approval-TTL expiry for READY / APPROVED rows only.
 * A stale candidate, EXECUTING row, or not-yet-expired row is a no-op.
 */
export function reconcileExpiredAuthorizations(
  db: DatabaseSync,
  now = Date.now(),
): AuthorizationExpiryReconciliationResult {
  const candidates = db
    .prepare(
      "SELECT authorizationId,bindingJson FROM delivery_authorization " +
        "WHERE status IN ('READY','APPROVED') ORDER BY createdAt ASC, rowid ASC",
    )
    .all() as unknown as Array<Pick<CandidateRow, "authorizationId" | "bindingJson">>;

  let expired = 0;
  for (const candidate of candidates) {
    const expiresAt = (JSON.parse(candidate.bindingJson) as AuthorizationBinding).expiresAt;
    if (expiresAt > now) continue;
    if (expireAuthorizationIfDue(db, candidate.authorizationId, now)) expired++;
  }

  return { expired };
}
