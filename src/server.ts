import { join } from "node:path";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { DatabaseSync } from "node:sqlite";
import type { Layout } from "./layout.ts";
import { createOAuth, OAuthError, type OAuthConfig } from "./oauth.ts";
import { registeredIds } from "./registry.ts";
import { reconcileRunningJobs } from "./jobs.ts";
import { buildTools, type ToolDef } from "./tools.ts";
import { createAccessGate, AccessDeniedError, type AccessConfig } from "./accessGate.ts";
import { assertDistinctAudience } from "./consoleAuth.ts";
import { mountConsoleRoutes } from "./consoleRoutes.ts";
import {
  jsonByteLength,
  requestCorrelation,
  type McpCallMetrics,
} from "./mcpTelemetry.ts";

export interface AppConfig {
  issuer: string;
  layout: Layout;
  db: DatabaseSync;
  /** Cloudflare Access 门禁配置（规格 §7.0⓪）。由调用方在启动时用 loadAccessConfig() 读取——
   *  配置本身缺失/格式错误必须在那一步就拒绝启动，这里只接收已校验好的值，不在每次请求时重读。 */
  accessConfig: AccessConfig;
  /**
   * 控制台的 Access 配置（`access-console.yaml`）。**可选**：不给就不挂写端点，
   * 而不是挂一组没有门禁的路由——缺配置的含义是「门禁没装」，不是「不需要门禁」。
   */
  consoleAccessConfig?: AccessConfig;
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
 * U1 实测过 ChatGPT 的发现顺序：先撞 401，再**顺着这个响应头**去取元数据。
 * 给相对路径的话，能不能解析取决于客户端实现——而这一步失败的表现是
 * 「连接器加不上」这类毫无信息量的报错，排查成本极高。spike 那版给的就是
 * 绝对 URL，这里与之保持一致。
 *
 * D18：单一端点之后元数据 URL 不再嵌 `repoId`——`/mcp/:repoId` 别名路由收到
 * 的 401 同样指向这**一份**元数据，旧连接器据此重新发现到单一 `resource`，
 * 换到的令牌 `aud` 精确等于 `${issuer}/mcp`，在 `/mcp` 与 `/mcp/:repoId` 两条
 * 路由上都能验证通过（见 `verifyBearer` 调用处）。
 */
function unauthorized(issuer: string) {
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;
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

  // 控制台写端点（S2.5 方案 A）。两个 aud 必须不同，否则拒绝启动——
  // 相同的话隔离静默失效，而一切看起来都正常工作（见 consoleAuth.ts）。
  if (cfg.consoleAccessConfig) {
    assertDistinctAudience(accessConfig, cfg.consoleAccessConfig);
  }

  const oauthCfg: OAuthConfig = {
    issuer,
    // D18：单一端点，不再按 repoId 参数化。
    endpointFor: () => `${issuer}/mcp`,
    keyPath: join(layout.controlRoot, "secrets", "oauth-key"),
    // client 与 refresh_token 落在这同一个状态库（oauth_client / oauth_refresh，
    // 见 db.ts）——db 已经在 main.ts 里用 openDb(layout) 打开过，两张表已就位，
    // 这里直接透传，不重新开一个连接。
    db,
  };
  const oauth = createOAuth(oauthCfg);

  const app = new Hono();

  /** 日志时间戳：本地时区的 `HH:MM:SS.mmm`，只够用来量两次调用之间的间隔。 */
  const ts = (): string => {
    const d = new Date();
    const p = (n: number, w = 2): string => String(n).padStart(w, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };

  const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";

  /** JSON-RPC 请求 id 只能是 string / number / null；非法值不能原样回显。 */
  function jsonRpcId(value: unknown): string | number | null {
    return typeof value === "string" || typeof value === "number" || value === null ? value : null;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function jsonRpcError(c: Context, id: string | number | null, code: number, message: string) {
    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }, 400);
  }

  /**
   * ChatGPT 已开始先用 2026-era `server/discover` 选择协议，而当前 SDK 1.x 只会
   * 将该请求折叠为 `-32000` / `id: null` 的通用 400。这里不伪装成支持 modern MCP：
   * 明确返回标准 `UnsupportedProtocolVersion`，让客户端选 SDK 实际支持的 legacy
   * 版本后再走 `initialize`。其他请求仍交给 SDK，避免把未实现的 2026-era wire
   * 误报为可用。
   */
  async function modernDiscoverFallback(c: Context): Promise<Response | undefined> {
    if (c.req.header("mcp-protocol-version") !== MODERN_MCP_PROTOCOL_VERSION) return undefined;

    let request: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await c.req.raw.clone().text()) as unknown;
      if (!isRecord(parsed)) return undefined;
      request = parsed;
    } catch {
      return undefined;
    }
    if (request.method !== "server/discover") return undefined;

