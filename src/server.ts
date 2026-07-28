import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import type { Layout } from "./layout.ts";
import { createOAuth, OAuthError, type OAuthConfig } from "./oauth.ts";
import { registeredIds } from "./registry.ts";
import { reconcileRunningJobs } from "./jobs.ts";
import { buildTools, type ToolDef } from "./tools.ts";
import { createAccessGate, AccessDeniedError, type AccessConfig } from "./accessGate.ts";

export interface AppConfig {
  issuer: string;
  layout: Layout;
  db: DatabaseSync;
  /** Cloudflare Access 门禁配置（规格 §7.0⓪）。由调用方在启动时用 loadAccessConfig() 读取——
   *  配置本身缺失/格式错误必须在那一步就拒绝启动，这里只接收已校验好的值，不在每次请求时重读。 */
  accessConfig: AccessConfig;
}

const VALID_REPO_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function toZodSchema(schema: ToolDef["inputSchema"]): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const p = prop as { type?: string; description?: string };
    let zodType: z.ZodTypeAny;
    switch (p.type) {
      case "string": zodType = z.string(); break;
      case "number": zodType = z.number(); break;
      case "array": zodType = z.array(z.any()); break;
      case "boolean": zodType = z.boolean(); break;
      default: zodType = z.any(); break;
    }
    if (p.description) zodType = zodType.describe(p.description);
    shape[key] = (schema.required ?? []).includes(key) ? zodType : zodType.optional();
  }
  return z.object(shape as z.ZodRawShape);
}

/**
 * 401 + `WWW-Authenticate`。**`resource_metadata` 必须是绝对 URL。**
 *
 * U1 实测过 ChatGPT 的发现顺序：先 `POST /mcp/<repoId>` 撞 401，再**顺着这个
 * 响应头**去取每-repo 的元数据。给相对路径的话，能不能解析取决于客户端实现——
 * 而这一步失败的表现是「连接器加不上」这类毫无信息量的报错，排查成本极高。
 * spike 那版给的就是绝对 URL，这里与之保持一致。
 *
 * `repoId` 必须 encode 后再拼：未编码的引号或 CRLF 能直接注入响应头
 * （计划审查 I-5 实测过 `a%22%20error%3D%22x` 与 CRLF 两种形态）。
 */
