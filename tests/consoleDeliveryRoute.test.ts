import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { openDb } from "../src/db.ts";
import { createTask } from "../src/tasks.ts";
import {
  APPROVAL_TTL_MS,
  createAuthorization,
  type AuthorizationStages,
  type DeliveryAuthorizationBinding,
} from "../src/deliveryAuthorization.ts";

/**
 * 门禁替身：默认放行并返回固定身份；gateDeny=true 或无 Cf-Access-Jwt-Assertion
 * 头时像真门禁一样抛 AccessDeniedError。instanceof 判定依赖真实类，所以只换
 * createAccessGate，AccessDeniedError 保留原模块实现。
 */
let gateDeny = false;
const GATE_IDENTITY = { email: "owner@example.test", sub: "sub-owner-1" };

vi.mock("../src/accessGate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/accessGate.ts")>();
  return {
    ...actual,
    createAccessGate: () => async (headers: Headers) => {
      if (gateDeny || !headers.get("Cf-Access-Jwt-Assertion")) {
        throw new actual.AccessDeniedError("缺少或非法 Cf-Access-Jwt-Assertion。");
      }
      return GATE_IDENTITY;
    },
  };
});

import { mountConsoleRoutes } from "../src/consoleRoutes.ts";

const CONSOLE_ORIGIN = "https://console.example.test";
const JWT_PLACEHOLDER = "test-jwt-assertion";

let ws: string;
let ctrl: string;
let layout: Layout;
let db: DatabaseSync;
let app: Hono;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  gateDeny = false;
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "console-delivery-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "console-delivery-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  app = new Hono();
  mountConsoleRoutes(app, {
    db,
    consoleAccess: { teamDomain: "https://team.example.test", aud: "c".repeat(64) },
    consoleOrigin: CONSOLE_ORIGIN,
  });
});

afterEach(() => {
  db.close();
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

/* ---------- fixtures ---------- */

const STAGES: AuthorizationStages = {
  merge: { state: "pending" },
  deploy: { state: "pending" },
  verify: { state: "pending" },
};

function deliveryBinding(taskId: string, createdAt: number): DeliveryAuthorizationBinding {
  return {
    authorizationKind: "delivery",
    taskId,
    repoId: "demo",
    worktreeRealpath: "/tmp/wt-demo",
    deliveryTarget: "deploy",
    deployTarget: "prod",
    deploySpecDigest: `sha256:${"1".repeat(64)}`,
    policyDigest: `sha256:${"2".repeat(64)}`,
    runtimeBuild: "test-build",
    toolsetEpoch: 1,
    toolsDigest: `sha256:${"3".repeat(64)}`,
    createdAt,
    expiresAt: createdAt + APPROVAL_TTL_MS,
    prNumber: 7,
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeMethod: "merge",
    expectedMergeTree: "e".repeat(40),
    deployRef: "deploy@v1",
    verifyRef: "verify@v1",
  };
}

/** 造一条 READY authorization；expired=true 时创建在过去、现在已过期。 */
function seed(taskId: string, opts: { expired?: boolean } = {}) {
  // delivery_authorization.taskId 有外键：先落一条 task 记录。
  createTask(db, {
    taskId,
    repoId: "demo",
    branch: `grande/${taskId}`,
    baseCommit: "base",
    worktreePath: join(ws, taskId),
    state: "READY",
  });
  const createdAt = opts.expired ? Date.now() - APPROVAL_TTL_MS - 60_000 : Date.now();
  return createAuthorization(db, {
    kind: "delivery",
    taskId,
    binding: deliveryBinding(taskId, createdAt),
    stages: STAGES,
    now: createdAt,
  });
}

/* ---------- 请求助手 ---------- */

interface PostOptions {
  jwt?: boolean;          // 默认带
  origin?: string | null; // 默认 CONSOLE_ORIGIN；null = 不带 Origin 头
  contentType?: string;   // 默认 application/json
  rawBody?: string;       // 给原始 body（绕过 JSON.stringify）
}

function post(path: string, body: unknown, opts: PostOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.jwt !== false) headers["Cf-Access-Jwt-Assertion"] = JWT_PLACEHOLDER;
  const origin = opts.origin === undefined ? CONSOLE_ORIGIN : opts.origin;
  if (origin !== null) headers["Origin"] = origin;
  headers["content-type"] = opts.contentType ?? "application/json";
  return app.request(path, {
    method: "POST",
    headers,
    body: opts.rawBody ?? JSON.stringify(body),
  });
}

const challenge = (id: string, body: unknown, opts?: PostOptions) =>
  post(`/console/delivery/${id}/challenge`, body, opts);
const approve = (id: string, body: unknown, opts?: PostOptions) =>
  post(`/console/delivery/${id}/approve`, body, opts);
const reject = (id: string, body: unknown, opts?: PostOptions) =>
  post(`/console/delivery/${id}/reject`, body, opts);

/** 成功 challenge 并取出明文 nonce。 */
async function challengeNonce(id: string, bindingDigest: string): Promise<string> {
  const res = await challenge(id, { bindingDigest });
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { approvalNonce: string } };
  return body.data.approvalNonce;
}

