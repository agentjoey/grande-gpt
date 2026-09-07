import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import {
  APPROVAL_TTL_MS,
  EXECUTION_TTL_MS,
  activeAuthorizationForTask,
  approveAuthorization,
  beginAuthorizedExecution,
  createAuthorization,
  rejectAuthorization,
  rotateAuthorizationChallenge,
  transitionAuthorization,
  type ApprovalRequest,
  type DeliveryAuthorizationBinding,
  type RollbackAuthorizationBinding,
} from "../src/deliveryAuthorization.ts";
import { StateError } from "../src/errors.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";

/**
 * Minimal V2 Task 2：durable delivery authorization + CAS 状态机。
 * 所有时间字段都用注入的 `now`，测试不依赖真实时钟。
 */
const NOW = 1_800_000_000_000;

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "authz-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "authz-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  ensureLayout(loadLayout());
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function setupTask(db: DatabaseSync, taskId: string): void {
  createTask(db, {
    taskId,
    repoId: "demo",
    branch: `grande/${taskId}`,
    baseCommit: "base",
    worktreePath: join(ws, taskId),
    state: "READY",
  });
}

function makeDeliveryBinding(
  taskId: string,
  over: Partial<DeliveryAuthorizationBinding> = {},
): DeliveryAuthorizationBinding {
  return {
    authorizationKind: "delivery",
    taskId,
    repoId: "demo",
    worktreeRealpath: "/tmp/wt",
    deliveryTarget: "deploy",
    deployTarget: "prod",
    deploySpecDigest: "sha256:spec",
    policyDigest: "sha256:policy",
    runtimeBuild: "build-1",
    toolsetEpoch: 2,
    toolsDigest: "sha256:tools",
    createdAt: NOW,
    expiresAt: NOW + APPROVAL_TTL_MS,
    prNumber: 7,
    baseRef: "main",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    mergeMethod: "merge",
    expectedMergeTree: "t".repeat(40),
    deployRef: "refs/deploy/prod",
    verifyRef: "refs/verify/prod",
    ...over,
  };
}

function makeRollbackBinding(
  taskId: string,
  over: Partial<RollbackAuthorizationBinding> = {},
): RollbackAuthorizationBinding {
  return {
    authorizationKind: "rollback",
    taskId,
    repoId: "demo",
    worktreeRealpath: "/tmp/wt",
    deliveryTarget: "deploy",
    deployTarget: "prod",
    deploySpecDigest: "sha256:spec",
    policyDigest: "sha256:policy",
    runtimeBuild: "build-1",
    toolsetEpoch: 2,
    toolsDigest: "sha256:tools",
    createdAt: NOW,
    expiresAt: NOW + APPROVAL_TTL_MS,
    currentDeploymentId: "dep-current",
    currentSourceSha: "c".repeat(40),
    rollbackDeploymentId: "dep-rollback",
    rollbackSourceSha: "r".repeat(40),
    rollbackRef: "refs/rollback/prod",
    ...over,
  };
}

function rawRow(db: DatabaseSync, authorizationId: string): Record<string, unknown> {
  return db
    .prepare("SELECT * FROM delivery_authorization WHERE authorizationId=?")
    .get(authorizationId) as Record<string, unknown>;
}

describe("canonical binding digest", () => {
  it("digest 是 sha256:<64 hex>，且对象键顺序不影响取值（canonical JSON）", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-digest-a");
    const binding = makeDeliveryBinding("task-digest-a");
    const a = createAuthorization(db, {
      kind: "delivery", taskId: "task-digest-a", binding, stages: {}, now: NOW,
    });
    expect(a.bindingDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // canonical JSON：对象键按字典序。同一逻辑内容无论输入键序如何都得到同一 digest。
    const sorted = Object.fromEntries(
      Object.entries(binding).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    );
    expect(a.bindingDigest).toBe(`sha256:${sha256hex(JSON.stringify(sorted))}`);
    db.close();
  });

  it("改变任一绑定字段（如 headSha） digest 必变", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-digest-c");
    setupTask(db, "task-digest-d");
    const a = createAuthorization(db, {
      kind: "delivery", taskId: "task-digest-c",
      binding: makeDeliveryBinding("task-digest-c"), stages: {}, now: NOW,
    });
    const b = createAuthorization(db, {
      kind: "delivery", taskId: "task-digest-d",
      binding: makeDeliveryBinding("task-digest-d", { headSha: "0".repeat(40) }), stages: {}, now: NOW,
    });
    expect(a.bindingDigest).not.toBe(b.bindingDigest);
    db.close();
  });
});