    const id = jsonRpcId(request.id);
    // MCP 2026 要求传输层的 Mcp-Method 与请求体一致；不能因 SDK 尚未支持
    // discover 就跳过这一层验证、把损坏的请求伪装成可安全降级。
    if (c.req.header("mcp-method") !== "server/discover") {
      return jsonRpcError(c, id, -32020, "Header mismatch: Mcp-Method must match the JSON-RPC method");
    }

    const params = isRecord(request.params) ? request.params : undefined;
    const meta = params && isRecord(params._meta) ? params._meta : undefined;
    const bodyProtocolVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof bodyProtocolVersion !== "string" || !isRecord(meta?.["io.modelcontextprotocol/clientCapabilities"])) {
      return jsonRpcError(c, id, -32602, "Invalid params: server/discover requires protocolVersion and clientCapabilities metadata");
    }
    if (bodyProtocolVersion !== MODERN_MCP_PROTOCOL_VERSION) {
      return jsonRpcError(c, id, -32020, "Header mismatch: MCP-Protocol-Version must match the request metadata");
    }

    console.log(
      `[rpc] ${ts()} server/discover #${String(id)} protocol=${MODERN_MCP_PROTOCOL_VERSION} outcome=legacy_fallback`,
    );
    return c.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: {
          supported: SUPPORTED_PROTOCOL_VERSIONS,
          requested: MODERN_MCP_PROTOCOL_VERSION,
        },
      },
    }, 400);
  }

  /**
   * JSON-RPC 方法级日志（遗留 #4 上半）。
   *
   * ## 为什么需要
   *
   * 在此之前 `/mcp` 上只有两种痕迹：`[gw] POST /mcp → 200`（不区分方法）与
   * `[tool] <名字>`（只在工具**被调用**时才有）。中间整整缺一层：
   * **客户端取过几次工具表、每次拿走了几个工具，完全看不见。**
   *
   * 2026-07-29 那次故障正卡在这里——模型能列出写工具却调不动，而服务端日志里
   * 连一条请求都没有。当时为了拿到「服务端视角的工具表」，只能临时用库里的
   * 签名密钥自签一枚 token 手查。那不该是排查时才现想的招（下半见
   * `grande selfcheck`）。
   *
   * ## 为什么在这一层、且要重建 Request
   *
   * `tools/list` 由 MCP SDK 内部应答，`registerTool` 的回调只在 `tools/call`
   * 时触发，所以工具级日志天然看不到它。唯一能看到方法名的地方是进 transport
   * 之前的原始 body——**而 body 只能读一次**，读完必须用同样的内容重建一个
   * Request 交下去，否则 transport 拿到的是空的。
   *
   * 只记方法名与 id，**不记参数**：`tools/call` 的参数已经由 `[tool]` 那行
   * 记了（并且那里是解析过的），在这里再记一遍等于把同一份内容（可能含文件
   * 内容）写进日志两次。
   *
   * 响应侧（客户端到底拿走了多大一份工具表）**有意不在这里做**：
   * StreamableHTTP 的响应可能是 SSE 流，clone 出来读完会把流缓冲住甚至阻塞。
   * 那个问题归 `grande selfcheck`——它是我们自己的客户端，可以安全地读完整响应。
   */
  async function logRpc(raw: Request, toolCount: number): Promise<Request> {
    if (raw.method !== "POST") return raw;
    let body: string;
    try {
      body = await raw.text();
    } catch {
      return raw;   // 读不出来就别耽误正事，日志不是关键路径
    }
    try {
      const msg = JSON.parse(body) as { method?: unknown; id?: unknown };
      if (typeof msg.method === "string") {
        // 只有 tools/list 附带工具数——它是这条日志存在的理由。
        const extra = msg.method === "tools/list" ? ` (${toolCount} 个工具)` : "";
        const id = msg.id === undefined ? "notif" : `#${String(msg.id)}`;
        console.log(`[rpc] ${ts()} ${msg.method} ${id}${extra}`);
      }
    } catch {
      console.log(`[rpc] ${ts()} <body 不是合法 JSON，${body.length} 字节>`);
    }
    // headers 原样带上；body 换成刚读出来的字符串（content-length 不变）。
    return new Request(raw.url, { method: raw.method, headers: raw.headers, body });
  }

  // 请求日志。spike 版有、本实现漏了——结果是「ChatGPT 报连接失败」时我们只能猜，
  // 因为分不清请求根本没到、还是到了但被某一步拒了。诊断信息只进服务端日志，不回给调用方。
  //
  // **每行带墙钟时间戳**：单看「耗时 Nms」只覆盖服务端处理那一段，测不出**两次调用
  // 之间**模型自己等了多久。而 P-1（模型是否自主轮询 `grande_run_result` 直到终态）
  // 恰恰只能从调用间隔看出来——第一次测 P-1 时日志没有时间戳，只能数出「调了 1 次」，
  // 却说不出它等了 20 秒还是 2 秒。
  app.use("*", async (c, next) => {
    const t0 = Date.now();
    await next();
    console.log(
      `[gw] ${ts()} ${c.req.method} ${new URL(c.req.url).pathname} → ${c.res.status} (${Date.now() - t0}ms)`,
    );
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
        // 出错时也是 302（把 error 带回 redirect_uri，这是 OAuth 的规定动作），
        // 所以光看状态码分不清成功与失败——必须把错误码记进服务端日志，
        // 否则「ChatGPT 显示连接失败」时我们只能猜是哪一步。
        console.error(`[gw] /authorize 拒绝: ${e.code} — ${e.message}`);
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
    let requestedGrant = "missing";
    try {
      const text = await c.req.text();
      const form = new URLSearchParams(text);
      requestedGrant = form.get("grant_type") ?? "missing";
      const result = await oauth.token({
        grant_type: requestedGrant,
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
        const grant = ["authorization_code", "refresh_token"].includes(requestedGrant)
          ? requestedGrant
          : "other";
        console.warn(`[auth] /token denied grant=${grant} error=${e.code}`);
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

  // D18：单一发现文档。
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    return c.json(oauth.protectedResourceMetadata());
  });

  // 旧连接器兼容别名——`/mcp/<repoId>` 时代留下的发现 URL 若被缓存，仍指向
  // 同一份（单一）元数据，不是一份「per-repo 但内容凑巧相同」的文档。
  app.get("/.well-known/oauth-protected-resource/mcp/:repoId", (c) => {
    return c.json(oauth.protectedResourceMetadata());
  });

  /**
   * D18 核心路由：单一 `/mcp` 端点，`repoId` 不再是端点的一部分。
   *
   * `defaultRepoId` 只有一个来源——`/mcp/:repoId` 这条**别名**路由（下面单独
   * 注册，调用同一个 handler）。它只影响「没有 taskId 时该浏览哪个仓库」这一
   * 类只读工具的默认值，**绝不**参与鉴权、也绝不能覆盖由 `taskId` 推导出的
   * 仓库——那条推导路径完全在 tools.ts 里，本函数不掺和。
   */
  async function handleMcp(c: Context, defaultRepoId: string | undefined) {
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!bearer) {
      console.warn("[auth] /mcp denied reason=missing_bearer");
      return unauthorized(cfg.issuer);
    }

    try {
      await oauth.verifyBearer(bearer, oauthCfg.endpointFor());
    } catch {
      console.warn("[auth] /mcp denied reason=invalid_bearer");
      return unauthorized(cfg.issuer);
    }

    // 别名路由带着的 repoId 若已被撤销注册，行为与 D5 时代一致：404，且不
    // 泄漏工作区里还有哪些目录。`/mcp`（无路径参数）没有这一步。
    if (defaultRepoId !== undefined && !registeredIds(layout).has(defaultRepoId)) {
      return c.json({ error: "not_found" }, 404);
    }

    const modernFallback = await modernDiscoverFallback(c);
    if (modernFallback) return modernFallback;

    // Keep this per-request value outside the SDK callback. The helper reads
    // only Mcp-Session-Id; Authorization and the raw request body never enter
    // telemetry or its digest.
    const correlation = requestCorrelation(c.req.raw.headers);
    const transport = new WebStandardStreamableHTTPServerTransport();
    const mcpServer = new McpServer(
      { name: "grande-gpt", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );

    const tools = buildTools({ db, layout, defaultRepoId });
    for (const tool of tools) {
      mcpServer.registerTool(tool.name, {
        description: tool.description,
        inputSchema: toZodSchema(tool.inputSchema),
        annotations: tool.annotations as any,
      }, async (args) => {
        // 工具级日志。没有它，服务端只看得到 `POST /mcp → 200`，分不清模型调了哪个
        // 工具、参数是什么、成没成功——而规格 §9.2 的 AC-13 要记的正是「模型选错
        // 工具的次数」。用户在 ChatGPT 界面里也看不到，所以这是唯一的观察点。
        // 只读工具不走审计账本，日志是它们唯一的痕迹。
        const t0 = Date.now();
        const result = await tool.handler(args as Record<string, unknown>);
        const sc = result.structuredContent as Record<string, unknown>;
        const ok = sc.ok === true;
        // Arguments may contain complete file bodies, PR text, deployment data,
        // or credentials accidentally supplied to a wrong field. Keep enough
        // metadata to diagnose tool selection without persisting caller values.
        const metrics: McpCallMetrics = {
          correlation,
          inputBytes: jsonByteLength(args),
          outputBytes: jsonByteLength(sc),
        };
        const argKeys = Object.keys(args).sort().join(",");
        console.log(
          `[tool] ${ts()} ${tool.name} correlation=${metrics.correlation} inputBytes=${metrics.inputBytes} ` +
          `outputBytes=${metrics.outputBytes} argKeys=[${argKeys}] result=${ok ? "ok" : "error"} ` +
          `durationMs=${Date.now() - t0}`,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(sc) }],
          structuredContent: sc,
        };
      });
    }

    await mcpServer.connect(transport);
    const response = await transport.handleRequest(await logRpc(c.req.raw, tools.length));
    return response;
  }

  if (cfg.consoleAccessConfig) {
    mountConsoleRoutes(app, { db, consoleAccess: cfg.consoleAccessConfig });
  }

  app.all("/mcp", (c) => handleMcp(c, undefined));

  // 别名：existing ChatGPT 连接器指着 `/mcp/grande-gpt` 之类的 URL，必须继续
  // 工作（D18 要求「不破坏现有连接器」）。`repoId` 段形状异常（可能是响应头
  // 注入探测）直接 404，不进入 handleMcp——与旧行为一致。
  app.all("/mcp/:repoId", (c) => {
    const repoId = c.req.param("repoId");
    if (!VALID_REPO_ID.test(repoId)) return c.json({ error: "not_found" }, 404);
    return handleMcp(c, repoId);
  });

  return app;
}

