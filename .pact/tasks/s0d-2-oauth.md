# s0d-2-oauth

> S0-D 的第 2 个任务，从 `docs/superpowers/plans/2026-07-27-s0-d-mcp-oauth-endpoint.md` 切出。
> **该计划已通过一轮对抗性代码审查**，找出并修掉了：公网可匿名签发令牌、
> aud 未绑定已注册 repo、授权码并发兑换出多个有效令牌、redirect_uri 从不比对、
> 错误映射表里有到不了的行。**请逐字使用其中给出的代码与测试，不要自行改写。**

---

# S0-D MCP 端点与 OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 S0-A/B/C 的 18 个模块接成一个 ChatGPT 能真正连上、认证、并完成
「读 → 改 → 跑测试 → 看失败 → 再改 → 通过」闭环的 MCP 端点。

**Architecture:** Hono HTTP 服务 → 每 repo 一个 `/mcp/<repoId>` 端点 → OAuth 2.1
资源服务器 → MCP 工具层。工具处理器是**唯一**把内部异常翻译成 `error{code}` 信封的地方，
也是**唯一**创建审计句柄的地方。

**Tech Stack:** TypeScript、Hono、`@modelcontextprotocol/sdk@1.30.0`、`jose`（JWT）、vitest。

## Global Constraints

取自规格 `docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`。**每个任务隐含包含本节。**

- **`WebStandardStreamableHTTPServerTransport`**（`server/webStandardStreamableHttp.js`），
  **不是** Node 风格的 `StreamableHTTPServerTransport` —— 后者与 Hono 不兼容。POC 阶段
  踩过这个坑。
- **每 repo 一个端点 `/mcp/<repoId>`**（D5），`repoId` **不作为工具参数**。令牌的 `aud`
  精确绑定端点 URL —— U1 已在 ChatGPT 侧端到端坐实。
- **必须实现 `refresh_token`**（§4.4，U1 实测）：ChatGPT 注册时请求
  `grant_types: ["authorization_code","refresh_token"]`。不实现的话令牌 1 小时过期后
  连接直接断开，用户必须重新授权。
- **`WWW-Authenticate: Bearer resource_metadata="..."` 是承重的**（U1 实测）：ChatGPT
  先撞 401，再顺这个响应头去找**每-repo 那份**元数据。缺失或写错，握手根本起不来。
- **~60s 工具调用超时不可配置** → 只有 `grande_run` 异步；其余工具必须秒回。
- **响应会被静默截断** → 信封字段顺序 `ok`/`taskId`/`truncated`/`nextCursor`/`hint`/`data`/`taskContext`，
  三个截断字段必须排在 `data` 之前（POC 实测曾落在第 73,896 字节）。
- **工具注解必须如实**：六个只读工具 `readOnlyHint: true`。ChatGPT 的
  `Allow read actions` 权限档靠它精确放行轮询而拦住写入 —— 全标成写工具该档位即失效。
  所有工具 `openWorldHint: false`（S0 全禁网）。
- 严格 TS：`strict: true`、`noUncheckedIndexedAccess: true`。Node 24 原生剥离类型。
- **认证边界与令牌安全是两层不同的问题，分别处置**：谁能到达 `/authorize` 是访问控制
  问题（见 Task 2 顶部的阻断说明）；`/authorize`/`/token` 一旦被到达后，签发的令牌
  是否精确绑定 repo、是否防重放、是否防跨端点提权，是本文档其余部分要修的令牌安全
  问题。两者独立成立，任何一层单独失守都足以让攻击者拿到能驱动 `grande_repo_edit`/
  `grande_run` 的令牌。

## 三条 S0-D 硬要求（规格 §7.0，S0-B/C 收尾审查催生）

1. **审计结构性**：`repoEdit` 与 `startJob` 的签名必须带 `AuditHandle`。没有句柄
   就调不动 —— 想变更就必然先留下 `INTENT`。**不是**在处理器外面包一层。
2. **`NETWORK_DENIED` 需要信号**：目前沙箱里的联网尝试只表现为非零退出码，
   与普通测试失败无法区分，AC-5 的验收断言不可满足。
3. **`reconcileRunningJobs` 必须接到启动流程**，且在开始接受工具调用**之前**跑完 ——
   否则新 job 会与对账竞争。它至今零生产调用方，AC-11 在系统层面不成立。

## 三条铁律

1. **仓库内容不可信。** 工具结果里的命令建议绝不自动执行。
2. **没有通用逃生舱。** 不提供 `shell_exec` / `filesystem_raw` / `git_raw`。
3. **能做成硬约束的绝不做成软约束。**

## 已有资产

- `spike/oauth/server.ts`（437 行）—— OAuth AS + 每-repo 受保护端点，**ChatGPT 真实
  握手跑通过**。**按原型重写进 `src/`，不要 import**（`spike/` 是一次性代码）。
  它缺 `refresh_token`，那正是本切片要补的。它也缺 §4.6 意义上的用户认证（见 Task 2
  顶部的阻断说明）—— spike 自己的注释写得很清楚：「spike 直接同意，不做登录页」，
  这是刻意的观察期捷径，S0-D 原样继承会把捷径变成生产行为。