describe("createAuthorization", () => {
  it("创建 READY 行；activeAuthorizationForTask 能读回；binding/stages 原样保留", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-create");
    const binding = makeDeliveryBinding("task-create");
    const row = createAuthorization(db, {
      kind: "delivery", taskId: "task-create", binding,
      stages: { merge: { state: "pending" } }, now: NOW,
    });
    expect(row.status).toBe("READY");
    expect(row.kind).toBe("delivery");
    expect(row.binding).toEqual(binding);
    expect(row.stages).toEqual({ merge: { state: "pending" } });
    expect(row.expiresAt).toBe(NOW + APPROVAL_TTL_MS);
    expect(activeAuthorizationForTask(db, "task-create")?.authorizationId).toBe(row.authorizationId);
    expect(activeAuthorizationForTask(db, "task-nope")).toBeUndefined();
    db.close();
  });

  it("同一 task 最多一条活跃 authorization：重复创建抛 STALE_STATE，旧行不被改写", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-one-active");
    const first = createAuthorization(db, {
      kind: "delivery", taskId: "task-one-active",
      binding: makeDeliveryBinding("task-one-active"), stages: {}, now: NOW,
    });
    let caught: unknown;
    try {
      createAuthorization(db, {
        kind: "delivery", taskId: "task-one-active",
        binding: makeDeliveryBinding("task-one-active", { headSha: "1".repeat(40) }), stages: {}, now: NOW,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as StateError).code).toBe("STALE_STATE");
    // 旧行原样保留（审计历史不被改写）。
    expect(activeAuthorizationForTask(db, "task-one-active")?.authorizationId).toBe(first.authorizationId);
    db.close();
  });

  it("旧行进入终态后可以创建新 authorizationId（保留审计历史）", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-history");
    const first = createAuthorization(db, {
      kind: "delivery", taskId: "task-history",
      binding: makeDeliveryBinding("task-history"), stages: {}, now: NOW,
    });
    const { approvalNonce } = rotateAuthorizationChallenge(
      db, first.authorizationId, first.bindingDigest, NOW + 1,
    );
    rejectAuthorization(db, {
      authorizationId: first.authorizationId, bindingDigest: first.bindingDigest,
      approvalNonce, identity: { sub: "u1", email: "u1@example.com" }, now: NOW + 2,
    });
    const second = createAuthorization(db, {
      kind: "delivery", taskId: "task-history",
      binding: makeDeliveryBinding("task-history", { headSha: "2".repeat(40) }), stages: {}, now: NOW + 3,
    });
    expect(second.authorizationId).not.toBe(first.authorizationId);
    const count = db
      .prepare("SELECT count(*) AS n FROM delivery_authorization WHERE taskId=?")
      .get("task-history") as { n: number };
    expect(count.n).toBe(2);
    expect(activeAuthorizationForTask(db, "task-history")?.authorizationId).toBe(second.authorizationId);
    db.close();
  });

  it("kind 与 binding.authorizationKind 不一致时拒绝", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-kind-mismatch");
    expect(() =>
      createAuthorization(db, {
        kind: "rollback", taskId: "task-kind-mismatch",
        binding: makeDeliveryBinding("task-kind-mismatch"), stages: {}, now: NOW,
      }),
    ).toThrow(/kind/i);
    db.close();
  });

  it("审批有效期固定 15 分钟：expiresAt 偏离 createdAt+TTL 或已过期都拒绝", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-ttl-a");
    setupTask(db, "task-ttl-b");
    expect(() =>
      createAuthorization(db, {
        kind: "delivery", taskId: "task-ttl-a",
        binding: makeDeliveryBinding("task-ttl-a", { expiresAt: NOW + 60 * 60_000 }),
        stages: {}, now: NOW,
      }),
    ).toThrow(/expir/i);
    expect(() =>
      createAuthorization(db, {
        kind: "delivery", taskId: "task-ttl-b",
        binding: makeDeliveryBinding("task-ttl-b"),
        stages: {}, now: NOW + APPROVAL_TTL_MS,
      }),
    ).toThrow(/expir/i);
    db.close();
  });
});