function storedRow(authorizationId: string) {
  return db.prepare(
    "SELECT status, nonceDigest, approverSub, approverEmail, approvedAt, executingAt, updatedAt " +
      "FROM delivery_authorization WHERE authorizationId=?",
  ).get(authorizationId) as Record<string, unknown>;
}

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

/** 与 src/audit.ts 内部 digest 同一算法的重算，用来证明审计 input 的精确字段集。 */
function auditInputDigest(input: unknown): string {
  const stable = JSON.stringify(input, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
  return createHash("sha256").update(stable ?? "null", "utf8").digest("hex");
}

/* ---------- 门禁与 Origin ---------- */

describe("身份与 Origin 边界（先于 body 解析与查库）", () => {
  it("无 JWT → 403，状态与 nonceDigest 都不动", async () => {
    const row = seed("task_a1");
    const res = await challenge(row.authorizationId, { bindingDigest: row.bindingDigest }, { jwt: false });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("access_denied");
    expect(storedRow(row.authorizationId).nonceDigest).toBeNull();
    expectSecurityHeaders(res);
  });

  it("门禁拒绝（非法 JWT）→ 403", async () => {
    gateDeny = true;
    const row = seed("task_a2");
    const res = await challenge(row.authorizationId, { bindingDigest: row.bindingDigest });
    expect(res.status).toBe(403);
    expect(storedRow(row.authorizationId).nonceDigest).toBeNull();
  });

  it("Origin 缺失 / 错误 / 字面量 null / 尾斜杠变体 → 一律 403，且不轮换 nonce", async () => {
    const row = seed("task_a3");
    for (const origin of [null, "https://evil.example.test", "null", `${CONSOLE_ORIGIN}/`]) {
      const res = await challenge(row.authorizationId, { bindingDigest: row.bindingDigest }, { origin });
      expect(res.status).toBe(403);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("origin_denied");
      expectSecurityHeaders(res);
    }
    expect(storedRow(row.authorizationId).nonceDigest).toBeNull();
    expect(storedRow(row.authorizationId).status).toBe("READY");
  });

  it("未配置可信 Origin 时审批路由 fail-closed 403（缺配置 ≠ 不校验）", async () => {
    const bare = new Hono();
    mountConsoleRoutes(bare, {
      db,
      consoleAccess: { teamDomain: "https://team.example.test", aud: "c".repeat(64) },
    });
    const row = seed("task_a4");
    const res = await bare.request(`/console/delivery/${row.authorizationId}/challenge`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": JWT_PLACEHOLDER,
        Origin: CONSOLE_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ bindingDigest: row.bindingDigest }),
    });
    expect(res.status).toBe(403);
    expect(storedRow(row.authorizationId).nonceDigest).toBeNull();
  });
});

/* ---------- 请求体形状 ---------- */