- Cloudflare 隧道 `grande-gpt` → `grande.agentjoey.ai` → `127.0.0.1:8787`，production 命名。
- `src/` 18 个模块，339 测试。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/errors.ts` | 内部异常 → 工具错误码映射（规格 §7.1 那张表），外加 `StateError`（C-5）与 `redact()`（I-1c） |
| `src/tools.ts` | 九个工具的 schema、注解与处理器 |
| `src/oauth.ts` | OAuth AS：DCR、authorize、token、refresh、发现文档 |
| `src/server.ts` | Hono 应用、每-repo 路由、MCP transport、启动流程 |

**任务顺序按「越早能用越好」排**：Task 1–3 做完就有一个**只读但真能连**的端点，
可以挂上 ChatGPT 试。写与跑在 Task 4–5。

---

---

### Task 2: OAuth 授权服务器（含 refresh_token）

---

> ## ⚠️ `/authorize` 的认证方案已定稿并配置完成 —— 但 iOS 那条路径仍未实测
>
> **背景（这个洞是怎么来的）**：spike 的 `/authorize` 注释写着「spike 直接同意，
> 不做登录页」，本计划最初原样继承了那个刻意的捷径。后果是**任何能访问该端点的人
> 自带一个 PKCE verifier 就能换到合法令牌**，而该令牌可以驱动 `grande_repo_edit`
> 与 `grande_run` 在本机写文件、执行命令。**PKCE 挡不住这条 —— 攻击者自己就是
> 发起流程的那一方，verifier 是他自己挑的。**
>
> **方案（规格 §7.0⓪，已配置并实测）**：Cloudflare Access 应用，类型 Public DNS，
> 范围**仅** `grande.agentjoey.ai/authorize*`。已实测确认 `/token`、`/register`、
> `/.well-known/*`、`/mcp/*` 四条仍原样放行（它们是 OpenAI 后端的服务器对服务器
> 调用，做不了交互式登录）。
>
> **仍然阻断的部分**：ChatGPT 把用户送到 `/authorize` 时，那个浏览器上下文能否
> 完成 Access 登录、带住 cookie、再跳回来完成 OAuth？桌面浏览器已通过
> `cloudflared access login` 间接验证；**iOS 的应用内 webview 未验证** —— 它可能
> 不共享 Safari 的 cookie，或拦住 Access 到 IdP 的跳转。而 P-6 已证明用户会在
> iOS 上用这个系统。
>
> **在 iOS 实测完成之前**，Task 2 可以实现，但 **`authorization_endpoint` 的最终
> 形态不得视为已定** —— 若 iOS 不通，改的正是这个字段，它是本任务的地基。
> 实测方式：在 ChatGPT 里重新授权一次连接器，桌面与 iOS 各一次。这一步不能自动化
> 验证 —— U1 的 refresh_token 缺口正是 curl 全绿、静态检查也发现不了的那类问题。


**Interfaces:**
- Produces: `interface OAuthConfig { issuer: string; endpointFor(repoId: string): string; isRegistered(repoId: string): boolean; keyPath: string }`
  （`isRegistered` 是 CRITICAL-2 新增；`keyPath` 是 I-9 新增，见 Step 3）、
  `function createOAuth(cfg: OAuthConfig): OAuthRoutes`，其中 `OAuthRoutes` 暴露
  `register` / `authorize` / `token` / `protectedResourceMetadata` / `authServerMetadata` / `verifyBearer`

**按 `spike/oauth/server.ts` 重写，不要 import。** 那份原型已与 ChatGPT 真实握手跑通，
但**缺 `refresh_token`** —— 这是本任务要补的核心。它同时缺 CRITICAL-2/3/4 与
I-9/I-11 修的五个洞——这些洞不是从 spike 继承来的退化（spike 的 `resourceToRepoId`
其实比这版计划的初稿更严格，见 Step 3），是重写过程中新引入的回归，Step 3 会逐条
对照说明。

**U1 实测的四条，实现时必须保住：**

1. **发现顺序**：ChatGPT 先 `POST /mcp/<repoId>` 撞 401，再顺
   `WWW-Authenticate: Bearer resource_metadata="..."` 去取**每-repo 那份**
   `/.well-known/oauth-protected-resource/mcp/<repoId>`。这个响应头缺失或写错，
   握手根本起不来。
2. **PKCE S256 由 ChatGPT 主动发**。服务端**无条件**校验 —— 原型里那句
   「客户端不传 challenge 就跳过校验」的绕过必须保持已修状态。
3. **`aud` 精确等于端点 URL**。用 `grande-gpt` 的令牌打别的端点必须被拒。
4. **DCR**（CIMD 不可用，因为我们不声明支持）。`/register` 必须按 RFC 7591
   **回传实际支持的 `grant_types`**，而不是照单全收 —— 原型正是因为照单全收，
   让 ChatGPT 以为可以续期。

- [ ] **Step 0: Access 门禁（先于一切 OAuth 逻辑）**

`/authorize` 的第一道检查，**在 PKCE、在 client 查找、在产生任何 code 之前**。

`src/accessGate.ts`：

```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessConfig {
  /** 团队域名，例如 https://agentjoey.cloudflareaccess.com */
  teamDomain: string;
  /** 本 Access 应用的 AUD tag（64 位十六进制） */
  aud: string;
}