describe("challenge nonce", () => {
  it("nonce 至少 256 bit；库中只存 digest，明文不出现在任何持久化字段", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-nonce");
    const auth = createAuthorization(db, {
      kind: "delivery", taskId: "task-nonce",
      binding: makeDeliveryBinding("task-nonce"), stages: {}, now: NOW,
    });
    const { row, approvalNonce } = rotateAuthorizationChallenge(
      db, auth.authorizationId, auth.bindingDigest, NOW + 1,
    );
    expect(row.authorizationId).toBe(auth.authorizationId);
    expect(Buffer.from(approvalNonce, "base64url").length).toBeGreaterThanOrEqual(32);
    const raw = rawRow(db, auth.authorizationId);
    expect(raw.nonceDigest).toBe(sha256hex(approvalNonce));
    expect(raw.nonceDigest).not.toBe(approvalNonce);
    expect(JSON.stringify(raw)).not.toContain(approvalNonce);
    db.close();
  });

  it("每次 challenge 轮换 nonce：旧 nonce 立即失效", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-rotate");
    const auth = createAuthorization(db, {
      kind: "delivery", taskId: "task-rotate",
      binding: makeDeliveryBinding("task-rotate"), stages: {}, now: NOW,
    });
    const first = rotateAuthorizationChallenge(db, auth.authorizationId, auth.bindingDigest, NOW + 1);
    const second = rotateAuthorizationChallenge(db, auth.authorizationId, auth.bindingDigest, NOW + 2);
    expect(second.approvalNonce).not.toBe(first.approvalNonce);
    const staleReq: ApprovalRequest = {
      authorizationId: auth.authorizationId, bindingDigest: auth.bindingDigest,
      approvalNonce: first.approvalNonce,
      identity: { sub: "u1", email: "u1@example.com" }, now: NOW + 3,
    };
    expect(() => approveAuthorization(db, staleReq)).toThrow(/nonce/i);
    const freshReq: ApprovalRequest = { ...staleReq, approvalNonce: second.approvalNonce };
    expect(approveAuthorization(db, freshReq).status).toBe("APPROVED");
    db.close();
  });

  it("challenge 要求 READY、digest 匹配且未过期", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-challenge-guard");
    const auth = createAuthorization(db, {
      kind: "delivery", taskId: "task-challenge-guard",
      binding: makeDeliveryBinding("task-challenge-guard"), stages: {}, now: NOW,
    });
    expect(() =>
      rotateAuthorizationChallenge(db, auth.authorizationId, "sha256:" + "0".repeat(64), NOW + 1),
    ).toThrow(/digest|state|CAS/i);
    expect(() =>
      rotateAuthorizationChallenge(db, auth.authorizationId, auth.bindingDigest, NOW + APPROVAL_TTL_MS),
    ).toThrow(/expir/i);
    db.close();
  });
});

