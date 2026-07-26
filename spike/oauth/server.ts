import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, decodeJwt } from "jose";
import { z } from "zod";

/**
 * OAuth 2.1 + PKCE(S256) 授权服务器 + 受保护的、按 repo 拆分的 MCP 端点。
 *
 * 这不再是一次性的 spike 代码 —— 方向已定（规格 D16/D17），这是真实认证层的原型。
 * 规格 D5 的原话：「每 repo 一个 MCP 端点 `/mcp/<repoId>`；OAuth 令牌按端点签发并
 * 绑定 repoId。隔离由协议层保证，且 `repoId` 不作为工具参数」。
 *
 * D5 能不能兑现，全看 `aud` 这一个字段：如果令牌的 `aud` 不是「签给哪个端点就只认
 * 哪个端点」，那么「每 repo 一个端点」只是一个命名习惯，任何 repo 的令牌都能拿去
 * 用在任何别的 repo 上，隔离形同虚设。所以这版实现的核心不是路由拆分本身（拆路由
 * 很容易），而是：
 *
 *   1. `aud` 必须是签发时那个具体端点的完整 URL（`${ISSUER}/mcp/<repoId>`），不是
 *      泛泛的 issuer 或者一个共享 resource 常量；
 *   2. repoId 到 `aud`/`scope` 的绑定必须发生在 `/authorize` 这一步（用户同意的
 *      那一刻），并且写死进单次授权码里；`/token` 即使收到客户端传来的 `resource`/
 *      `scope` 参数，也只拿来做一致性校验、绝不用它覆盖已绑定的值 —— 否则会开一个
 *      「code 是为 repo-a 发的、但 token 兑换时声称给 repo-b」的重定向攻击窗口；
 *   3. 每个 `/mcp/:repoId` 端点校验 `aud` 时，比较对象必须是 *自己* 的 resource
 *      URL，不能共用一个全局值 —— 不然即使 `aud` 字段本身正确记录了签发目标，
 *      验证端也可能对所有 repo 一视同仁地放行。
 *
 * 凡是规格明确要求「必须」的地方（PKCE 强制、发现文档字段、401 + WWW-Authenticate、
 * aud 绑定端点），按真实语义实现，不做条件性旁路；凡是规格没要求的地方（client 是否
 * 落库比对、redirect_uri 是否与注册值核对、是否有登录页），从简 —— 过度实现反而会
 * 掩盖「ChatGPT 到底发了什么」这个观察目标，尤其是 client_id 可能来自 CIMD（本身是
 * 一个元数据 URL，从未调用过 /register），强制要求 client 已注册会把 CIMD 路径堵死。
 *
 * 每个端点都把收到的参数原样打到 stdout；人类跑 ChatGPT 交互时，这份日志是唯一能
 * 看到 ChatGPT 实际行为的窗口 —— 它到底发没发 `resource`/`scope`、`aud` 有没有
 * 被正确带回来 —— 所以任何请求体解析失败都必须先记录再返回错误，不能静默 500。
 *
 * 之前版本里发现并修掉的一个真实绕过：`/token` 曾写成 `rec.challenge && ...`，在
 * 客户端不传 `code_challenge` 时静默跳过整个 PKCE 校验。已改为无条件强制，这版
 * 照旧保留（见下方 `/token`），没有再引入等价的旁路。
 */

const PORT = Number(process.env.PORT ?? 8787);
// 没有配置 ISSUER 时退回本机回环地址，而不是硬编码某个外部域名——避免在配置缺失时
// 悄悄冒充生产域名签发看似有效的 token。生产运行必须由 .env 提供 ISSUER。
const ISSUER = process.env.ISSUER ?? `http://127.0.0.1:${PORT}`;
const KEY = new TextEncoder().encode(process.env.OAUTH_SECRET ?? randomBytes(32).toString("hex"));

/**
 * 每 repo 一个端点（D5）。**repoId 即 `GPT_Workspace` 下的目录名**（规格 §4.2）——
 * 不是任意标签。当前该目录下只有 `grande-gpt` 一个真实仓库，它同时也是 §9.3 定的
 * dogfooding 目标。
 *
 * 早前这里写的是 `demo-app` / `other-repo`——那是 POC 的**虚构**仓库名（内存里的
 * fixture），混进 production 配置属于命名污染：ChatGPT 侧配好的端点 URL 会长期留在
 * 插件配置里，用一个不存在的仓库名去建它，后面每次看到都要重新判断"这是真的还是测试"。
 *
 * S0 起应改为从 `GPT_Workspace` 自动发现 git 仓库、再经显式注册（规格 §4.2），
 * 而不是硬编码——本 spike 只验证认证层，先用真实值写死。
 */