export class AccessDeniedError extends Error {
  readonly code = "ACCESS_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError [ACCESS_DENIED]";
  }
}

/**
 * 校验 Cloudflare Access 注入的身份断言。
 *
 * **为什么这道检查必须在代码里，而不能只靠 Cloudflare 的配置**：Access 应用是
 * 仪表盘里的一条配置，可以被误删、被改错范围，也可以被整个绕过（有人直接把 8787
 * 暴露出去而不走隧道）。那些情况下 `Cf-Access-Jwt-Assertion` 头就不存在了 ——
 * 本函数因此拒绝，`/authorize` 随之不可用。门禁于是成了硬约束（铁律三），
 * 而不是一条部署约定。
 *
 * 三个参数一个都不能省：
 * - `issuer`：团队域名；
 * - `audience`：**本应用的** AUD。团队域名是共享的 —— 不钉 AUD 的话，同一团队下
 *   任何一个 Access 应用签发的 JWT 都能通过，那是一条跨应用提权路径；
 * - `algorithms`：钉死 `["RS256"]`（实测 Cloudflare 的 JWKS 就是 RS256）。
 *   不钉的话算法混淆是活的。
 *
 * `createRemoteJWKSet` 自带缓存，遇到未知 kid 会重新拉取 —— Cloudflare 会轮换
 * 签名密钥（实测同时存在两把），不能把公钥固化下来。
 */
export function createAccessGate(cfg: AccessConfig) {
  const jwks = createRemoteJWKSet(new URL(`${cfg.teamDomain}/cdn-cgi/access/certs`));
  return async function assertApproved(headers: Headers): Promise<{ email: string; sub: string }> {
    const assertion = headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion) {
      throw new AccessDeniedError(
        "缺少 Cf-Access-Jwt-Assertion。/authorize 必须经由 Cloudflare Access 到达；" +
          "直连或 Access 未配置时一律拒绝。",
      );
    }
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer: cfg.teamDomain,
      audience: cfg.aud,
      algorithms: ["RS256"],
    });
    return { email: String(payload.email ?? ""), sub: String(payload.sub ?? "") };
  };
}
```

**配置来源**：`~/.grande-control/config/access.yaml`（铁律一：策略只从控制平面读）。
**缺失即拒绝启动** —— 配置没有不等于门禁不适用，那是「门禁没装上」。

实测值：`teamDomain: https://agentjoey.cloudflareaccess.com`、
`aud: 749f9a93b958d99d6415a50a21099e0df16f0d0bb669c93bf473ec5aea022df4`。
AUD 不是密钥（它是每枚令牌里的 audience claim），可以进仓库；签名密钥是 Cloudflare
的公开 JWKS，我们不持有任何私钥。

测试 `tests/accessGate.test.ts`：

```typescript
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccessGate } from "../src/accessGate.ts";

const TEAM = "https://team.example.test";
const AUD = "a".repeat(64);
let priv: CryptoKey, jwksBody: string, restore: () => void;

beforeEach(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(kp.publicKey)), alg: "RS256", kid: "k1" }] });
  // 拦住 JWKS 拉取，避免测试打真实网络（S0 全禁网，且测试必须可离线跑）
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) =>
    String(u).includes("/cdn-cgi/access/certs")
      ? new Response(jwksBody, { headers: { "content-type": "application/json" } })
      : realFetch(u as never)) as typeof fetch;
  restore = () => { globalThis.fetch = realFetch; };
});
afterEach(() => restore());

const sign = (over: Record<string, unknown> = {}) =>
  new SignJWT({ email: "u@example.test", ...over })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(String(over.iss ?? TEAM))
    .setAudience(String(over.aud ?? AUD))
    .setSubject("sub-1")
    .setExpirationTime("5m")
    .sign(priv);

describe("createAccessGate()", () => {
  it("合法断言通过并返回身份", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const id = await gate(new Headers({ "Cf-Access-Jwt-Assertion": await sign() }));
    expect(id.email).toBe("u@example.test");
  });

  it("【没有头】就拒绝——这是 Access 被绕过或被删掉时的形态", async () => {
    // 直连 8787、或 Access 应用被误删，头就不存在。门禁必须在代码里失效关闭，
    // 而不是因为「Cloudflare 那边配过了」就放行。
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    await expect(gate(new Headers())).rejects.toThrow(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
  });

  it("同团队【别的应用】签发的 JWT 被拒（不钉 audience 就是跨应用提权）", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const other = await sign({ aud: "b".repeat(64) });
    await expect(gate(new Headers({ "Cf-Access-Jwt-Assertion": other }))).rejects.toThrow();
  });

  it("别的团队签发的 JWT 被拒", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const other = await sign({ iss: "https://evil.cloudflareaccess.com" });
    await expect(gate(new Headers({ "Cf-Access-Jwt-Assertion": other }))).rejects.toThrow();
  });

  it("过期的断言被拒", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const expired = await new SignJWT({ email: "u@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM).setAudience(AUD).setSubject("s")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(priv);
    await expect(gate(new Headers({ "Cf-Access-Jwt-Assertion": expired }))).rejects.toThrow();
  });

  it("篡改过的断言被拒", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const t = await sign();
    const [h, p, s] = t.split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ email: "evil@x.test", iss: TEAM, aud: AUD, exp: 9e9 })).toString("base64url")}.${s}`;
    await expect(gate(new Headers({ "Cf-Access-Jwt-Assertion": tampered }))).rejects.toThrow();
  });
});
```

**承重性验证**：把 `audience: cfg.aud` 从 `jwtVerify` 的参数里删掉，确认「同团队别的
应用」那条变红；还原后确认变绿。**把观察写进报告** —— 这一条是跨应用提权的唯一防线。

- [ ] **Step 1: 写失败测试**

`tests/oauth.test.ts`：

```typescript
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOAuth } from "../src/oauth.ts";

