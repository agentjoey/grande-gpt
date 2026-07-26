import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, decodeJwt } from "jose";
import { z } from "zod";

/**
 * U1 spike：最小 OAuth 2.1 + PKCE(S256) 授权服务器 + 受保护的 MCP 端点。
 *
 * 目的不是造一个通用 AS，是造一个「假到刚好能验证 ChatGPT 是否会做 OAuth 握手」的
 * 靶子——凡是规格明确要求「必须」的地方（PKCE 强制、发现文档字段、401 +
 * WWW-Authenticate、aud 绑定），这里按真实语义实现，不做条件性旁路；凡是规格没
 * 要求的地方（client 是否落库比对、redirect_uri 是否与注册值核对），这里从简，
 * 因为过度实现反而会掩盖「ChatGPT 到底发了什么」这个观察目标——尤其是 client_id
 * 可能来自 CIMD（client_id 本身是一个元数据 URL），从未调用过 /register，若在
 * /authorize 里强制要求 client 已注册，会把 CIMD 路径直接堵死。
 *
 * 每个端点都把收到的参数原样打到 stdout；人类跑 Step 4 时，这份日志是唯一能看到
 * ChatGPT 实际行为的窗口，所以任何请求体解析失败都必须先记录再返回错误，不能
 * 静默 500——那样连"它发了什么"都无从得知。
 */

const PORT = Number(process.env.PORT ?? 8788);
const ISSUER = process.env.ISSUER ?? `https://oauth-spike.agentjoey.ai`;
const RESOURCE = `${ISSUER}/mcp`;
const SCOPE = "grande:spike";
const KEY = new TextEncoder().encode(process.env.OAUTH_SECRET ?? randomBytes(32).toString("hex"));

/** 单用户 spike：授权码与已注册 client 都放内存 */
const codes = new Map<string, { challenge: string; clientId: string }>();
const clients = new Map<string, { redirectUris: string[] }>();

const app = new Hono();
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version", "WWW-Authenticate"],
  }),
);

// ① 受保护资源元数据 —— ChatGPT 从 401 的 WWW-Authenticate 找到这里
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [SCOPE] }),
);
app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  c.json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [SCOPE] }),
);

// ② 授权服务器元数据
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    jwks_uri: `${ISSUER}/jwks`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }),
);

// ③ 动态客户端注册（DCR）——规范说可选，但先实现，看 ChatGPT 走不走这条路径
// 还是走 CIMD（client_id 直接是元数据 URL，跳过 /register）。
app.post("/register", async (c) => {
  const body = (await c.req.json().catch((e: unknown) => {
    console.error("[oauth] /register 请求体不是合法 JSON：", String(e));
    return null;
  })) as { redirect_uris?: string[] } | null;
  if (body === null) {
    return c.json({ error: "invalid_client_metadata" }, 400);
  }
  console.log("[oauth] /register ←", JSON.stringify(body));
  const clientId = `client_${randomUUID()}`;
  clients.set(clientId, { redirectUris: body.redirect_uris ?? [] });
  return c.json(
    { client_id: clientId, redirect_uris: body.redirect_uris ?? [], token_endpoint_auth_method: "none" },
    201,
  );
});

// ④ 授权端点：spike 直接同意，不做登录页
app.get("/authorize", (c) => {
  const q = c.req.query();
  console.log("[oauth] /authorize ←", JSON.stringify(q));

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(q.redirect_uri ?? "");
  } catch {
    // redirect_uri 本身不可用时不能重定向回去报错（会打到未知目的地），
    // 只能直接 400，并把收到的原始值记下来。
    console.error("[oauth] /authorize 缺少或非法的 redirect_uri：", q.redirect_uri);
    return c.json({ error: "invalid_request", error_description: "missing or invalid redirect_uri" }, 400);
  }

  // OAuth 2.1：PKCE 强制，且只认 S256。code_challenge 缺失、或 method 不是
  // "S256"（包括省略时 RFC 7636 默认退化成的 "plain"），一律当 invalid_request——
  // 不能像"有值才校验、没值就放行"那样悄悄接受无 PKCE 的授权码，那样会把
  // "ChatGPT 是否真的做了 PKCE"这个观察目标本身破坏掉，变成自问自答。
  // （直接在 if 条件里判 q.code_challenge，而不是先拆成布尔量——这样 TS 才能把
  // 下面 codes.set 里的 q.code_challenge 从 string|undefined 收窄成 string。）
  if (!q.code_challenge || q.code_challenge_method !== "S256" || q.response_type !== "code") {
    console.error("[oauth] /authorize 拒绝：", {
      response_type: q.response_type,
      code_challenge_present: Boolean(q.code_challenge),
      code_challenge_method: q.code_challenge_method,
    });
    redirectUrl.searchParams.set("error", "invalid_request");
    redirectUrl.searchParams.set(
      "error_description",
      q.response_type !== "code" ? "response_type must be code" : "code_challenge with S256 is required",
    );
    if (q.state) redirectUrl.searchParams.set("state", q.state);
    return c.redirect(redirectUrl.toString(), 302);
  }

  const code = randomUUID();
  codes.set(code, { challenge: q.code_challenge, clientId: q.client_id ?? "" });
  redirectUrl.searchParams.set("code", code);
  if (q.state) redirectUrl.searchParams.set("state", q.state);
  return c.redirect(redirectUrl.toString(), 302);
});