const REPO_IDS = new Set<string>(["grande-gpt"]);
/** 根路径 `/.well-known/oauth-protected-resource` 没有 repoId 可用，见该路由下的注释。 */
const DEFAULT_REPO_ID = "grande-gpt";

const SCOPE_PREFIX = "grande:repo:";
const resourceUrl = (repoId: string): string => `${ISSUER}/mcp/${repoId}`;
const scopeFor = (repoId: string): string => `${SCOPE_PREFIX}${repoId}`;
const protectedResourceMetadataUrl = (repoId: string): string =>
  `${ISSUER}/.well-known/oauth-protected-resource/mcp/${repoId}`;

/** `resource`（RFC 8707）→ repoId：必须精确等于某个已注册端点的完整 URL。 */
function resourceToRepoId(resource: string): string | undefined {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(ISSUER).origin) return undefined;
  const match = /^\/mcp\/([^/]+)$/.exec(url.pathname);
  const repoId = match?.[1];
  return repoId !== undefined && REPO_IDS.has(repoId) ? repoId : undefined;
}

/** `scope`（空格分隔）→ repoId：必须含有 `grande:repo:<已注册 repoId>` 这个 token。 */
function scopeToRepoId(scope: string): string | undefined {
  const token = scope.split(/\s+/).find((s) => s.startsWith(SCOPE_PREFIX));
  if (!token) return undefined;
  const repoId = token.slice(SCOPE_PREFIX.length);
  return REPO_IDS.has(repoId) ? repoId : undefined;
}

/** 单用户 spike：授权码与已注册 client 都放内存。授权码额外绑定 repoId —— 这是隔离链条的起点。 */
const codes = new Map<string, { challenge: string; clientId: string; repoId: string }>();
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

// ① 受保护资源元数据（根路径，无 repoId）
// RFC 9728 要求 `resource` 是单个字符串，但根路径天然没有 repoId 可用来确定是
// 哪一个端点。真正权威、每次都对的入口是 401 的 WWW-Authenticate 里那条
// per-repo URL（见下方 /mcp/:repoId）；这里保留根路径只是为了观察 ChatGPT 会不会
// 先探这一条——不删掉它，但也不假装它能代表所有 repo，固定指向 DEFAULT_REPO_ID
// 并在日志里显式标注，避免误读成「这就是权威值」。
app.get("/.well-known/oauth-protected-resource", (c) => {
  console.log("[oauth] /.well-known/oauth-protected-resource (根路径，指向默认 repo) ←", DEFAULT_REPO_ID);
  return c.json({
    resource: resourceUrl(DEFAULT_REPO_ID),
    authorization_servers: [ISSUER],
    scopes_supported: [...REPO_IDS].map(scopeFor),
  });
});

// ①b 受保护资源元数据（per-repo）—— D5 要求的真正入口。
app.get("/.well-known/oauth-protected-resource/mcp/:repoId", (c) => {
  const repoId = c.req.param("repoId");
  console.log(`[oauth:${repoId}] /.well-known/oauth-protected-resource/mcp/${repoId} ←`);
  if (!REPO_IDS.has(repoId)) {
    console.error(`[oauth:${repoId}] 未注册的 repoId，protected-resource 元数据返回 404`);
    return c.json({ error: "not_found", error_description: `unknown repoId: ${repoId}` }, 404);
  }
  return c.json({
    resource: resourceUrl(repoId),
    authorization_servers: [ISSUER],
    scopes_supported: [scopeFor(repoId)],
  });
});

// ② 授权服务器元数据 —— 全局唯一一个 AS，repo 隔离靠 resource/scope + aud，不靠拆分这份文档。
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    jwks_uri: `${ISSUER}/jwks`,
    scopes_supported: [...REPO_IDS].map(scopeFor),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }),
);