const ISSUER = "https://grande.example.test";

/**
 * 默认只有 "demo" 已注册——CRITICAL-2 的 resource 校验需要一个真实可查的注册表。
 * `keyPath` 每次调用给一个全新的临时目录（I-9）：密钥路径若写死成宿主机的真实
 * `~/.grande-control/secrets/`，会让所有测试运行共享同一份真实密钥文件、互相
 * 污染宿主机状态，也没法构造"两把不同密钥"这种密钥轮换场景（见 verifyBearer 里
 * 「用另一把密钥签发的令牌被拒」）。
 */
const oauth = (registered: ReadonlySet<string> = new Set(["demo"])) =>
  createOAuth({
    issuer: ISSUER,
    endpointFor: (r) => `${ISSUER}/mcp/${r}`,
    isRegistered: (r) => registered.has(r),
    keyPath: join(mkdtempSync(join(tmpdir(), "oauth-key-")), "oauth-key"),
  });

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

/** 走完一遍授权码流，返回 token 响应 */
async function fullFlow(o: ReturnType<typeof createOAuth>, repoId = "demo") {
  const reg = await o.register({
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/opaque"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const verifier = randomBytes(48).toString("base64url");
  const code = await o.authorize({
    client_id: reg.client_id,
    redirect_uri: reg.redirect_uris[0]!,
    code_challenge: s256(verifier),
    code_challenge_method: "S256",
    resource: `${ISSUER}/mcp/${repoId}`,
    scope: `grande:repo:${repoId}`,
  });
  const tok = await o.token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: reg.client_id,
    redirect_uri: reg.redirect_uris[0]!,
    resource: `${ISSUER}/mcp/${repoId}`,
  });
  return { reg, verifier, tok };
}