// ⑤ 令牌端点：校验 PKCE S256（无条件——不存在"没带 challenge 就跳过"的分支）
app.post("/token", async (c) => {
  const form = await c.req.parseBody().catch((e: unknown) => {
    console.error("[oauth] /token 请求体解析失败：", String(e));
    return null;
  });
  if (form === null) {
    return c.json({ error: "invalid_request" }, 400);
  }
  console.log("[oauth] /token ←", JSON.stringify(form));

  const grantType = String(form.grant_type ?? "");
  if (grantType !== "authorization_code") {
    console.error("[oauth] /token 不支持的 grant_type：", grantType);
    return c.json({ error: "unsupported_grant_type" }, 400);
  }

  const code = String(form.code ?? "");
  const verifier = String(form.code_verifier ?? "");
  const rec = codes.get(code);
  if (!rec) {
    console.error("[oauth] /token 未知或已使用过的 code：", code);
    return c.json({ error: "invalid_grant" }, 400);
  }
  codes.delete(code); // 一次性：无论下面校验是否通过都要吊销，防止重放

  // rec.challenge 在 /authorize 里已经保证非空（PKCE 强制），这里不写成
  // `rec.challenge && computed !== rec.challenge` 这种"有才校验"的条件式——
  // 缺 verifier 或算出来不匹配，无条件拒绝。
  if (!verifier) {
    console.error("[oauth] /token 缺少 code_verifier");
    return c.json({ error: "invalid_grant", error_description: "code_verifier required" }, 400);
  }
  const computed = createHash("sha256").update(verifier).digest("base64url");
  if (computed !== rec.challenge) {
    console.error("[oauth] PKCE 校验失败", { computed, expected: rec.challenge });
    return c.json({ error: "invalid_grant", error_description: "PKCE mismatch" }, 400);
  }

  const token = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setSubject("spike-user")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(KEY);
  console.log("[oauth] /token → 签发 access_token", { aud: RESOURCE, scope: SCOPE, clientId: rec.clientId });
  return c.json({ access_token: token, token_type: "Bearer", expires_in: 3600, scope: SCOPE });
});

app.get("/jwks", (c) => c.json({ keys: [] })); // HS256 对称密钥，无公钥可发布；仅为满足发现文档字段完整

// ⑥ 受保护的 MCP 端点
app.all("/mcp", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) {
    console.log("[oauth] /mcp ← 无 Bearer，返回 401");
    return new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"` },
    });
  }

  try {
    const { payload } = await jwtVerify(bearer, KEY, { issuer: ISSUER, audience: RESOURCE });
    if (!String(payload.scope ?? "").split(" ").includes(SCOPE)) {
      throw new Error(`scope 不含 ${SCOPE}（实际 ${String(payload.scope)}）`);
    }
    console.log("[oauth] /mcp ← 已认证请求", { sub: payload.sub, aud: payload.aud, scope: payload.scope });
  } catch (e) {
    // token 校验失败时，即使拒绝请求，也把（未验证的）payload 解出来记进日志——
    // 这不是信任它，只是为了在人类跑 Step 4 失败时，日志里能看到 ChatGPT
    // 实际发来的 aud/iss/exp 长什么样，而不是只有一句"校验失败"。
    let claims: unknown = "<无法解析 token payload>";
    try {
      claims = decodeJwt(bearer);
    } catch {
      /* 连 payload 都解不出来，claims 保持占位符 */
    }
    console.error("[oauth] token 校验失败", { error: String(e), claims });
    return new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"` },
    });
  }

  const server = new McpServer({ name: "grande-oauth-spike", version: "0.0.0" });
  server.registerTool(
    "spike_ping",
    {
      title: "Ping",
      description: "验证 OAuth 握手成功后工具可被调用。返回一个固定字符串。",
      inputSchema: { note: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ note }) => ({
      content: [{ type: "text", text: `pong${note ? ` (${note})` : ""}` }],
      structuredContent: { ok: true, pong: true, note: note ?? null },
    }),
  );
  // 无状态：每个请求一个新 McpServer + transport，不传 sessionIdGenerator。
  // ChatGPT 被观察到会为每次工具调用开新的 MCP session。
  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

app.get("/healthz", (c) => c.text("ok"));

serve({ fetch: app.fetch, port: PORT });
console.log(`[oauth] listening on http://127.0.0.1:${PORT}  ISSUER=${ISSUER}`);