describe("请求体：exact JSON，不接受任何自报字段", () => {
  it("非 JSON Content-Type → 400", async () => {
    const row = seed("task_b1");
    const res = await challenge(row.authorizationId, "bindingDigest=x", { contentType: "application/x-www-form-urlencoded" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("not_json");
    expect(storedRow(row.authorizationId).nonceDigest).toBeNull();
  });

  it("非法 JSON / 数组 / 字符串 → 400", async () => {
    const row = seed("task_b2");
    for (const raw of ["{not json", "[1,2]", "\"text\"", "42"]) {
      const res = await challenge(row.authorizationId, null, { rawBody: raw });
      expect(res.status).toBe(400);
    }
    expect(storedRow(row.authorizationId).nonceDigest).toBeNull();
  });

  it("challenge 只接受 {bindingDigest}：缺字段、多字段、非字符串值都 400", async () => {
    const row = seed("task_b3");
    for (const body of [
      {},
      { bindingDigest: row.bindingDigest, approved: true },
      { bindingDigest: row.bindingDigest, taskId: "task_b3" },
      { bindingDigest: 42 },
    ]) {
      const res = await challenge(row.authorizationId, body);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code).toBe("bad_body_shape");
    }
    expect(storedRow(row.authorizationId).nonceDigest).toBeNull();
  });

  it("approve 缺 approvalNonce → 400；多 approvalNonce 之外的字段 → 400", async () => {
    const row = seed("task_b4");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    expect((await approve(row.authorizationId, { bindingDigest: row.bindingDigest })).status).toBe(400);
    expect((await approve(row.authorizationId, {
      bindingDigest: row.bindingDigest, approvalNonce: nonce, approver: "mallory@evil.test",
    })).status).toBe(400);
    expect(storedRow(row.authorizationId).status).toBe("READY");
  });

  it("安全头同样出现在 400 响应上", async () => {
    const row = seed("task_b5");
    expectSecurityHeaders(await challenge(row.authorizationId, {}));
  });
});

/* ---------- challenge ---------- */

describe("POST /console/delivery/:authorizationId/challenge", () => {
  it("成功：返回一次性明文 nonce 与 bounded summary，nonce 不落库", async () => {
    const row = seed("task_c1");
    const res = await challenge(row.authorizationId, { bindingDigest: row.bindingDigest });
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json() as {
      ok: boolean;
      data: Record<string, unknown> & { approvalNonce: string; summary: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    // 响应的精确形状：不夹带 bindingJson/nonceDigest/approver 等内部字段。
    expect(Object.keys(body.data).sort()).toEqual(
      ["approvalNonce", "authorizationId", "bindingDigest", "expiresAt", "status", "summary"].sort(),
    );
    expect(body.data.authorizationId).toBe(row.authorizationId);
    expect(body.data.status).toBe("READY");
    // nonce：256 bit 随机数的 base64url，43 字符。
    expect(body.data.approvalNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // bounded summary：只含 Human 判断需要的字段，没有 PR 标题/日志/HTML/worktree 本机路径。
    expect(Object.keys(body.data.summary).sort()).toEqual([
      "authorizationKind", "taskId", "repoId", "deployTarget",
      "deploySpecDigest", "policyDigest", "runtimeBuild", "toolsetEpoch", "toolsDigest",
      "createdAt", "expiresAt",
      "prNumber", "baseRef", "baseSha", "headSha", "mergeMethod", "expectedMergeTree",
      "deployRef", "verifyRef",
    ].sort());
    expect(body.data.summary.headSha).toBe("b".repeat(40));
    // 明文 nonce 只出现在这次响应里：库里任何地方都不能找到它。
    const stored = db.prepare("SELECT * FROM delivery_authorization WHERE authorizationId=?")
      .get(row.authorizationId);
    expect(JSON.stringify(stored)).not.toContain(body.data.approvalNonce);
    const audits = db.prepare("SELECT * FROM audit").all();
    expect(JSON.stringify(audits)).not.toContain(body.data.approvalNonce);
    expect(JSON.stringify(audits)).not.toContain(JWT_PLACEHOLDER);
  });

  it("每次 challenge 都轮换 nonce：旧 nonce 立刻失效", async () => {
    const row = seed("task_c2");
    const first = await challengeNonce(row.authorizationId, row.bindingDigest);
    const digestAfterFirst = storedRow(row.authorizationId).nonceDigest as string;
    const second = await challengeNonce(row.authorizationId, row.bindingDigest);
    const digestAfterSecond = storedRow(row.authorizationId).nonceDigest as string;
    expect(second).not.toBe(first);
    expect(digestAfterSecond).not.toBe(digestAfterFirst);
    // 旧 nonce 不能用于 approve。
    const res = await approve(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: first });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("auth_nonce");
    expect(storedRow(row.authorizationId).status).toBe("READY");
  });

  it("authorizationId 不存在 → 404；bindingDigest 不符 → 409", async () => {
    const row = seed("task_c3");
    const missing = await challenge("authz_nonexistent", { bindingDigest: row.bindingDigest });
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("auth_not_found");

    const drift = await challenge(row.authorizationId, { bindingDigest: `sha256:${"9".repeat(64)}` });
    expect(drift.status).toBe(409);
    expect((await drift.json() as { error: { code: string } }).error.code).toBe("stale_state");
    expect(storedRow(row.authorizationId).nonceDigest).toBeNull();
  });

  it("已过审批有效期 → 409 auth_expired", async () => {
    const row = seed("task_c4", { expired: true });
    const res = await challenge(row.authorizationId, { bindingDigest: row.bindingDigest });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("auth_expired");
  });

  it("challenge 留下 bounded 审计：input 恰好是 {authorizationId, bindingDigest} 的摘要", async () => {
    const row = seed("task_c5");
    await challengeNonce(row.authorizationId, row.bindingDigest);
    const audit = db.prepare(
      "SELECT taskId, tool, inputDigest, decision, state FROM audit WHERE tool='console_delivery_challenge'",
    ).get() as Record<string, unknown>;
    expect(audit).toMatchObject({ taskId: "task_c5", decision: "ALLOWED", state: "SUCCEEDED" });
    expect(audit.inputDigest).toBe(
      auditInputDigest({ authorizationId: row.authorizationId, bindingDigest: row.bindingDigest }),
    );
  });
});

/* ---------- approve ---------- */

describe("POST /console/delivery/:authorizationId/approve", () => {
  it("成功：READY → APPROVED，审批人身份只来自已验证 JWT", async () => {
    const row = seed("task_d1");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    const res = await approve(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json() as { data: Record<string, unknown> };
    // 响应不回显 nonce、不夹带内部字段。
    expect(Object.keys(body.data).sort()).toEqual(
      ["authorizationId", "bindingDigest", "expiresAt", "status"].sort(),
    );
    expect(body.data.status).toBe("APPROVED");
    const stored = storedRow(row.authorizationId);
    expect(stored.approverSub).toBe(GATE_IDENTITY.sub);
    expect(stored.approverEmail).toBe(GATE_IDENTITY.email);
  });

  it("请求体里的伪造 approver 字段被 400 拒绝，身份随后仍只能来自 JWT", async () => {
    const row = seed("task_d2");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    const spoofed = await approve(row.authorizationId, {
      bindingDigest: row.bindingDigest,
      approvalNonce: nonce,
      approver: "mallory@evil.test",
    });
    expect(spoofed.status).toBe(400);
    expect(storedRow(row.authorizationId).status).toBe("READY");
    expect(storedRow(row.authorizationId).approverSub).toBeNull();

    const clean = await approve(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });
    expect(clean.status).toBe(200);
    const stored = storedRow(row.authorizationId);
    expect(stored.approverSub).toBe(GATE_IDENTITY.sub);
    expect(stored.approverEmail).toBe(GATE_IDENTITY.email);
  });

  it("错误 nonce / 错误 digest / 过期 → 409，状态保持 READY", async () => {
    const row = seed("task_d3");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    expect((await approve(row.authorizationId, {
      bindingDigest: row.bindingDigest, approvalNonce: "wrong-nonce",
    })).status).toBe(409);
    expect((await approve(row.authorizationId, {
      bindingDigest: `sha256:${"9".repeat(64)}`, approvalNonce: nonce,
    })).status).toBe(409);
    expect(storedRow(row.authorizationId).status).toBe("READY");

    const expired = seed("task_d3x", { expired: true });
    const res = await approve(expired.authorizationId, {
      bindingDigest: expired.bindingDigest, approvalNonce: nonce,
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("auth_expired");
  });

  it("并发双击 + 响应丢失重放：最多一次状态转移，handler 内零执行", async () => {
    const row = seed("task_d4");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    const call = () => approve(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });

    const [r1, r2] = await Promise.all([call(), call()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const stored = storedRow(row.authorizationId);
    expect(stored.status).toBe("APPROVED");
    // handler 不执行交付：没有 EXECUTING，stage 全部原地 pending。
    expect(stored.executingAt).toBeNull();
    const stages = JSON.parse(
      (db.prepare("SELECT stageJson FROM delivery_authorization WHERE authorizationId=?")
        .get(row.authorizationId) as { stageJson: string }).stageJson,
    ) as Record<string, { state: string }>;
    expect(Object.values(stages).map((s) => s.state)).toEqual(["pending", "pending", "pending"]);

    // 重放（响应丢失后原样重发）零写入：updatedAt 不变，状态不变。
    const updatedAt = stored.updatedAt;
    const replay = await call();
    expect(replay.status).toBe(200);
    expect((await replay.json() as { data: { status: string } }).data.status).toBe("APPROVED");
    expect(storedRow(row.authorizationId).updatedAt).toBe(updatedAt);
  });

  it("approve 留下 bounded 审计：{authorizationId, bindingDigest}，不含 nonce/JWT", async () => {
    const row = seed("task_d5");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    await approve(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });
    const audit = db.prepare(
      "SELECT taskId, inputDigest, decision, state FROM audit WHERE tool='console_delivery_approve'",
    ).get() as Record<string, unknown>;
    expect(audit).toMatchObject({ taskId: "task_d5", decision: "ALLOWED", state: "SUCCEEDED" });
    expect(audit.inputDigest).toBe(
      auditInputDigest({ authorizationId: row.authorizationId, bindingDigest: row.bindingDigest }),
    );
    const audits = db.prepare("SELECT * FROM audit").all();
    expect(JSON.stringify(audits)).not.toContain(nonce);
    expect(JSON.stringify(audits)).not.toContain(JWT_PLACEHOLDER);
  });
});

/* ---------- reject / revoke ---------- */

describe("POST /console/delivery/:authorizationId/reject", () => {
  it("READY → REJECTED，终态后同一请求重放零执行返回同一状态", async () => {
    const row = seed("task_e1");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    const res = await reject(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { status: string } }).data.status).toBe("REJECTED");
    expect(storedRow(row.authorizationId).status).toBe("REJECTED");

    const replay = await reject(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { data: { status: string } }).data.status).toBe("REJECTED");
  });

  it("APPROVED（尚未执行）→ REVOKED", async () => {
    const row = seed("task_e2");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    await approve(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });
    const res = await reject(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { status: string } }).data.status).toBe("REVOKED");
    expect(storedRow(row.authorizationId).status).toBe("REVOKED");
  });

  it("reject 留下 bounded 审计：{authorizationId, bindingDigest}", async () => {
    const row = seed("task_e3");
    const nonce = await challengeNonce(row.authorizationId, row.bindingDigest);
    await reject(row.authorizationId, { bindingDigest: row.bindingDigest, approvalNonce: nonce });
    const audit = db.prepare(
      "SELECT taskId, inputDigest, decision, state FROM audit WHERE tool='console_delivery_reject'",
    ).get() as Record<string, unknown>;
    expect(audit).toMatchObject({ taskId: "task_e3", decision: "ALLOWED", state: "SUCCEEDED" });
    expect(audit.inputDigest).toBe(
      auditInputDigest({ authorizationId: row.authorizationId, bindingDigest: row.bindingDigest }),
    );
  });

  it("nonce 错的 reject 不改变状态", async () => {
    const row = seed("task_e4");
    await challengeNonce(row.authorizationId, row.bindingDigest);
    const res = await reject(row.authorizationId, {
      bindingDigest: row.bindingDigest, approvalNonce: "wrong-nonce",
    });
    expect(res.status).toBe(409);
    expect(storedRow(row.authorizationId).status).toBe("READY");
  });
});