describe("approveAuthorization", () => {
  function approvedFixture(db: DatabaseSync, taskId: string) {
    setupTask(db, taskId);
    const auth = createAuthorization(db, {
      kind: "delivery", taskId, binding: makeDeliveryBinding(taskId), stages: {}, now: NOW,
    });
    const { approvalNonce } = rotateAuthorizationChallenge(
      db, auth.authorizationId, auth.bindingDigest, NOW + 1,
    );
    const request: ApprovalRequest = {
      authorizationId: auth.authorizationId,
      bindingDigest: auth.bindingDigest,
      approvalNonce,
      identity: { sub: "user-1", email: "user-1@example.com" },
      now: NOW + 2,
    };
    return { auth, approvalNonce, request };
  }

  it("happy path：READY → APPROVED，持久化已验证身份的 sub/email 与 approvedAt", () => {
    const db = openDb(loadLayout());
    const { auth, request } = approvedFixture(db, "task-approve");
    const row = approveAuthorization(db, request);
    expect(row.status).toBe("APPROVED");
    const raw = rawRow(db, auth.authorizationId);
    expect(raw.approverSub).toBe("user-1");
    expect(raw.approverEmail).toBe("user-1@example.com");
    expect(raw.approvedAt).toBe(NOW + 2);
    db.close();
  });

  it("错误 nonce、错误 digest、缺失 challenge 都拒绝，且状态不变", () => {
    const db = openDb(loadLayout());
    const { auth, request } = approvedFixture(db, "task-approve-guard");
    expect(() =>
      approveAuthorization(db, { ...request, approvalNonce: "wrong-nonce" }),
    ).toThrow(/nonce/i);
    expect(() =>
      approveAuthorization(db, { ...request, bindingDigest: "sha256:" + "0".repeat(64) }),
    ).toThrow(/digest|state|CAS/i);
    setupTask(db, "task-approve-guard-2");
    const other = createAuthorization(db, {
      kind: "delivery", taskId: "task-approve-guard-2",
      binding: makeDeliveryBinding("task-approve-guard-2"), stages: {}, now: NOW,
    });
    // 从未 challenge 过的 authorization：digest 正确但没有任何 nonce 记录。
    expect(() =>
      approveAuthorization(db, {
        ...request,
        authorizationId: other.authorizationId,
        bindingDigest: other.bindingDigest,
      }),
    ).toThrow(/nonce/i);
    expect(activeAuthorizationForTask(db, "task-approve-guard")?.status).toBe("READY");
    expect(auth.authorizationId).toBeTruthy();
    db.close();
  });

  it("15 分钟审批有效期：expiresAt 到达后 approve 拒绝", () => {
    const db = openDb(loadLayout());
    const { request } = approvedFixture(db, "task-approve-expired");
    expect(() =>
      approveAuthorization(db, { ...request, now: NOW + APPROVAL_TTL_MS }),
    ).toThrow(/expir/i);
    expect(activeAuthorizationForTask(db, "task-approve-expired")?.status).toBe("READY");
    db.close();
  });

  it("响应丢失后的重放返回同一终态：零执行、单行、之后只能 begin 一次", () => {
    const db = openDb(loadLayout());
    const { auth, request } = approvedFixture(db, "task-replay");
    const first = approveAuthorization(db, request);
    expect(first.status).toBe("APPROVED");
    const replay = approveAuthorization(db, request);
    expect(replay.status).toBe("APPROVED");
    const count = db
      .prepare("SELECT count(*) AS n FROM delivery_authorization WHERE authorizationId=?")
      .get(request.authorizationId) as { n: number };
    expect(count.n).toBe(1);
    const digest = auth.bindingDigest;
    expect(beginAuthorizedExecution(db, first.authorizationId, "delivery", digest, NOW + 3).status)
      .toBe("EXECUTING");
    expect(() => beginAuthorizedExecution(db, first.authorizationId, "delivery", digest, NOW + 4))
      .toThrow(/state|CAS/i);
    db.close();
  });

  it("APPROVED 上重放不同 nonce 不是重放：拒绝且不改变状态", () => {
    const db = openDb(loadLayout());
    const { request } = approvedFixture(db, "task-replay-nonce");
    approveAuthorization(db, request);
    expect(() =>
      approveAuthorization(db, { ...request, approvalNonce: "other-nonce" }),
    ).toThrow(/state|CAS|nonce/i);
    expect(activeAuthorizationForTask(db, "task-replay-nonce")?.status).toBe("APPROVED");
    db.close();
  });

  it("终态不可变：REJECTED 之后 approve/begin 都拒绝", () => {
    const db = openDb(loadLayout());
    const { auth, request } = approvedFixture(db, "task-terminal");
    rejectAuthorization(db, request);
    expect(() => approveAuthorization(db, request)).toThrow(/state|CAS|nonce/i);
    expect(() =>
      beginAuthorizedExecution(db, auth.authorizationId, "delivery", auth.bindingDigest, NOW + 3),
    ).toThrow(/state|CAS/i);
    db.close();
  });
});

describe("rejectAuthorization", () => {
  function readyFixture(db: DatabaseSync, taskId: string) {
    setupTask(db, taskId);
    const auth = createAuthorization(db, {
      kind: "delivery", taskId, binding: makeDeliveryBinding(taskId), stages: {}, now: NOW,
    });
    const { approvalNonce } = rotateAuthorizationChallenge(
      db, auth.authorizationId, auth.bindingDigest, NOW + 1,
    );
    const request: ApprovalRequest = {
      authorizationId: auth.authorizationId,
      bindingDigest: auth.bindingDigest,
      approvalNonce,
      identity: { sub: "user-1", email: "user-1@example.com" },
      now: NOW + 2,
    };
    return { auth, request };
  }

  it("READY → REJECTED；APPROVED → REVOKED", () => {
    const db = openDb(loadLayout());
    const a = readyFixture(db, "task-reject-ready");
    expect(rejectAuthorization(db, a.request).status).toBe("REJECTED");
    const b = readyFixture(db, "task-reject-approved");
    approveAuthorization(db, b.request);
    expect(rejectAuthorization(db, b.request).status).toBe("REVOKED");
    db.close();
  });

  it("reject 重放返回同一终态，不产生新转移", () => {
    const db = openDb(loadLayout());
    const { request } = readyFixture(db, "task-reject-replay");
    expect(rejectAuthorization(db, request).status).toBe("REJECTED");
    expect(rejectAuthorization(db, request).status).toBe("REJECTED");
    db.close();
  });

  it("EXECUTING 不能被 reject 撤销", () => {
    const db = openDb(loadLayout());
    const { auth, request } = readyFixture(db, "task-reject-executing");
    approveAuthorization(db, request);
    beginAuthorizedExecution(db, auth.authorizationId, "delivery", auth.bindingDigest, NOW + 3);
    expect(() => rejectAuthorization(db, request)).toThrow(/state|CAS/i);
    db.close();
  });
});

