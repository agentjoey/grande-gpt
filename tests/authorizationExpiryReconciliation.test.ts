import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { reconcileExpiredAuthorizations } from "../src/authorizationExpiry.ts";
import { openDb } from "../src/db.ts";
import {
  APPROVAL_TTL_MS,
  activeAuthorizationForTask,
  approveAuthorization,
  beginAuthorizedExecution,
  createAuthorization,
  rotateAuthorizationChallenge,
  type ApprovalRequest,
  type DeliveryAuthorizationBinding,
} from "../src/deliveryAuthorization.ts";
import { StateError } from "../src/errors.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";

const NOW = 1_900_000_000_000;

let root: string;
let db: DatabaseSync;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  root = mkdtempSync(join(tmpdir(), "auth-expiry-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  const layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
});

afterEach(() => {
  db.close();
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(root, { recursive: true, force: true });
});

function setupTask(taskId: string): void {
  createTask(db, {
    taskId,
    repoId: "demo",
    branch: `grande/${taskId}`,
    baseCommit: "base",
    worktreePath: join(root, taskId),
    state: "READY",
  });
}

function binding(taskId: string, createdAt = NOW): DeliveryAuthorizationBinding {
  return {
    authorizationKind: "delivery",
    taskId,
    repoId: "demo",
    worktreeRealpath: join(root, taskId),
    deliveryTarget: "deploy",
    deployTarget: "prod",
    deploySpecDigest: `sha256:${"1".repeat(64)}`,
    policyDigest: `sha256:${"2".repeat(64)}`,
    runtimeBuild: "build-1",
    toolsetEpoch: 1,
    toolsDigest: `sha256:${"3".repeat(64)}`,
    createdAt,
    expiresAt: createdAt + APPROVAL_TTL_MS,
    prNumber: 1,
    baseRef: "main",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    mergeMethod: "merge",
    expectedMergeTree: "t".repeat(40),
    deployRef: "profile:deploy-prod",
    verifyRef: "profile:verify-prod",
  };
}

function createReady(taskId: string, createdAt = NOW) {
  setupTask(taskId);
  return createAuthorization(db, {
    kind: "delivery",
    taskId,
    binding: binding(taskId, createdAt),
    stages: { merge: { state: "pending" } },
    now: createdAt,
  });
}

function approve(taskId: string) {
  const auth = createReady(taskId);
  const { approvalNonce } = rotateAuthorizationChallenge(db, auth.authorizationId, auth.bindingDigest, NOW + 1);
  const request: ApprovalRequest = {
    authorizationId: auth.authorizationId,
    bindingDigest: auth.bindingDigest,
    approvalNonce,
    identity: { sub: "user-1", email: "user-1@example.com" },
    now: NOW + 2,
  };
  approveAuthorization(db, request);
  return { auth, request };
}

function status(authorizationId: string): string {
  const row = db.prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
    .get(authorizationId) as { status: string };
  return row.status;
}

function expiryAudits(taskId: string) {
  return listAudit(db, taskId, 100).filter((row) => row.tool === "grande_authorization_expiry_reconcile");
}

describe("authorization expiry convergence", () => {
  it("READY 与 APPROVED 在 expiresAt <= now 时 CAS 收敛为 EXPIRED，并各写一次成功 audit", () => {
    const ready = createReady("task-expiry-ready");
    const approved = approve("task-expiry-approved").auth;

    const result = reconcileExpiredAuthorizations(db, NOW + APPROVAL_TTL_MS);

    expect(result.expired).toBe(2);
    expect(status(ready.authorizationId)).toBe("EXPIRED");
    expect(status(approved.authorizationId)).toBe("EXPIRED");
    expect(activeAuthorizationForTask(db, "task-expiry-ready")).toBeUndefined();
    expect(activeAuthorizationForTask(db, "task-expiry-approved")).toBeUndefined();
    for (const taskId of ["task-expiry-ready", "task-expiry-approved"]) {
      const audits = expiryAudits(taskId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ decision: "ALLOWED", state: "SUCCEEDED" });
    }
  });

  it("未到期 READY 保持不变，EXECUTING 即使 approval expiresAt 已到也不自动过期", () => {
    const fresh = createReady("task-expiry-fresh", NOW + 1);
    const { auth } = approve("task-expiry-executing");
    beginAuthorizedExecution(db, auth.authorizationId, "delivery", auth.bindingDigest, NOW + 3);

    const result = reconcileExpiredAuthorizations(db, NOW + APPROVAL_TTL_MS);

    expect(result.expired).toBe(0);
    expect(status(fresh.authorizationId)).toBe("READY");
    expect(status(auth.authorizationId)).toBe("EXECUTING");
    expect(expiryAudits("task-expiry-fresh")).toHaveLength(0);
    expect(expiryAudits("task-expiry-executing")).toHaveLength(0);
  });

  it("重复 reconciliation 幂等：第二次零成功事件，等价竞争者只有第一个 CAS 获胜", () => {
    const auth = createReady("task-expiry-idempotent");

    expect(reconcileExpiredAuthorizations(db, auth.expiresAt).expired).toBe(1);
    expect(reconcileExpiredAuthorizations(db, auth.expiresAt + 1).expired).toBe(0);

    expect(status(auth.authorizationId)).toBe("EXPIRED");
    expect(expiryAudits("task-expiry-idempotent")).toHaveLength(1);
  });

  it("CAS miss 时回滚本次 audit，不留下 success 事件", () => {
    const auth = createReady("task-expiry-cas-miss");
    db.exec(`
      CREATE TRIGGER force_expiry_cas_miss
      BEFORE UPDATE OF status ON delivery_authorization
      WHEN NEW.status='EXPIRED'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    expect(() => reconcileExpiredAuthorizations(db, auth.expiresAt)).toThrow(StateError);

    expect(status(auth.authorizationId)).toBe("READY");
    expect(expiryAudits("task-expiry-cas-miss")).toHaveLength(0);
  });

  it("expiry 状态写入与 success audit 原子：audit 终结失败时 authorization 也回滚", () => {
    const auth = createReady("task-expiry-atomic");
    db.exec(`
      CREATE TRIGGER force_expiry_audit_failure
      BEFORE UPDATE OF state ON audit
      WHEN NEW.tool='grande_authorization_expiry_reconcile' AND NEW.state='SUCCEEDED'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END
    `);

    expect(() => reconcileExpiredAuthorizations(db, auth.expiresAt)).toThrow(/forced audit failure/i);

    expect(status(auth.authorizationId)).toBe("READY");
    expect(expiryAudits("task-expiry-atomic")).toHaveLength(0);
  });

  it("旧 approve/execute 请求不能复活已 EXPIRED authorization", () => {
    const auth = createReady("task-expiry-old-request");
    const { approvalNonce } = rotateAuthorizationChallenge(db, auth.authorizationId, auth.bindingDigest, NOW + 1);
    const request: ApprovalRequest = {
      authorizationId: auth.authorizationId,
      bindingDigest: auth.bindingDigest,
      approvalNonce,
      identity: { sub: "user-1", email: "user-1@example.com" },
      now: auth.expiresAt - 1,
    };

    reconcileExpiredAuthorizations(db, auth.expiresAt);

    expect(() => approveAuthorization(db, request)).toThrow(/state|CAS/i);
    expect(() => beginAuthorizedExecution(db, auth.authorizationId, "delivery", auth.bindingDigest, auth.expiresAt + 1))
      .toThrow(/state|CAS/i);
    expect(status(auth.authorizationId)).toBe("EXPIRED");
  });
});