function unauthorized(issuer: string, repoId: string) {
  const encoded = encodeURIComponent(repoId);
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp/${encoded}`;
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
  });
}

function oauthErrorStatus(e: OAuthError): number {
  switch (e.code) {
    case "invalid_request": return 400;
    case "invalid_client": return 401;
    case "invalid_grant": return 400;
    case "invalid_target": return 400;
    case "unsupported_grant_type": return 400;
    case "invalid_client_metadata": return 400;
    default: return 400;
  }
}

export function createApp(cfg: AppConfig): Hono {
  const { issuer, layout, db, accessConfig } = cfg;

  // 只建一次（进程启动时），不在每次请求里重建——JWKS 拉取器有自己的缓存，
  // 重建等于每次请求都可能重新走一遍网络。
  const assertApproved = createAccessGate(accessConfig);

  const oauthCfg: OAuthConfig = {
    issuer,
    endpointFor: (repoId) => `${issuer}/mcp/${repoId}`,
    isRegistered: (repoId) => registeredIds(layout).has(repoId),
    registeredRepoIds: () => [...registeredIds(layout)].sort(),
    keyPath: join(layout.controlRoot, "secrets", "oauth-key"),
  };
  const oauth = createOAuth(oauthCfg);

  const app = new Hono();

  // 请求日志。spike 版有、本实现漏了——结果是「ChatGPT 报连接失败」时我们只能猜，
  // 因为分不清请求根本没到、还是到了但被某一步拒了。诊断信息只进服务端日志，不回给调用方。
  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    console.log(`[gw] ${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status} (${Date.now() - t0}ms)`);
  });

  app.post("/register", async (c) => {
    try {
      const body = await c.req.json();
      const result = await oauth.register(body);
      return c.json(result);
    } catch (e) {
      if (e instanceof OAuthError) {
        return c.json({ error: e.code, error_description: e.message }, oauthErrorStatus(e) as 200 | 400 | 401);
      }
      throw e;
    }
  });

  app.get("/authorize", async (c) => {
    // 门禁必须是这个 handler 的第一件事——早于 PKCE、早于 client 查找、早于任何 code
    // 生成。Cloudflare Access 挡在前面只是仪表盘设置，能被删除、误配置范围，或者被
    // 直连端口绕过；这里的检查才是把它变成硬约束的那一步（铁律三）。
    try {
      await assertApproved(c.req.raw.headers);
    } catch (e) {
      if (e instanceof AccessDeniedError) {
        // 响应体不带 e.message——那是给运维看的诊断文本，不该回给未经门禁的调用方。
        return c.json({ error: "access_denied" }, 403);
      }
      throw e;
    }

    const q = c.req.query();
    try {
      const code = await oauth.authorize({
        client_id: q.client_id!,
        redirect_uri: q.redirect_uri!,
        code_challenge: q.code_challenge,
        code_challenge_method: q.code_challenge_method,
        resource: q.resource,
        scope: q.scope,
      });
      const redirect = new URL(q.redirect_uri!);
      redirect.searchParams.set("code", code);
      if (q.state) redirect.searchParams.set("state", q.state);
      return c.redirect(redirect.toString(), 302);
    } catch (e) {
      if (e instanceof OAuthError) {
        if (q.redirect_uri) {
          const redirect = new URL(q.redirect_uri);
          redirect.searchParams.set("error", e.code);
          redirect.searchParams.set("error_description", e.message);
          if (q.state) redirect.searchParams.set("state", q.state);
          return c.redirect(redirect.toString(), 302);
        }
        return c.json({ error: e.code, error_description: e.message }, oauthErrorStatus(e) as 200 | 400 | 401);
      }
      throw e;
    }
  });

  app.post("/token", async (c) => {
    try {
      const text = await c.req.text();
      const form = new URLSearchParams(text);
      const result = await oauth.token({
        grant_type: form.get("grant_type")!,
        code: form.get("code") ?? undefined,
        code_verifier: form.get("code_verifier") ?? undefined,
        client_id: form.get("client_id") ?? undefined,
        redirect_uri: form.get("redirect_uri") ?? undefined,
        resource: form.get("resource") ?? undefined,
        refresh_token: form.get("refresh_token") ?? undefined,
        scope: form.get("scope") ?? undefined,
      });
      return c.json(result);
    } catch (e) {
      if (e instanceof OAuthError) {
        return c.json({ error: e.code, error_description: e.message }, oauthErrorStatus(e) as 200 | 400 | 401);
      }
      throw e;
    }
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    return c.json(oauth.authServerMetadata());
  });

  app.get("/jwks", (c) => {
    return c.json({ keys: [] });
  });

  app.get("/.well-known/oauth-protected-resource/mcp/:repoId", (c) => {
    const repoId = c.req.param("repoId");
    const meta = oauth.protectedResourceMetadata(repoId);
    return c.json(meta);
  });

  app.all("/mcp/:repoId", async (c) => {
    const repoId = c.req.param("repoId");
    if (!VALID_REPO_ID.test(repoId)) return c.json({ error: "not_found" }, 404);

    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!bearer) return unauthorized(cfg.issuer, repoId);

    try {
      await oauth.verifyBearer(bearer, oauthCfg.endpointFor(repoId));
    } catch {
      return unauthorized(cfg.issuer, repoId);
    }

    if (!registeredIds(layout).has(repoId)) return c.json({ error: "not_found" }, 404);

    const transport = new WebStandardStreamableHTTPServerTransport();
    const mcpServer = new McpServer(
      { name: `grande-gpt/${repoId}`, version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    const tools = buildTools({ db, layout, repoId });
    for (const tool of tools) {
      mcpServer.registerTool(tool.name, {
        description: tool.description,
        inputSchema: toZodSchema(tool.inputSchema),
        annotations: tool.annotations as any,
      }, async (args) => {
        const result = await tool.handler(args as Record<string, unknown>);
        const sc = result.structuredContent as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(sc) }],
          structuredContent: sc,
        };
      });
    }

    await mcpServer.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    return response;
  });

  return app;
}

export async function startGateway(cfg: AppConfig): Promise<{ app: Hono; close: () => Promise<void> }> {
  reconcileRunningJobs(cfg.db, (pgid) => {
    try { process.kill(-pgid, 0); return true; } catch { return false; }
  });

  const app = createApp(cfg);
  const port = Number(process.env.PORT || "8787");
  const srv = serve({ fetch: app.fetch, port });

  return {
    app,
    close: () => new Promise<void>((resolve, reject) => {
      srv.close((err) => err ? reject(err) : resolve());
    }),
  };
}