describe("beginAuthorizedExecution", () => {
  it("APPROVED → EXECUTING：记录 executingAt 与 60 分钟 execution deadline", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-begin");
    const auth = createAuthorization(db, {
      kind: "delivery", taskId: "task-begin",
      binding: makeDeliveryBinding("task-begin"), stages: {}, now: NOW,
    });
    const { approvalNonce } = rotateAuthorizationChallenge(
      db, auth.authorizationId, auth.bindingDigest, NOW + 1,
    );
    approveAuthorization(db, {
      authorizationId: auth.authorizationId, bindingDigest: auth.bindingDigest,
      approvalNonce, identity: { sub: "u1", email: "u1@example.com" }, now: NOW + 2,
    });
    const beginAt = NOW + 3;
    const row = beginAuthorizedExecution(db, auth.authorizationId, "delivery", auth.bindingDigest, beginAt);
    expect(row.status).toBe("EXECUTING");
    const raw = rawRow(db, auth.authorizationId);
    expect(raw.executingAt).toBe(beginAt);
    expect(raw.executionDeadlineAt).toBe(beginAt + EXECUTION_TTL_MS);
    db.close();
  });

  it("kind 必须精确匹配：rollback authorization 不能被 delivery 启动", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-begin-kind");
    const auth = createAuthorization(db, {
      kind: "rollback", taskId: "task-begin-kind",
      binding: makeRollbackBinding("task-begin-kind"), stages: {}, now: NOW,
    });
    const { approvalNonce } = rotateAuthorizationChallenge(
      db, auth.authorizationId, auth.bindingDigest, NOW + 1,
    );
    approveAuthorization(db, {
      authorizationId: auth.authorizationId, bindingDigest: auth.bindingDigest,
      approvalNonce, identity: { sub: "u1", email: "u1@example.com" }, now: NOW + 2,
    });
    expect(() =>
      beginAuthorizedExecution(db, auth.authorizationId, "delivery", auth.bindingDigest, NOW + 3),
    ).toThrow(/kind/i);
    expect(
      beginAuthorizedExecution(db, auth.authorizationId, "rollback", auth.bindingDigest, NOW + 3).status,
    ).toBe("EXECUTING");
    db.close();
  });

  it("digest 漂移拒绝启动；必须在 expiresAt 前 CAS 进入 EXECUTING", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-begin-guard");
    const auth = createAuthorization(db, {
      kind: "delivery", taskId: "task-begin-guard",
      binding: makeDeliveryBinding("task-begin-guard"), stages: {}, now: NOW,
    });
    const { approvalNonce } = rotateAuthorizationChallenge(
      db, auth.authorizationId, auth.bindingDigest, NOW + 1,
    );
    approveAuthorization(db, {
      authorizationId: auth.authorizationId, bindingDigest: auth.bindingDigest,
      approvalNonce, identity: { sub: "u1", email: "u1@example.com" }, now: NOW + 2,
    });
    expect(() =>
      beginAuthorizedExecution(db, auth.authorizationId, "delivery", "sha256:" + "0".repeat(64), NOW + 3),
    ).toThrow(/digest|state|CAS/i);
    expect(() =>
      beginAuthorizedExecution(
        db, auth.authorizationId, "delivery", auth.bindingDigest, NOW + APPROVAL_TTL_MS,
      ),
    ).toThrow(/expir/i);
    expect(activeAuthorizationForTask(db, "task-begin-guard")?.status).toBe("APPROVED");
    db.close();
  });
});