// ③ 动态客户端注册（DCR）——规范说可选，但先实现，看 ChatGPT 走不走这条路径
// 还是走 CIMD（client_id 直接是元数据 URL，跳过 /register）。全局、不分 repo：
// 一个 client 注册一次，之后可以对任意 repo 发起 /authorize。
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

  // D5 的核心绑定点：这个授权码到底是为哪个 repo 签的，从这里开始就定死。
  // 优先信 `resource`（RFC 8707，MCP 授权规范要求客户端从 protected-resource
  // 元数据里学到 `resource` 值后原样带回来——这正是本轮最想观察的行为）；
  // `scope` 作为兜底信号（有的客户端只从 scopes_supported 里抄 scope，不发
  // resource）。两者都给出时必须指向同一个 repo，否则拒绝而不是各打五十大板。
  const repoIdFromResource = q.resource ? resourceToRepoId(q.resource) : undefined;
  const repoIdFromScope = q.scope ? scopeToRepoId(q.scope) : undefined;
  console.log("[oauth] /authorize repo 绑定解析", {
    resource: q.resource,
    scope: q.scope,
    repoIdFromResource,
    repoIdFromScope,
  });

  if (q.resource && !repoIdFromResource) {
    console.error("[oauth] /authorize 拒绝：resource 不是已注册的端点 URL", q.resource);
    redirectUrl.searchParams.set("error", "invalid_target");
    redirectUrl.searchParams.set("error_description", `resource is not a registered repo endpoint: ${q.resource}`);
    if (q.state) redirectUrl.searchParams.set("state", q.state);
    return c.redirect(redirectUrl.toString(), 302);
  }
  if (q.scope && !repoIdFromScope) {
    console.error("[oauth] /authorize 拒绝：scope 不含已注册 repo", q.scope);
    redirectUrl.searchParams.set("error", "invalid_scope");
    redirectUrl.searchParams.set("error_description", `scope does not name a registered repo: ${q.scope}`);
    if (q.state) redirectUrl.searchParams.set("state", q.state);
    return c.redirect(redirectUrl.toString(), 302);
  }
  if (repoIdFromResource && repoIdFromScope && repoIdFromResource !== repoIdFromScope) {
    console.error("[oauth] /authorize 拒绝：resource 与 scope 指向不同 repo", {
      repoIdFromResource,
      repoIdFromScope,
    });
    redirectUrl.searchParams.set("error", "invalid_request");
    redirectUrl.searchParams.set("error_description", "resource and scope name different repos");
    if (q.state) redirectUrl.searchParams.set("state", q.state);
    return c.redirect(redirectUrl.toString(), 302);
  }
  const repoId = repoIdFromResource ?? repoIdFromScope;
  if (!repoId) {
    // 两个信号都没给：没法知道该给哪个 repo 签、该把 aud 设成什么。宁可在这里
    // 大声拒绝，也不能悄悄落到某个默认 repo——那样会把「客户端到底有没有正确
    // 声明目标端点」这个问题自己答掉，D5 的隔离就退化成我们自己的一厢情愿。
    console.error("[oauth] /authorize 拒绝：既没有 resource 也没有 scope，无法绑定 repoId");
    redirectUrl.searchParams.set("error", "invalid_request");
    redirectUrl.searchParams.set(
      "error_description",
      "resource or scope is required to bind the authorization to a repo endpoint",
    );
    if (q.state) redirectUrl.searchParams.set("state", q.state);
    return c.redirect(redirectUrl.toString(), 302);
  }

  const code = randomUUID();
  codes.set(code, { challenge: q.code_challenge, clientId: q.client_id ?? "", repoId });
  redirectUrl.searchParams.set("code", code);
  if (q.state) redirectUrl.searchParams.set("state", q.state);
  console.log("[oauth] /authorize → 签发 code，绑定 repoId", { repoId });
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

  // repoId 的权威来源是 /authorize 时写进 code 记录里的值，不是这里客户端传来的
  // `resource`/`scope`——如果信了后者，就等于允许「code 是为 repo-a 申请的，
  // 兑换时却声称要 repo-b 的 token」，直接绕过用户在 /authorize 那一步的同意。
  // 但如果客户端确实带了这两个参数，仍然要核对一致性并大声记录不一致——这正是
  // 观察 ChatGPT「是否正确回传 aud」的关键位置之一。
  const expectedResource = resourceUrl(rec.repoId);
  const expectedScope = scopeFor(rec.repoId);
  const resourceParam = typeof form.resource === "string" ? form.resource : undefined;
  const scopeParam = typeof form.scope === "string" ? form.scope : undefined;
  if (resourceParam !== undefined && resourceParam !== expectedResource) {
    console.error("[oauth] /token resource 与 /authorize 绑定的 repoId 不一致", {
      resourceParam,
      expectedResource,
      repoId: rec.repoId,
    });
    return c.json({ error: "invalid_target", error_description: "resource does not match the authorized repo" }, 400);
  }
  if (scopeParam !== undefined && scopeParam !== expectedScope) {
    console.error("[oauth] /token scope 与 /authorize 绑定的 repoId 不一致", {
      scopeParam,
      expectedScope,
      repoId: rec.repoId,
    });
    return c.json({ error: "invalid_scope", error_description: "scope does not match the authorized repo" }, 400);
  }

  const token = await new SignJWT({ scope: expectedScope })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(expectedResource)
    .setSubject("spike-user")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(KEY);
  console.log("[oauth] /token → 签发 access_token", {
    repoId: rec.repoId,
    aud: expectedResource,
    scope: expectedScope,
    clientId: rec.clientId,
  });
  return c.json({ access_token: token, token_type: "Bearer", expires_in: 3600, scope: expectedScope });
});