describe("发现文档", () => {
  it("每-repo 的受保护资源元数据指向该 repo 自己的端点", () => {
    const m = oauth().protectedResourceMetadata("demo");
    expect(m.resource).toBe(`${ISSUER}/mcp/demo`);
    expect(m.authorization_servers).toContain(ISSUER);
  });

  it("AS 元数据【如实】声明 grant_types_supported 含 refresh_token，且发现端点三件套齐全", () => {
    // U1 实测的教训：原型声明 ["authorization_code"] 却接受了 ChatGPT 的
    // refresh_token 注册请求，于是它以为能续期，1 小时后连接直接断。
    // authorization_endpoint/token_endpoint/jwks_uri 三个字段规格 §4.4 明确要求
    // （I-9）：原计划这条测试只查了 grant_types_supported 与
    // code_challenge_methods_supported，没覆盖发现端点本身完不完整。
    const m = oauth().authServerMetadata();
    expect(m.grant_types_supported).toContain("authorization_code");
    expect(m.grant_types_supported).toContain("refresh_token");
    expect(m.code_challenge_methods_supported).toContain("S256");
    expect(m.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(m.token_endpoint).toBe(`${ISSUER}/token`);
    expect(m.jwks_uri).toBe(`${ISSUER}/jwks`);
  });
});

describe("动态注册（DCR）", () => {
  it("回传的 grant_types 是【实际支持的】，不是照单全收", async () => {
    const reg = await oauth().register({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/x"],
      grant_types: ["authorization_code", "refresh_token", "password", "implicit"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(reg.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(reg.grant_types).not.toContain("password");
    expect(reg.grant_types).not.toContain("implicit");
  });

  it("非 https 的 redirect_uri 被拒", async () => {
    await expect(oauth().register({
      client_name: "x", redirect_uris: ["http://evil.test/cb"],
      grant_types: ["authorization_code"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    })).rejects.toThrow(/redirect_uri/);
  });
});

describe("授权码流 + PKCE", () => {
  it("正确的 verifier 换得到 access_token 与 refresh_token", async () => {
    const { tok } = await fullFlow(oauth());
    expect(tok.token_type).toBe("Bearer");
    expect(typeof tok.access_token).toBe("string");
    expect(typeof tok.refresh_token).toBe("string");
    expect(tok.expires_in).toBeGreaterThan(0);
  });

  it("错误的 verifier 被拒（PKCE 校验无条件生效）", async () => {
    const o = oauth();
    const { reg } = await fullFlow(o);
    const verifier = randomBytes(48).toString("base64url");
    const code = await o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
    });
    await expect(o.token({
      grant_type: "authorization_code", code,
      code_verifier: "完全错误的 verifier", client_id: reg.client_id,
      redirect_uri: reg.redirect_uris[0]!, resource: `${ISSUER}/mcp/demo`,
    })).rejects.toThrow(/PKCE|code_verifier/);
  });

  it("【不带】code_challenge 的授权请求被拒，而不是跳过 PKCE 校验", async () => {
    // 原型里有过「客户端不传 challenge 就跳过校验」的绕过。无条件才叫强制。
    // client_id 用真实注册过的值——原计划这里用的是未注册的 "c"，那样写会让
    // 这条测试只在"PKCE 检查排在 client 查找之前"这个特定实现顺序下才成立，
    // 而 CRITICAL-4 新增的 redirect_uri 校验到底该排在 PKCE 前面还是后面，
    // 本就是实现者的自由。注册一个真实 client 后，这条测试只依赖 PKCE 本身，
    // 不再意外耦合到另一条校验的先后顺序。
    const o = oauth();
    const reg = await o.register({
      client_name: "x", redirect_uris: ["https://chatgpt.com/connector/oauth/x"],
      grant_types: ["authorization_code"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    await expect(o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
    } as never)).rejects.toThrow(/code_challenge/);
  });

  it("授权码是一次性的：同一个 code 换第二次被拒", async () => {
    const o = oauth();
    const { reg, verifier } = await fullFlow(o);
    const code = await o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
    });
    const args = {
      grant_type: "authorization_code" as const, code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp/demo`,
    };
    await o.token(args);
    await expect(o.token(args)).rejects.toThrow();
  });

  // CRITICAL-3：上面这条顺序测试只证明"用过的 code 不能再用一次"，抓不住
  // "两个并发请求同时用同一个 code"这条路径——token() 是 async 且 jose 签名要
  // await，"先校验 PKCE、签完 JWT 再删 code"读起来完全正确，实测三个并发请求
  // 会拿到三个都能通过 verifyBearer 的令牌。
  it("同一个 code 被并发兑换时只有一个成功（顺序测试抓不到这条）", async () => {
    const o = oauth();
    const { reg, verifier } = await fullFlow(o);
    const code = await o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
    } as never);
    const args = {
      grant_type: "authorization_code" as const, code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp/demo`,
    };
    const rs = await Promise.allSettled([o.token(args), o.token(args), o.token(args)]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  // CRITICAL-4：DCR 只查过 https 协议，从没人把 redirect_uri 与
  // clients.get(client_id).redirect_uris 比对过。
  it("redirect_uri 必须与注册值【精确】相等，前缀相同也不行", async () => {
    const o = oauth();
    const reg = await o.register({
      client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/abc"],
      grant_types: ["authorization_code"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const verifier = randomBytes(48).toString("base64url");
    for (const evil of [
      "https://chatgpt.com/connector/oauth/abc.evil.test/cb",
      "https://chatgpt.com/connector/oauth/abc/../../evil",
      "https://evil.test/cb",
    ]) {
      await expect(o.authorize({
        client_id: reg.client_id, redirect_uri: evil,
        code_challenge: s256(verifier), code_challenge_method: "S256",
        resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
      } as never)).rejects.toThrow(/redirect_uri/);
    }
  });

  // CRITICAL-2：aud 绑定的是 resourceUrl(repoId) 这个字符串，但从没人验过
  // resource 参数本身是不是一个"合法拼出来的、指向已注册 repo 的、同一 origin
  // 的"端点 URL。
  it.each([
    ["跨 origin 的 resource", "https://evil.test/mcp/demo"],
    ["未注册的 repoId",        `${ISSUER}/mcp/nonexistent`],
    ["用 .. 绕行",             `${ISSUER}/mcp/demo/../other`],
    ["百分号编码的 ..",        `${ISSUER}/mcp/%2e%2e%2fother`],
    ["编码过的分隔符",         `${ISSUER}/mcp/demo%2Fother`],
  ])("%s 无法换到令牌", async (_label, resource) => {
    const o = oauth();                       // isRegistered: (r) => r === "demo"
    const verifier = randomBytes(48).toString("base64url");
    await expect(o.authorize({
      client_id: "c", redirect_uri: "https://chatgpt.com/connector/oauth/x",
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource, scope: "grande:repo:demo",
    } as never)).rejects.toThrow(/resource|invalid_target/);
  });
});

describe("refresh_token（U1 实测缺口，本切片核心）", () => {
  it("refresh 换得到新的 access_token", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp/demo`,
    });
    expect(typeof next.access_token).toBe("string");
    expect(next.access_token).not.toBe(tok.access_token);
  });

  it("refresh 得到的令牌 aud 仍精确绑定同一端点", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp/demo`,
    });
    await expect(o.verifyBearer(next.access_token, `${ISSUER}/mcp/demo`)).resolves.toBeTruthy();
    await expect(o.verifyBearer(next.access_token, `${ISSUER}/mcp/other`)).rejects.toThrow();
  });

  it("refresh 不能跨端点提权：拿 demo 的 refresh 去要 other 的令牌被拒", async () => {
    const o = oauth(new Set(["demo", "other"]));
    const { tok } = await fullFlow(o, "demo");
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp/other`,
    })).rejects.toThrow();
  });

  it("伪造的 refresh_token 被拒", async () => {
    await expect(oauth().token({
      grant_type: "refresh_token", refresh_token: "伪造的",
      resource: `${ISSUER}/mcp/demo`,
    })).rejects.toThrow();
  });

  // I-11：refresh_token 是签给一个可执行代码系统、面向公共客户端（token_endpoint_auth_method
  // "none"）的长期承重令牌——OAuth 2.1 要求轮换 + 复用检测。没有它，一份泄漏的
  // refresh_token 永久有效，且用户和攻击者会同时持有"看起来都合法"的令牌。
  it("refresh 一次性并轮换；旧的再用一次会连带吊销整条链", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token, resource: `${ISSUER}/mcp/demo`,
    });
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(tok.refresh_token);
    // 复用旧的 refresh token 是「它被偷了」的最强信号：拒绝这一次不够，
    // 必须把轮换出来的那一支也吊销，否则攻击者和用户会并行持有两条有效链。
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token, resource: `${ISSUER}/mcp/demo`,
    })).rejects.toThrow();
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: next.refresh_token, resource: `${ISSUER}/mcp/demo`,
    })).rejects.toThrow();
  });
});

describe("verifyBearer —— D5 每-repo 隔离", () => {
  // 这一条与下面「篡改过的令牌被拒」是刻意成对的：这条证明"对的令牌通过"，
  // 那条证明"错的令牌不通过"——只写其中一条，实现方可以用一个恒真/恒假的
  // verifyBearer 蒙混过关（`async () => true` 能让这条单独绿；一个总是 throw
  // 的实现能让「空串与非 JWT 被拒」单独绿）。两条必须同时看，缺一都不能证明
  // verifyBearer 真的在做校验。
  it("aud 匹配的令牌通过", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    await expect(o.verifyBearer(tok.access_token, `${ISSUER}/mcp/demo`)).resolves.toBeTruthy();
  });

  it("用 demo 的令牌打 other 端点被拒（D5 由协议层强制）", async () => {
    const o = oauth(new Set(["demo", "other"]));
    const { tok } = await fullFlow(o, "demo");
    await expect(o.verifyBearer(tok.access_token, `${ISSUER}/mcp/other`)).rejects.toThrow();
  });

  it("篡改过的令牌被拒", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    // 原先的 slice(0, -3) + "xyz" 大约每 64^3 ≈ 26 万次才有一次真的没改变内容
    // （base64url 字母表 64 个字符，三个字符恰好都"巧合"变回原样的概率是
    // 1/64^3）——听起来是小概率，但方向反了：它是"几乎必然通过、但通过的理由
    // 是错的"那种 flaky，不是"几乎必然失败"。直接翻转 payload 段某一字节的
    // 某一位，保证签名必定对不上，不依赖任何概率。
    const parts = tok.access_token.split(".");
    const payload = Buffer.from(parts[1]!, "base64url");
    payload[0] = payload[0]! ^ 0xff;
    const bad = [parts[0], payload.toString("base64url"), parts[2]].join(".");
    await expect(o.verifyBearer(bad, `${ISSUER}/mcp/demo`)).rejects.toThrow();
  });

  it("空串与非 JWT 被拒，而不是抛出未分类的异常", async () => {
    const o = oauth();
    for (const t of ["", "not-a-jwt", "a.b.c"]) {
      await expect(o.verifyBearer(t, `${ISSUER}/mcp/demo`)).rejects.toThrow();
    }
  });

  // I-9：密钥轮换（磁盘密钥文件被替换/重建）之后，用旧密钥签的、其余部分完全
  // 合法的令牌必须走「校验失败」这条已知路径产生 401——而不是让 jose 的
  // JWSSignatureVerificationFailed 以未捕获异常的形态一路捅到 Hono 变成 500。
  // 两个 oauth() 各自持有自己临时目录里生成的密钥，天然是"不同的两把钥匙"。
  it("用【另一把】密钥签发的令牌被拒（模拟密钥轮换）", async () => {
    const o1 = oauth();
    const o2 = oauth();
    const { tok } = await fullFlow(o1, "demo");
    await expect(o2.verifyBearer(tok.access_token, `${ISSUER}/mcp/demo`)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/oauth.test.ts`
Expected: FAIL —— `Cannot find module '../src/oauth.ts'`

- [ ] **Step 3: 实现**

先读 `spike/oauth/server.ts`，理解它已经跑通的那部分。然后在 `src/oauth.ts` 里重写，
**补上 refresh_token**，并同时补齐 CRITICAL-2/3/4 与 I-9/I-11 修的五个洞（这些不是
spike 本来就有的退化——spike 的 `resourceToRepoId` 已经在做 origin 校验 + 已注册
校验，比这份计划初稿的"aud 只是字符串格式化"更严格；重写时把这层校验漏掉了）。要点：

- 用 `jose` 签 JWT，**只接受 HS256**（`jwtVerify(t, KEY, { issuer, audience,
  algorithms: ["HS256"] })`）——I-9 实测：省略 `algorithms` 时，`jwtVerify` 会接受
  一个用 HS512 签的令牌（对称密钥两种 HMAC 算法都能验证同一把密钥签的签名，
  `alg` 头完全由令牌自己声明、被信任），不锁 `algorithms` 等于把"该用哪个算法"
  的决定权交给了令牌本身。
- 密钥路径通过 `OAuthConfig.keyPath` 注入（新增字段，绝对路径），**不写死
  `~/.grande-control/secrets/`**——那样会让所有测试运行共享同一份宿主机真实
  密钥文件、互相污染，也没法构造"两把不同密钥"这种 I-9 的轮换场景。生产由
  Task 3 传 `join(layout.controlRoot, "secrets", "oauth-key")`；测试各自传一个
  `mkdtempSync` 出的临时路径（见 Step 1 的 `oauth()` 辅助函数）。
- **首次启动生成密钥时用 `writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 })`**
  （`wx` = 独占创建，文件已存在则失败）**，捕获 `EEXIST` 后改为重新读取磁盘上的
  密钥**，不是覆盖它——否则两个几乎同时的首次启动（例如两次并发的 `pnpm test`，
  或生产环境里 Gateway 意外被启动两次）会有一个"写"的赢家、一个"用内存里那把
  从未真正落盘的密钥去签"的输家，输家签出的令牌任何人都验证不了。
- **密钥文件存在但已损坏（截断/非法字节）时必须启动失败并响亮报错，不得静默
  重新生成**——静默重新生成会让所有此刻持有旧令牌的客户端全部失效，且表现得
  像一次网络抖动而不是一次密钥事故，排障成本极高。
- `authorize()` 必须要求 `code_challenge` 与 `code_challenge_method === "S256"`，
  缺任一即拒；随后（**CRITICAL-4**）按 `client_id` 查已注册 client：

  ```typescript
  // authorize()，在 PKCE 检查之后、产生 code 之前
  const client = clients.get(q.client_id);
  if (client === undefined) throw new OAuthError("invalid_client", "client_id 未注册");
  // **精确相等**，逐字符。不做前缀/子串匹配：`https://chatgpt.com/connector/oauth/x`
  // 的前缀匹配会同时放行 `https://chatgpt.com/connector/oauth/x.evil.test/`，
  // 那是一个完整的账号接管原语。
  if (!client.redirectUris.includes(q.redirect_uri)) {
    throw new OAuthError("invalid_request", "redirect_uri 与注册值不符");
  }
  ```

  再（**CRITICAL-2**）用 `resourceToRepoId()` 校验 `resource`，三条同时成立才能
  拿到 code：

  ```typescript
  /**
   * `resource`（RFC 8707）→ repoId。三条同时成立才算数，缺一不可：
   *  ① origin 必须等于 issuer 的 origin（否则 `https://evil.test/mcp/demo`
   *     会被解析成 repoId="demo"，我们照样给它签一个对真端点有效的 aud）；
   *  ② repoId 必须已注册（否则可以为一个还不存在的 repo 预签令牌，等它注册后生效）；
   *  ③ **往返相等**：`resource === endpointFor(repoId)`。这一条挡的是编码歧义——
   *     `%2e%2e%2f`、`demo/../other`、`demo%2Fother` 会解析出三个不同的 repoId，
   *     而 Hono 的 `:repoId` 又做一次自己的解码。只认那个能原样重建回来的值，
   *     整条链上就只剩一种拼写。
   */
  function resourceToRepoId(cfg: OAuthConfig, resource: string): string | null {
    let url: URL;
    try { url = new URL(resource); } catch { return null; }
    if (url.origin !== new URL(cfg.issuer).origin) return null;
    const repoId = /^\/mcp\/([^/]+)$/.exec(url.pathname)?.[1];
    if (repoId === undefined || !cfg.isRegistered(repoId)) return null;
    return resource === cfg.endpointFor(repoId) ? repoId : null;
  }
  ```

- 授权码一次性，且**claim（删除）必须在第一个 `await` 之前**（**CRITICAL-3**）：
  `const rec = codes.get(code); if (!rec) throw …; codes.delete(code);` 紧挨着写，
  中间不得有 `await`。`token()` 是 async 且 `jose` 的签名要 `await`——「先校验
  PKCE、签完 JWT 再删」读起来完全正确，实测三个并发请求会拿到三个都能通过
  `verifyBearer` 的令牌。claim/delete 必须是同步的那一对，PKCE 校验放在 delete
  之后（校验失败照样吊销这个 code，不给它第二次机会）。
- 授权码需要**过期时间**（RFC 6749 建议上限 10 分钟）；`token()` 用授权码兑换时
  必须比对 `rec.clientId === form.client_id && rec.redirectUri === form.redirect_uri`
  ——这两条此前完全没有落地，`rec` 只存了 `challenge`/`clientId`/`repoId`。
- `refresh_token` 独立签发、独立存储，记录它绑定的 `resource`——`token()` 在
  refresh 时必须校验请求的 `resource` 与之相等，否则就是跨端点提权。
  **（I-11）每次成功的 refresh 都必须签发一枚新 refresh_token 并让旧的失效
  （轮换）；旧 refresh_token 被再次使用时视为泄漏信号，把它所在的整条签发链
  （轮换出的、当前仍有效的那一支）一并吊销**——只拒绝这一次重放不够：真正的
  用户和偷到旧 token 的攻击者会分别持有一条"看起来都有效"的链，直到其中一个
  先用。
- `register()` 按 RFC 7591 把请求的 `grant_types` 与实际支持的求交集后回传。
- 访问令牌寿命：**单用户场景可放宽到 8 小时**，但**不得靠「长期不过期」回避 refresh** ——
  U1 已证明 ChatGPT 会用 refresh，不实现它就是 1 小时后断线。

**依赖**：本任务引入 `jose`（纯 JS、无原生代码）。这是 S0 的**第二个**依赖
（`yaml` 是第一个；原稿这里写"第三个"是算错了——`hono`/`@hono/node-server`/
`@modelcontextprotocol/sdk`/`zod` 要到 Task 3 才引入，见 Task 3 的 I-7 修复）：

```bash
pnpm add jose
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/oauth.test.ts`
Expected: PASS（2 + 2 + 11 + 5 + 5 = 25 个用例。「授权码流 + PKCE」的 11 =
原有 4 个独立用例 + CRITICAL-3 的并发测试 + CRITICAL-4 的 redirect_uri 测试 +
CRITICAL-2 的 5 行 `it.each`；「refresh_token」的 5 = 原有 4 个 + I-11 的轮换/
复用测试；「verifyBearer」的 5 = 原有 4 个 + I-9 的密钥轮换测试）

- [ ] **Step 5: 承重性验证**

逐条做，每条都是「削弱对应检查 → 确认测试变红 → 还原 → 确认变绿」，**全部写进报告**：

1. 把 `authorize()` 里的 `code_challenge` 必填检查去掉，确认「不带 code_challenge
   被拒」变红。
2. 把 refresh 时的 `resource` 相等校验去掉，确认「refresh 不能跨端点提权」变红。
3. **（CRITICAL-3，核心不变量）** 把 `codes.delete(code)` 从「claim 之后紧挨着」
   挪到 PKCE 校验**之后**（即改回"验证通过再删"的直觉写法），确认「同一个 code
   被并发兑换时只有一个成功」变红——这一条比其余几条更容易在未来的重构里被
   无意间移回错误的位置，值得单独强调、单独验证。
4. **（CRITICAL-4）** 把 `redirect_uri` 精确相等改成 `startsWith` 前缀匹配，
   确认「redirect_uri 必须与注册值精确相等」变红。
5. **（I-11）** 把 refresh 复用时"吊销整条链"改成只拒绝这一次（不吊销新轮换出
   的那一支），确认「旧的再用一次会连带吊销整条链」测试里第二个 `rejects` 断言
   变红。
6. **（I-9）** 把 `algorithms: ["HS256"]` 从 `jwtVerify` 调用里去掉：现有测试
   套件不会变红（套件里没有构造 HS512 令牌的用例），这本身就是这条防护此前
   完全没有回归覆盖的证据。额外做一次一次性手动探针：用同一把密钥、HS512
   签一个 `aud`/`iss` 都合法的令牌，去掉 `algorithms` 限制后 `verifyBearer`
   接受它，加回后拒绝——**把这次观察写进报告**，不要求它体现为自动化测试
   的红/绿。

- [ ] **Step 6: 提交**

```bash
git add src/oauth.ts tests/oauth.test.ts package.json pnpm-lock.yaml
git commit -m "feat(s0-d): OAuth 授权服务器，补上 U1 实测发现的 refresh_token 缺口"
```

---


---

## 本切片明确不做

| 不做 | 归属 |
|---|---|
| 删除文件、Checkpoint、Trash | S1 |
| `git commit` / push / GitHub | S2 及以后 |
| 前端控制台 | S2.5（T3，须过 Mockup Gate） |
| CIMD 注册路径（本轮走 DCR） | 若不想每次连接都动态注册新 client 时再做 |
| 多 repo 并存时 ChatGPT 的行为 | 第二个仓库进入 workspace 时 |
| `/authorize` 的用户认证（Cloudflare Access） | 见 Task 2 顶部的阻断说明；方案定稿并实测通过后单开任务 |