describe("transitionAuthorization", () => {
  function executingFixture(db: DatabaseSync, taskId: string) {
    setupTask(db, taskId);
    const auth = createAuthorization(db, {
      kind: "delivery", taskId, binding: makeDeliveryBinding(taskId), stages: {}, now: NOW,
    });
    const { approvalNonce } = rotateAuthorizationChallenge(
      db, auth.authorizationId, auth.bindingDigest, NOW + 1,
    );
    approveAuthorization(db, {
      authorizationId: auth.authorizationId, bindingDigest: auth.bindingDigest,
      approvalNonce, identity: { sub: "u1", email: "u1@example.com" }, now: NOW + 2,
    });
    beginAuthorizedExecution(db, auth.authorizationId, "delivery", auth.bindingDigest, NOW + 3);
    return auth;
  }

  it("EXECUTING → SUCCEEDED：stages 与 reason 落库", () => {
    const db = openDb(loadLayout());
    const auth = executingFixture(db, "task-transition");
    const stages = {
      merge: { state: "succeeded" as const, receiptId: "rcpt-1" },
      deploy: { state: "succeeded" as const, receiptId: "rcpt-2", jobId: "job-1" },
      verify: { state: "succeeded" as const, receiptId: "rcpt-3", jobId: "job-2" },
    };
    const row = transitionAuthorization(
      db, auth.authorizationId, auth.bindingDigest, "EXECUTING", "SUCCEEDED", stages, "done",
    );
    expect(row.status).toBe("SUCCEEDED");
    expect(row.stages).toEqual(stages);
    expect(rawRow(db, auth.authorizationId).reason).toBe("done");
    db.close();
  });

  it("wrong/stale bindingDigest 抛 STALE_STATE，且 status/stageJson/reason 保持不变", () => {
    const db = openDb(loadLayout());
    const auth = executingFixture(db, "task-transition-digest");
    const before = rawRow(db, auth.authorizationId);
    const wrongDigests = [
      "sha256:" + "0".repeat(64), // 凭空错误 digest
      `sha256:${sha256hex(JSON.stringify(makeDeliveryBinding("task-transition-digest", { headSha: "9".repeat(40) })))}`, // stale：旧 binding 的 digest
    ];
    for (const digest of wrongDigests) {
      let caught: unknown;
      try {
        transitionAuthorization(
          db, auth.authorizationId, digest, "EXECUTING", "SUCCEEDED",
          { merge: { state: "succeeded" } }, "should not persist",
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StateError);
      expect((caught as StateError).code).toBe("STALE_STATE");
    }
    const after = rawRow(db, auth.authorizationId);
    expect(after.status).toBe("EXECUTING");
    expect(after.stageJson).toBe(before.stageJson);
    expect(after.reason).toBe(before.reason);
    db.close();
  });

  it("非法边（READY → SUCCEEDED）与终态出边都拒绝", () => {
    const db = openDb(loadLayout());
    setupTask(db, "task-bad-edge");
    const auth = createAuthorization(db, {
      kind: "delivery", taskId: "task-bad-edge",
      binding: makeDeliveryBinding("task-bad-edge"), stages: {}, now: NOW,
    });
    expect(() =>
      transitionAuthorization(db, auth.authorizationId, auth.bindingDigest, "READY", "SUCCEEDED", {}),
    ).toThrow(/state|transition|CAS/i);
    const done = executingFixture(db, "task-terminal-edge");
    transitionAuthorization(db, done.authorizationId, done.bindingDigest, "EXECUTING", "SUCCEEDED", {});
    expect(() =>
      transitionAuthorization(db, done.authorizationId, done.bindingDigest, "SUCCEEDED", "FAILED", {}),
    ).toThrow(/state|transition|CAS/i);
    db.close();
  });

  it("CAS：expected from 与当前状态不一致时零执行抛错", () => {
    const db = openDb(loadLayout());
    const auth = executingFixture(db, "task-cas");
    expect(() =>
      transitionAuthorization(db, auth.authorizationId, auth.bindingDigest, "APPROVED", "REVOKED", {}),
    ).toThrow(/state|CAS/i);
    expect(activeAuthorizationForTask(db, "task-cas")?.status).toBe("EXECUTING");
    db.close();
  });

  it("EXECUTING → EXPIRED（execution deadline 到达）后进入终态", () => {
    const db = openDb(loadLayout());
    const auth = executingFixture(db, "task-exec-expired");
    const row = transitionAuthorization(
      db, auth.authorizationId, auth.bindingDigest, "EXECUTING", "EXPIRED", {},
      "execution deadline reached",
    );
    expect(row.status).toBe("EXPIRED");
    expect(activeAuthorizationForTask(db, "task-exec-expired")).toBeUndefined();
    db.close();
  });
});
