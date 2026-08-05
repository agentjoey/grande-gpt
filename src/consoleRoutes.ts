import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { AccessDeniedError, createAccessGate, type AccessConfig } from "./accessGate.ts";
import { beginAudit } from "./audit.ts";
import { getJob, finishJob } from "./jobs.ts";
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
   * 杀掉一个在跑的 job。
   *
   * 这是控制台**净增**的能力：此前只能手工 `kill -TERM -<pgid>`，没有工具也没有 CLI。
   *
   * 语义：向**进程组**发 TERM（runner 用 `detached` 起的进程，pgid == pid），
   * 然后把 job 置为 `cancelled`。不动任何文件，所以不是破坏性操作。
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
    if (job.state !== "running") {
      // 幂等的失败：已经结束了就说清楚，不假装成功也不当作错误重试。
      const f = fail("not_running", `job ${jobId} 当前是 ${job.state}，不是 running，无需杀。`, 409);
      return c.json(f.body, f.status);
    }
    if (job.pgid === null || job.pgid === undefined) {
      const f = fail("no_pgid", `job ${jobId} 没有记录 pgid，无法定位进程组。`, 409);
      return c.json(f.body, f.status);
    }

    const audit = beginAudit(deps.db, {
      taskId: job.taskId, tool: "console_kill_job", input: { jobId },
    });
    audit.allowed();
    if (!audit.executing()) {
      const f = fail("stale_state", `job ${jobId} 的审计句柄无法推进到 EXECUTING。`, 409);
      return c.json(f.body, f.status);
    }
    try {
      // 负号 = 整个进程组。与 runner 的超时兜底同一路径。
      process.kill(-job.pgid, "SIGTERM");
      finishJob(deps.db, jobId, {
        state: "cancelled", exitCode: null, artifactPath: null,
        summary: { cancelledBy: "console", note: "由控制台手工终止" },
      });
      audit.succeeded([]);
      return c.json({ ok: true, data: { jobId, pgid: job.pgid, state: "cancelled" } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit.failed(msg);
      // ESRCH = 进程已经不在了。库里还写着 running 说明是漏对账，顺手修正。
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        finishJob(deps.db, jobId, {
          state: "cancelled", exitCode: null, artifactPath: null,
          summary: { cancelledBy: "console", note: "进程组已不存在，对账修正" },
        });
        return c.json({ ok: true, data: { jobId, pgid: job.pgid, state: "cancelled", note: "进程组已不存在，已修正库状态" } });
      }
      const f = fail("kill_failed", `向进程组 ${job.pgid} 发送 TERM 失败：${msg}`, 500);
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
}
