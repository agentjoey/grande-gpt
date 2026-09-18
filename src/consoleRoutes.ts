import type { Context, Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { AccessDeniedError, createAccessGate, type AccessConfig } from "./accessGate.ts";
import { beginAudit } from "./audit.ts";
import { assertConsoleOrigin } from "./consoleAuth.ts";
import { ConsoleRepoOnboardingError, registerConsoleRepo } from "./consoleRepoOnboarding.ts";
import {
  approveAuthorization,
  rejectAuthorization,
  rotateAuthorizationChallenge,
  type DeliveryAuthorizationRow,
} from "./deliveryAuthorization.ts";
import { StateError } from "./errors.ts";
import { requestJobCancellation } from "./jobCancellation.ts";
import { getJob, TERMINAL } from "./jobs.ts";
import { loadLayout } from "./layout.ts";
import { bumpEpoch, currentEpoch } from "./tokenEpoch.ts";

/**
 * 控制台的**写**端点（S2.5 方案 A）。
 *
 * ## 为什么走 Gateway 而不是让控制台自己写库
 *
 * 铁律二：新能力必须先设计高层语义、输入边界、Policy 与审计字段，再注册。
 * 让控制台开一条可写连接等于造出**第二个执行权威**——那正是铁律二要防的。
 *
 * 更实际的一条：走 Gateway 意味着**每个操作自动进审计账本**。控制台自己写库的话，
 * 控制台做的事反而不留痕——一个观察工具在账本上隐身，很荒谬。
 *
 * ## 认证
 *
 * 用**控制台自己的 Access aud**（`access-console.yaml`），不是 `/mcp` 的那个。
 * 请求链路：浏览器 →（Cloudflare 注入 `Cf-Access-Jwt-Assertion`）→ 控制台服务端
 * → 原样转发该 header → 这里校验。
 *
 * ⚠️ **不接受任何形式的「本机就放行」。** 网关虽然只绑 loopback，但本机上跑着
 * 别的东西（包括 ChatGPT 经隧道进来的 MCP 会话）；「在本机」不等于「是你」。
 */

/** 统一的错误信封。不泄漏内部路径与堆栈。 */
function fail(code: string, message: string, status: 400 | 403 | 404 | 409 | 500) {
  return { body: { ok: false as const, error: { code, message } }, status };
}

export interface ConsoleDeps {
  db: DatabaseSync;
  consoleAccess: AccessConfig;
  /**
   * 控制台前端的可信 origin（`access-console.yaml` 的 `origin`，已归一化）。
   * **缺省时审批路由 fail-closed 403**——缺配置的含义是「审批面未安装」，
   * 不是「不校验 Origin」。server.ts 在 consoleAccessConfig 存在时总会带上它；
   * 可选只是为了让既有测试能只挂旧写端点。
   */
  consoleOrigin?: string;
}

export function mountConsoleRoutes(app: Hono, deps: ConsoleDeps): void {
  const assertConsoleUser = createAccessGate(deps.consoleAccess);

  /**
   * 每条路由的第一件事。与 `/authorize` 同一个形状：门禁早于任何业务逻辑，
   * 早于参数解析，早于查库。
   */
  const gate = async (headers: Headers): Promise<null | ReturnType<typeof fail>> => {
    try {
      await assertConsoleUser(headers);
      return null;
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        // 响应体不带 e.message——那是给运维看的诊断，不该回给未经门禁的调用方。
        return fail("access_denied", "需要通过控制台的 Cloudflare Access 认证。", 403);
      }
      throw e;
    }
  };

  /**
   * Console 项目注册。点击按钮本身就是 Human Owner 对这个 repoId 的显式确认；
   * 真正写入仍由 Gateway 内的 canonical onboarding primitive 执行。
   */
  app.post("/console/repos/:repoId/register", async (c) => {
    const denied = await gate(c.req.raw.headers);
    if (denied) return c.json(denied.body, denied.status);

    const repoId = c.req.param("repoId");
    try {
      const data = registerConsoleRepo(deps.db, loadLayout(), repoId);
      return c.json({ ok: true as const, data });
    } catch (error) {
      if (error instanceof ConsoleRepoOnboardingError) {
        const status = error.code === "initialization_failed" || error.code === "registration_failed" ? 500 : 409;
        const f = fail(error.code, error.message, status);
        return c.json(f.body, f.status);
      }
      const f = fail("registration_failed", "项目注册失败；详情见 Gateway 日志。", 500);
      return c.json(f.body, f.status);
    }
  });

  /**
   * 请求取消一个受当前 Gateway supervisor 管理的 job。
   *
   * Console 与 MCP 共用同一 ownership-bound cancellation primitive：这里只接受现有
   * jobId，绝不按数据库里残留的 pgid 直接发信号，也不提前写 terminal state。
   * 真正进程退出、artifact 持久化与容量释放仍由 owning supervisor 的 settlement 完成。
   */
  app.post("/console/jobs/:jobId/kill", async (c) => {
    const denied = await gate(c.req.raw.headers);
    if (denied) return c.json(denied.body, denied.status);

    const jobId = c.req.param("jobId");
    const job = getJob(deps.db, jobId);
    if (!job) {
      const f = fail("not_found", `job ${jobId} 不存在。`, 404);
      return c.json(f.body, f.status);
    }
    if (TERMINAL.has(job.state)) {
      const f = fail("not_running", `job ${jobId} 当前是 ${job.state}，已经结束，无需取消。`, 409);
      return c.json(f.body, f.status);
    }

    try {
      const result = requestJobCancellation(deps.db, job.taskId, jobId, { auditTool: "console_kill_job" });
      return c.json({ ok: true, data: result });
    } catch (error) {
      const code = error instanceof StateError ? error.code : "cancel_failed";
      const status = code === "JOB_NOT_FOUND" ? 404 : code === "POLICY_DENIED" || code === "STALE_STATE" ? 409 : 500;
      const f = fail(code.toLowerCase(), error instanceof Error ? error.message : String(error), status);
      return c.json(f.body, f.status);
    }
  });

  /**
   * 「标记为已知」。**只向 audit_ack 追加一行，绝不修改 audit 原行。**
   *
   * 账本不可篡改是铁律。这个操作的语义是「我看过了，知道这回事」，
   * 不是「这条不存在」——原行仍在账本里，只是不再占用首屏的告警位。
   *
   * 没有它，判据明确的异常会永远挂在首屏，两天后人就开始无视整个告警区，
   * 而那正是设计 §6.2 要避免的事。
   *
   * 幂等：重复 ack 同一条不报错，也不改第一次的时间戳（`DO NOTHING`）。
   */
  app.post("/console/audit/:opId/ack", async (c) => {
    const denied = await gate(c.req.raw.headers);
    if (denied) return c.json(denied.body, denied.status);

    const opId = c.req.param("opId");
    const row = deps.db.prepare("SELECT taskId FROM audit WHERE opId = ?").get(opId) as
      | { taskId: string | null } | undefined;
    if (!row) {
      const f = fail("not_found", `审计操作 ${opId} 不存在。`, 404);
      return c.json(f.body, f.status);
    }

    const audit = beginAudit(deps.db, {
      taskId: row.taskId, tool: "console_audit_ack", input: { opId },
    });
    audit.allowed();
    if (!audit.executing()) {
      const f = fail("stale_state", "ack 的审计句柄无法推进到 EXECUTING。", 409);
      return c.json(f.body, f.status);
    }
    try {
      deps.db.prepare(
        "INSERT INTO audit_ack (opId, ackedAt, note) VALUES (?, ?, NULL) ON CONFLICT(opId) DO NOTHING",
      ).run(opId, Date.now());
      audit.succeeded([]);
      return c.json({ ok: true, data: { opId, acked: true } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit.failed(msg);
      const f = fail("ack_failed", `标记失败：${msg}`, 500);
      return c.json(f.body, f.status);
    }
  });

  /**
   * **彻底断开**：递增 token epoch **＋** 把全部 refresh token 置为失效。
   *
   * CLI 的 `grande revoke` 只做前一步。单做它的话，客户端拿 refresh 一换就自动
   * 恢复了——**你以为断了其实没断**。这个端点存在的全部意义就是把两步合成一个动作。
   */
  app.post("/console/revoke-all", async (c) => {
    const denied = await gate(c.req.raw.headers);
    if (denied) return c.json(denied.body, denied.status);

    const before = currentEpoch(deps.db);
    const audit = beginAudit(deps.db, {
      taskId: null, tool: "console_revoke_all", input: { epochBefore: before },
    });
    audit.allowed();
    if (!audit.executing()) {
      const f = fail("stale_state", "revoke 的审计句柄无法推进到 EXECUTING。", 409);
      return c.json(f.body, f.status);
    }
    try {
      const after = bumpEpoch(deps.db);
      const r = deps.db.prepare("UPDATE oauth_refresh SET valid = 0 WHERE valid = 1").run();
      const invalidated = Number(r.changes ?? 0);
      audit.succeeded([]);
      return c.json({ ok: true, data: { epochBefore: before, epochAfter: after, refreshInvalidated: invalidated } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit.failed(msg);
      const f = fail("revoke_failed", `断开失败：${msg}`, 500);
      return c.json(f.body, f.status);
    }
  });

  /* ================================================================== *
   * Minimal V2 Task 4：Hardened Console delivery 审批 API。             *
   * 设计来源：docs/superpowers/specs/2026-09-04-...-design.md §9。      *
   *                                                                    *
   * 安全边界（与上面旧写端点有意分开，不复用 gate()）：                  *
   * 1. 控制台独立 Access aud 校验，身份只取已验证 JWT 的 sub/email；     *
   * 2. Origin 必须逐字节等于 access-console.yaml 的可信 origin；         *
   *    这两步都在 body 解析【之前】完成。                                *
   * 3. 请求体只接受 exact JSON：challenge 恰好 {bindingDigest}，         *
   *    approve/reject 恰好 {bindingDigest, approvalNonce}——不接受        *
   *    approved=true、approver、taskId、SHA 或任何 deploy 参数。         *
   * 4. 状态转移全部委托 deliveryAuthorization.ts 的单事务 CAS；          *
   *    HTTP handler 绝不执行 merge/deploy（§9.3）。                      *
   * 5. 审计 input 恰好是 {authorizationId, bindingDigest} 的摘要——       *
   *    不含 nonce 明文，不含 JWT。明文 nonce 只出现在 challenge 响应里。 *
   * ================================================================== */

  /** §9.2 要求的响应头：拒绝 iframe 嵌入（clickjacking）、嗅探与 referrer 泄漏。 */
  app.use("/console/delivery/*", async (c, next) => {
    await next();
    c.res.headers.set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("Referrer-Policy", "no-referrer");
  });

  type DeliveryGate =
    | { ok: true; identity: { email: string; sub: string } }
    | { ok: false; failure: ReturnType<typeof fail> };

  /** Access 身份 → Origin，任一失败都 403 且发生在 body 解析之前。 */
  const gateDelivery = async (headers: Headers): Promise<DeliveryGate> => {
    let identity: { email: string; sub: string };
    try {
      identity = await assertConsoleUser(headers);
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        return { ok: false, failure: fail("access_denied", "需要通过控制台的 Cloudflare Access 认证。", 403) };
      }
      throw e;
    }
    const origin = deps.consoleOrigin;
    if (origin === undefined) {
      // fail-closed：没配可信 Origin 的审批面等于没装 CSRF 边界。
      return { ok: false, failure: fail("access_denied", "控制台审批端点未配置可信 Origin，审批 API 保持关闭。", 403) };
    }
    try {
      assertConsoleOrigin(headers, origin);
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        return { ok: false, failure: fail("origin_denied", "Origin 与控制台可信配置不一致。", 403) };
      }
      throw e;
    }
    return { ok: true, identity };
  };

  type ParsedBody =
    | { ok: true; body: Record<string, string> }
    | { ok: false; failure: ReturnType<typeof fail> };

  /**
   * exact JSON：Content-Type 必须是 application/json；解析结果必须是恰好包含
   * `fields` 的平面对象，且每个值都是字符串。多一个字段也不行——否则
   * `approver`、`taskId`、`sha` 之类的自报字段就有了混入业务语义的通道。
   */
  const parseExactJsonBody = async (c: Context, fields: readonly string[]): Promise<ParsedBody> => {
    const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== "application/json") {
      return { ok: false, failure: fail("not_json", "Content-Type 必须是 application/json。", 400) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await c.req.raw.text());
    } catch {
      return { ok: false, failure: fail("bad_json", "请求体不是合法 JSON。", 400) };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, failure: fail("bad_body_shape", `请求体必须是恰好包含 ${fields.join("、")} 的 JSON 对象。`, 400) };
    }
    const obj = parsed as Record<string, unknown>;
    const expected = [...fields].sort();
    const actual = Object.keys(obj).sort();
    if (actual.length !== expected.length || !actual.every((k, i) => k === expected[i])) {
      return { ok: false, failure: fail("bad_body_shape", `请求体必须是恰好包含 ${fields.join("、")} 的 JSON 对象。`, 400) };
    }
    for (const f of fields) {
      if (typeof obj[f] !== "string") {
        return { ok: false, failure: fail("bad_body_shape", `字段 ${f} 必须是字符串。`, 400) };
      }
    }
    return { ok: true, body: obj as Record<string, string> };
  };

  /**
   * §7.3 bounded approval summary：只含 Human 判断需要的字段。binding 本身不含
   * PR 标题/日志等自由文本（摘要天然无 HTML 注入面）；worktreeRealpath 是本机
   * 路径，不属于 Human 的判断依据，不下发。
   */
  const approvalSummary = (row: DeliveryAuthorizationRow): Record<string, unknown> => {
    const b = row.binding;
    const common: Record<string, unknown> = {
      authorizationKind: b.authorizationKind,
      taskId: b.taskId,
      repoId: b.repoId,
      deployTarget: b.deployTarget,
      deploySpecDigest: b.deploySpecDigest,
      policyDigest: b.policyDigest,
      runtimeBuild: b.runtimeBuild,
      toolsetEpoch: b.toolsetEpoch,
      toolsDigest: b.toolsDigest,
      createdAt: b.createdAt,
      expiresAt: b.expiresAt,
    };
    if (b.authorizationKind === "delivery") {
      return {
        ...common,
        prNumber: b.prNumber,
        baseRef: b.baseRef,
        baseSha: b.baseSha,
        headSha: b.headSha,
        mergeMethod: b.mergeMethod,
        expectedMergeTree: b.expectedMergeTree,
        deployRef: b.deployRef,
        verifyRef: b.verifyRef,
      };
    }
    return {
      ...common,
      currentDeploymentId: b.currentDeploymentId,
      currentSourceSha: b.currentSourceSha,
      rollbackDeploymentId: b.rollbackDeploymentId,
      rollbackSourceSha: b.rollbackSourceSha,
      ...(b.rollbackArtifactDigest !== undefined ? { rollbackArtifactDigest: b.rollbackArtifactDigest } : {}),
      rollbackRef: b.rollbackRef,
    };
  };

  /** 审批域错误 → HTTP。AUTH_NOT_FOUND 是 404；digest 漂移/nonce 失配/过期/非法状态都是 409。 */
  const authorizationFailure = (e: unknown): ReturnType<typeof fail> | null => {
    if (!(e instanceof StateError)) return null;
    return fail(e.code.toLowerCase(), e.message, e.code === "AUTH_NOT_FOUND" ? 404 : 409);
  };

  /** 审计 input 恰好是 {authorizationId, bindingDigest}——不含 nonce，不含 JWT。 */
  const beginDeliveryAudit = (tool: string, authorizationId: string, bindingDigest: string) => {
    const row = deps.db
      .prepare("SELECT taskId FROM delivery_authorization WHERE authorizationId=?")
      .get(authorizationId) as { taskId: string } | undefined;
    const audit = beginAudit(deps.db, {
      taskId: row?.taskId ?? null,
      tool,
      input: { authorizationId, bindingDigest },
    });
    audit.allowed();
    return audit;
  };

  app.post("/console/delivery/:authorizationId/challenge", async (c) => {
    const gated = await gateDelivery(c.req.raw.headers);
    if (!gated.ok) return c.json(gated.failure.body, gated.failure.status);
    const parsed = await parseExactJsonBody(c, ["bindingDigest"]);
    if (!parsed.ok) return c.json(parsed.failure.body, parsed.failure.status);

    const authorizationId = c.req.param("authorizationId");
    const bindingDigest = parsed.body.bindingDigest!;
    const audit = beginDeliveryAudit("console_delivery_challenge", authorizationId, bindingDigest);
    if (!audit.executing()) {
      const f = fail("stale_state", "challenge 的审计句柄无法推进到 EXECUTING。", 409);
      return c.json(f.body, f.status);
    }
    try {
      // 明文 nonce 只在这一个响应里出现：库里是 digest，审计与日志都不含它。
      const { row, approvalNonce } = rotateAuthorizationChallenge(deps.db, authorizationId, bindingDigest);
      audit.succeeded([]);
      return c.json({
        ok: true as const,
        data: {
          authorizationId: row.authorizationId,
          bindingDigest: row.bindingDigest,
          status: row.status,
          expiresAt: row.expiresAt,
          summary: approvalSummary(row),
          approvalNonce,
        },
      });
    } catch (e) {
      const f = authorizationFailure(e);
      if (!f) throw e;
      audit.failed(e instanceof Error ? e.message : String(e));
      return c.json(f.body, f.status);
    }
  });

  app.post("/console/delivery/:authorizationId/approve", async (c) => {
    const gated = await gateDelivery(c.req.raw.headers);
    if (!gated.ok) return c.json(gated.failure.body, gated.failure.status);
    const parsed = await parseExactJsonBody(c, ["approvalNonce", "bindingDigest"]);
    if (!parsed.ok) return c.json(parsed.failure.body, parsed.failure.status);

    const authorizationId = c.req.param("authorizationId");
    const bindingDigest = parsed.body.bindingDigest!;
    const audit = beginDeliveryAudit("console_delivery_approve", authorizationId, bindingDigest);
    if (!audit.executing()) {
      const f = fail("stale_state", "approve 的审计句柄无法推进到 EXECUTING。", 409);
      return c.json(f.body, f.status);
    }
    try {
      // §9.3：点击 Approve 只产生 durable authorization；merge/deploy 由后续
      // GrandeGPT 工具推进，HTTP handler 内零执行。身份只来自已验证 JWT。
      const row = approveAuthorization(deps.db, {
        authorizationId,
        bindingDigest,
        approvalNonce: parsed.body.approvalNonce!,
        identity: { sub: gated.identity.sub, email: gated.identity.email },
      });
      audit.succeeded([]);
      return c.json({
        ok: true as const,
        data: {
          authorizationId: row.authorizationId,
          bindingDigest: row.bindingDigest,
          status: row.status,
          expiresAt: row.expiresAt,
        },
      });
    } catch (e) {
      const f = authorizationFailure(e);
      if (!f) throw e;
      audit.failed(e instanceof Error ? e.message : String(e));
      return c.json(f.body, f.status);
    }
  });

  app.post("/console/delivery/:authorizationId/reject", async (c) => {
    const gated = await gateDelivery(c.req.raw.headers);
    if (!gated.ok) return c.json(gated.failure.body, gated.failure.status);
    const parsed = await parseExactJsonBody(c, ["approvalNonce", "bindingDigest"]);
    if (!parsed.ok) return c.json(parsed.failure.body, parsed.failure.status);

    const authorizationId = c.req.param("authorizationId");
    const bindingDigest = parsed.body.bindingDigest!;
    const audit = beginDeliveryAudit("console_delivery_reject", authorizationId, bindingDigest);
    if (!audit.executing()) {
      const f = fail("stale_state", "reject 的审计句柄无法推进到 EXECUTING。", 409);
      return c.json(f.body, f.status);
    }
    try {
      // READY → REJECTED；尚未执行的 APPROVED → REVOKED（§9.3）。EXECUTING 及
      // 以后由 domain helper 抛 STALE_STATE——已发生的 side effect 走运维路径。
      const row = rejectAuthorization(deps.db, {
        authorizationId,
        bindingDigest,
        approvalNonce: parsed.body.approvalNonce!,
        identity: { sub: gated.identity.sub, email: gated.identity.email },
      });
      audit.succeeded([]);
      return c.json({
        ok: true as const,
        data: {
          authorizationId: row.authorizationId,
          bindingDigest: row.bindingDigest,
          status: row.status,
          expiresAt: row.expiresAt,
        },
      });
    } catch (e) {
      const f = authorizationFailure(e);
      if (!f) throw e;
      audit.failed(e instanceof Error ? e.message : String(e));
      return c.json(f.body, f.status);
    }
  });
}