app.get("/jwks", (c) => c.json({ keys: [] })); // HS256 对称密钥，无公钥可发布；仅为满足发现文档字段完整

// ⑥ 受保护的、按 repo 拆分的 MCP 端点 —— D5 的落地处。
app.all("/mcp/:repoId", async (c) => {
  const repoId = c.req.param("repoId");
  const metadataUrl = protectedResourceMetadataUrl(repoId);

  // 未注册的 repoId 直接 404，认证与否都一样——repoId 本身不是秘密（那是
  // No-Auth 时代「secret path segment」的思路，OAuth 已经把它替换掉了），
  // 秘密只在 token 里。
  if (!REPO_IDS.has(repoId)) {
    console.error(`[oauth:${repoId}] /mcp ← 未注册的 repoId，返回 404`);
    return c.json({ error: "not_found", error_description: `unknown repoId: ${repoId}` }, 404);
  }

  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) {
    console.log(`[oauth:${repoId}] /mcp ← 无 Bearer，返回 401`);
    return new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
    });
  }

  // 隔离链条收口的地方：aud 的比较对象是 *这个* repoId 自己的 resource URL，
  // 不是任何共享常量。demo-app 端点永远只用 resourceUrl("demo-app") 去验，
  // other-repo 端点永远只用 resourceUrl("other-repo") 去验——这就是为什么
  // 一个 repo 的 token 拿到另一个 repo 的端点上必然被拒。
  const expectedAudience = resourceUrl(repoId);
  const expectedScope = scopeFor(repoId);
  try {
    const { payload } = await jwtVerify(bearer, KEY, { issuer: ISSUER, audience: expectedAudience });
    if (!String(payload.scope ?? "").split(" ").includes(expectedScope)) {
      throw new Error(`scope 不含 ${expectedScope}（实际 ${String(payload.scope)}）`);
    }
    console.log(`[oauth:${repoId}] /mcp ← 已认证请求`, { sub: payload.sub, aud: payload.aud, scope: payload.scope });
  } catch (e) {
    // token 校验失败时，即使拒绝请求，也把（未验证的）payload 解出来记进日志——
    // 这不是信任它，只是为了在人类跑交互失败时，日志里能看到客户端实际发来的
    // aud/iss/exp 长什么样，而不是只有一句"校验失败"。错误原因（JWTExpired /
    // JWTClaimValidationFailed / JWSSignatureVerificationFailed）由 jose 的
    // 错误类名自然带出，足以互相区分，不需要额外分类逻辑。
    let claims: unknown = "<无法解析 token payload>";
    try {
      claims = decodeJwt(bearer);
    } catch {
      /* 连 payload 都解不出来，claims 保持占位符 */
    }
    console.error(`[oauth:${repoId}] token 校验失败`, { error: String(e), expectedAudience, claims });
    return new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
    });
  }

  const server = new McpServer({ name: `grande-oauth-spike-${repoId}`, version: "0.0.0" });
  server.registerTool(
    "spike_ping",
    {
      title: "Ping",
      description: "验证 OAuth 握手成功后工具可被调用。返回值里带上 repoId，用来肉眼确认是哪个 per-repo 端点响应的。",
      inputSchema: { note: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ note }) => ({
      content: [{ type: "text", text: `pong from ${repoId}${note ? ` (${note})` : ""}` }],
      structuredContent: { ok: true, pong: true, repoId, note: note ?? null },
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
console.log(`[oauth] listening on http://127.0.0.1:${PORT}  ISSUER=${ISSUER}  repos=${[...REPO_IDS].join(",")}`);