export async function startGateway(cfg: AppConfig): Promise<{ app: Hono; close: () => Promise<void> }> {
  reconcileRunningJobs(cfg.db, (pgid) => {
    try { process.kill(-pgid, 0); return true; } catch { return false; }
  });

  const app = createApp(cfg);
  const port = Number(process.env.PORT || "8787");

  /**
   * ⚠️ **hostname 必须显式给出。**
   *
   * `serve({ fetch, port })` 不带 hostname 时 `@hono/node-server` 绑的是**所有网卡**
   * （`*:8787`），不是 loopback。2026-08-02 实测：同一 Wi-Fi 上用本机 LAN IP
   * （`192.168.0.14:8787`）可以直接连到网关。
   *
   * 核心防线当时没破——`/mcp` 仍要 bearer（401）、`/authorize` 仍要 Access JWT（403）。
   * **但「隧道 + Cloudflare Access 是唯一入口」这个纵深防御假设是假的**，
   * 而设计文档与 CLAUDE.md 一直是那么写的。`/register`（DCR）更是完全没有门禁。
   *
   * Cloudflare 隧道不受影响：`~/.cloudflared/grande-gpt.yml` 指的是
   * `http://localhost:8787`，cloudflared 是本机进程，走 loopback。
   *
   * `HOST` 环境变量留给测试用（要验证「非 loopback 连不上」就得先能绑上去）。
   */
  const hostname = process.env.GRANDE_HOST ?? "127.0.0.1";
  const srv = serve({ fetch: app.fetch, port, hostname });

  return {
    app,
    close: () => new Promise<void>((resolve, reject) => {
      srv.close((err) => err ? reject(err) : resolve());
    }),
  };
}
