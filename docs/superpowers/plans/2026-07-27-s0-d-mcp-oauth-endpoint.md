# S0-D MCP 端点与 OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 S0-A/B/C 的 18 个模块接成一个 ChatGPT 能真正连上、认证、并完成
「读 → 改 → 跑测试 → 看失败 → 再改 → 通过」闭环的 MCP 端点。

**Architecture:** Hono HTTP 服务 → 每 repo 一个 `/mcp/<repoId>` 端点 → OAuth 2.1
资源服务器 → MCP 工具层。工具处理器是**唯一**把内部异常翻译成 `error{code}` 信封的地方，
也是**唯一**创建审计句柄的地方。

**Tech Stack:** TypeScript、Hono、`@modelcontextprotocol/sdk@1.29.0`、`jose`（JWT）、vitest。

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
  它缺 `refresh_token`，那正是本切片要补的。
- Cloudflare 隧道 `grande-gpt` → `grande.agentjoey.ai` → `127.0.0.1:8787`，production 命名。
- `src/` 18 个模块，339 测试。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/errors.ts` | 内部异常 → 工具错误码映射（规格 §7.1 那张表） |
| `src/tools.ts` | 九个工具的 schema、注解与处理器 |
| `src/oauth.ts` | OAuth AS：DCR、authorize、token、refresh、发现文档 |
| `src/server.ts` | Hono 应用、每-repo 路由、MCP transport、启动流程 |

**任务顺序按「越早能用越好」排**：Task 1–3 做完就有一个**只读但真能连**的端点，
可以挂上 ChatGPT 试。写与跑在 Task 4–5。

---

### Task 1: 错误映射层

**Files:** Create `src/errors.ts`；Test `tests/errors.test.ts`

**Interfaces:**
- Produces: `type ToolErrorCode`（规格 §7 的 12 个码）、
  `interface ToolError { code: ToolErrorCode; message: string; retryable: boolean; details: Record<string, unknown> }`、
  `function toToolError(e: unknown): ToolError`

**这是 S0-D 唯一把内部异常翻译成工具错误码的地方。** 规格 §7.1 的映射表是权威，
**不得靠解析 message 字符串** —— 字符串会被改写、被本地化、被截断。

- [ ] **Step 1: 写失败测试**

`tests/errors.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { toToolError } from "../src/errors.ts";
import { PathSecurityError } from "../src/paths.ts";
import { PolicyError } from "../src/policy.ts";
import { ProfileError } from "../src/profiles.ts";
import { EditError } from "../src/repoFile.ts";
import { GitError } from "../src/worktree.ts";

describe("toToolError()", () => {
  it.each([
    [new PathSecurityError("PATH_ESCAPE", "x"), "POLICY_DENIED", false],
    [new PathSecurityError("INVALID_INPUT", "x"), "INVALID_INPUT", false],
    [new PathSecurityError("REPO_NOT_REGISTERED", "x"), "REPO_NOT_REGISTERED", false],
    [new PolicyError("POLICY_DENIED", "x"), "POLICY_DENIED", false],
    [new PolicyError("BAD_CONFIG", "x"), "POLICY_DENIED", false],
    [new EditError("STALE_FILE", "x"), "STALE_FILE", true],
    [new EditError("FILE_NOT_FOUND", "x"), "INVALID_INPUT", false],
    [new EditError("FILE_EXISTS", "x"), "INVALID_INPUT", false],
    [new ProfileError("PROFILE_NOT_FOUND", "x"), "PROFILE_NOT_FOUND", false],
    [new GitError("CANONICAL_BUSY", "x"), "CANONICAL_BUSY", true],
    [new GitError("GIT_FAILED", "x"), "INVALID_INPUT", false],
    [new GitError("WORKTREE_EXISTS", "x"), "INVALID_INPUT", false],
  ])("映射 %s", (err, code, retryable) => {
    const t = toToolError(err);
    expect(t.code).toBe(code);
    expect(t.retryable).toBe(retryable);
  });

  it("映射【不】靠解析 message：同一个码、message 完全不同，结果一致", () => {
    // 字符串会被改写、被本地化、被截断——契约必须建立在 .code 上
    const a = toToolError(new PathSecurityError("PATH_ESCAPE", "路径逃逸"));
    const b = toToolError(new PathSecurityError("PATH_ESCAPE", "完全不同的措辞 xyz"));
    expect(a.code).toBe(b.code);
  });

  it("message 里含另一个码的字样也不会串味", () => {
    const t = toToolError(new EditError("STALE_FILE", "这条消息里提到了 POLICY_DENIED 三个字"));
    expect(t.code).toBe("STALE_FILE");
  });

  it("未知异常降级为 INTERNAL 且【不】把原始 message 透给模型", () => {
    // 内部错误可能含路径、堆栈、配置片段——那些不该进对话
    const t = toToolError(new Error("ENOENT: /Users/someone/.ssh/id_rsa"));
    expect(t.code).toBe("INTERNAL");
    expect(t.message).not.toContain("id_rsa");
    expect(t.retryable).toBe(false);
  });

  it("非 Error 值也能安全处理", () => {
    for (const v of [undefined, null, "字符串", 42, { code: "POLICY_DENIED" }]) {
      expect(() => toToolError(v)).not.toThrow();
    }
    expect(toToolError({ code: "POLICY_DENIED" }).code).toBe("INTERNAL");
  });
});
```

**最后一条是关键**：一个**裸对象**带着 `code: "POLICY_DENIED"` 不该被当成合法映射源 ——
否则仓库里的数据（比如一段被 JSON.parse 的测试输出）就能伪造成策略决定。
映射必须只认我们自己的错误类实例。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/errors.test.ts`
Expected: FAIL —— `Cannot find module '../src/errors.ts'`

- [ ] **Step 3: 实现**

`src/errors.ts`：

```typescript
import { PathSecurityError } from "./paths.ts";
import { PolicyError } from "./policy.ts";
import { ProfileError } from "./profiles.ts";
import { EditError } from "./repoFile.ts";
import { SearchError } from "./repoSearch.ts";
import { MapError } from "./repoMap.ts";
import { RunnerError } from "./runner.ts";
import { GitError } from "./worktree.ts";

/** 规格 §7 的工具错误码，外加一个 INTERNAL 兜底 */
export type ToolErrorCode =
  | "INVALID_INPUT" | "UNAUTHORIZED" | "POLICY_DENIED" | "REPO_NOT_REGISTERED"
  | "TASK_NOT_FOUND" | "STALE_FILE" | "CANONICAL_BUSY" | "WORKTREE_DIRTY"
  | "PROFILE_NOT_FOUND" | "JOB_TIMEOUT" | "RESOURCE_EXHAUSTED" | "NETWORK_DENIED"
  | "INTERNAL";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

/** 内部码 → 工具码。规格 §7.1 那张表 */
const MAP: Record<string, { code: ToolErrorCode; retryable: boolean }> = {
  PATH_ESCAPE:          { code: "POLICY_DENIED",       retryable: false },
  POLICY_DENIED:        { code: "POLICY_DENIED",       retryable: false },
  BAD_CONFIG:           { code: "POLICY_DENIED",       retryable: false },
  REPO_NOT_REGISTERED:  { code: "REPO_NOT_REGISTERED", retryable: false },
  REPO_NOT_FOUND:       { code: "REPO_NOT_REGISTERED", retryable: false },
  INVALID_INPUT:        { code: "INVALID_INPUT",       retryable: false },
  STALE_FILE:           { code: "STALE_FILE",          retryable: true  },
  FILE_NOT_FOUND:       { code: "INVALID_INPUT",       retryable: false },
  FILE_EXISTS:          { code: "INVALID_INPUT",       retryable: false },
  PROFILE_NOT_FOUND:    { code: "PROFILE_NOT_FOUND",   retryable: false },
  CANONICAL_BUSY:       { code: "CANONICAL_BUSY",      retryable: true  },
  GIT_FAILED:           { code: "INVALID_INPUT",       retryable: false },
  WORKTREE_EXISTS:      { code: "INVALID_INPUT",       retryable: false },
  JOB_NOT_FOUND:        { code: "INVALID_INPUT",       retryable: false },
  TASK_NOT_FOUND:       { code: "TASK_NOT_FOUND",      retryable: true  },
};

/**
 * 我们自己的错误类。**只有这些类的实例参与映射** —— 一个裸对象带着
 * `code: "POLICY_DENIED"` 不能被当成合法映射源，否则仓库里的数据
 * （例如一段被 JSON.parse 的测试输出）就能伪造成一次策略决定。铁律一。
 */
const KNOWN = [
  PathSecurityError, PolicyError, ProfileError, EditError,
  SearchError, MapError, RunnerError, GitError,
] as const;

function structuredCode(e: unknown): string | null {
  if (!KNOWN.some((C) => e instanceof C)) return null;
  const c = (e as { code?: unknown }).code;
  return typeof c === "string" ? c : null;
}

/**
 * 把任意抛出物翻译成发给 ChatGPT 的 `error{...}`。
 *
 * **绝不解析 message 字符串**：message 会被改写、被本地化、被截断，
 * 而且它可能原样包含另一个错误码的字样。契约建立在 `.code` 上。
 *
 * 未知异常一律降级成 `INTERNAL` 且**丢弃原始 message** —— 内部错误常含
 * 绝对路径、堆栈、配置片段，那些不该进对话。完整信息留在服务端日志。
 */
export function toToolError(e: unknown): ToolError {
  const code = structuredCode(e);
  const hit = code === null ? undefined : MAP[code];
  if (hit === undefined) {
    return {
      code: "INTERNAL",
      message: "Gateway 内部错误。详情见服务端日志。",
      retryable: false,
      details: {},
    };
  }
  return {
    code: hit.code,
    message: (e as Error).message,
    retryable: hit.retryable,
    details: {},
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/errors.test.ts`
Expected: PASS（12 + 5 = 17 个用例）

- [ ] **Step 5: 承重性验证**

把 `structuredCode` 里的 `KNOWN.some(...)` 检查删掉（即改成任何带 `.code` 的东西都认），
确认「非 Error 值」那条里的裸对象断言变红；还原后确认变绿。**把观察写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/errors.ts tests/errors.test.ts
git commit -m "feat(s0-d): 内部异常 → 工具错误码映射层"
```

---

### Task 2: OAuth 授权服务器（含 refresh_token）

**Files:** Create `src/oauth.ts`；Test `tests/oauth.test.ts`

**Interfaces:**
- Produces: `interface OAuthConfig { issuer: string; endpointFor(repoId: string): string }`、
  `function createOAuth(cfg: OAuthConfig): OAuthRoutes`，其中 `OAuthRoutes` 暴露
  `register` / `authorize` / `token` / `protectedResourceMetadata` / `authServerMetadata` / `verifyBearer`

**按 `spike/oauth/server.ts` 重写，不要 import。** 那份原型已与 ChatGPT 真实握手跑通，
但**缺 `refresh_token`** —— 这是本任务要补的核心。

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

- [ ] **Step 1: 写失败测试**

`tests/oauth.test.ts`：

```typescript
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOAuth } from "../src/oauth.ts";

const ISSUER = "https://grande.example.test";
const oauth = () =>
  createOAuth({ issuer: ISSUER, endpointFor: (r) => `${ISSUER}/mcp/${r}` });

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

  it("AS 元数据【如实】声明 grant_types_supported 含 refresh_token", () => {
    // U1 实测的教训：原型声明 ["authorization_code"] 却接受了 ChatGPT 的
    // refresh_token 注册请求，于是它以为能续期，1 小时后连接直接断。
    const m = oauth().authServerMetadata();
    expect(m.grant_types_supported).toContain("authorization_code");
    expect(m.grant_types_supported).toContain("refresh_token");
    expect(m.code_challenge_methods_supported).toContain("S256");
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
    await expect(oauth().authorize({
      client_id: "c", redirect_uri: "https://chatgpt.com/connector/oauth/x",
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
    const o = oauth();
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
});

describe("verifyBearer —— D5 每-repo 隔离", () => {
  it("aud 匹配的令牌通过", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    await expect(o.verifyBearer(tok.access_token, `${ISSUER}/mcp/demo`)).resolves.toBeTruthy();
  });

  it("用 demo 的令牌打 other 端点被拒（D5 由协议层强制）", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    await expect(o.verifyBearer(tok.access_token, `${ISSUER}/mcp/other`)).rejects.toThrow();
  });

  it("篡改过的令牌被拒", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    const bad = tok.access_token.slice(0, -3) + "xyz";
    await expect(o.verifyBearer(bad, `${ISSUER}/mcp/demo`)).rejects.toThrow();
  });

  it("空串与非 JWT 被拒，而不是抛出未分类的异常", async () => {
    const o = oauth();
    for (const t of ["", "not-a-jwt", "a.b.c"]) {
      await expect(o.verifyBearer(t, `${ISSUER}/mcp/demo`)).rejects.toThrow();
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/oauth.test.ts`
Expected: FAIL —— `Cannot find module '../src/oauth.ts'`

- [ ] **Step 3: 实现**

先读 `spike/oauth/server.ts`，理解它已经跑通的那部分。然后在 `src/oauth.ts` 里重写，
**补上 refresh_token**。要点：

- 用 `jose` 签 JWT。密钥从 `~/.grande-control/secrets/` 读，不存在则生成并落盘
  （权限 `0600`）。**绝不写进仓库**。
- `authorize()` 必须要求 `code_challenge` 与 `code_challenge_method === "S256"`，
  缺任一即拒。
- 授权码一次性：换过即从存储中删除。
- `refresh_token` 独立签发、独立存储，**记录它绑定的 `resource`** —— `token()`
  在 refresh 时必须校验请求的 `resource` 与之相等，否则就是跨端点提权。
- `register()` 按 RFC 7591 把请求的 `grant_types` 与实际支持的求交集后回传。
- 访问令牌寿命：**单用户场景可放宽到 8 小时**，但**不得靠「长期不过期」回避 refresh** ——
  U1 已证明 ChatGPT 会用 refresh，不实现它就是 1 小时后断线。

**依赖**：本任务引入 `jose`（纯 JS、无原生代码）。这是 S0 的第三个依赖，
理由是自己实现 JWT 签验是安全上不该做的事。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/oauth.test.ts`
Expected: PASS（2 + 2 + 4 + 4 + 4 = 16 个用例）

- [ ] **Step 5: 承重性验证**

分别做两次：① 把 `authorize()` 里的 `code_challenge` 必填检查去掉，确认
「不带 code_challenge 被拒」变红；② 把 refresh 时的 `resource` 相等校验去掉，
确认「refresh 不能跨端点提权」变红。**两次观察都写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/oauth.ts tests/oauth.test.ts package.json pnpm-lock.yaml
git commit -m "feat(s0-d): OAuth 授权服务器，补上 U1 实测发现的 refresh_token 缺口"
```

---

### Task 3: 六个只读工具 + MCP 服务端骨架

**Files:** Create `src/tools.ts`、`src/server.ts`；Test `tests/tools.test.ts`、`tests/server.test.ts`

**做完这个任务就有一个能连、能认证、能读的端点** —— 可以挂上 ChatGPT 实测。

**Interfaces:**
- Produces: `function buildTools(deps: ToolDeps): ToolDef[]`、
  `interface ToolDeps { db: DatabaseSync; layout: Layout; repoId: string }`、
  `function createApp(cfg: AppConfig): Hono`、`function startGateway(cfg: AppConfig): Promise<void>`

**本任务只注册六个只读工具**：`grande_task_status`、`grande_repo_map`、
`grande_repo_search`、`grande_repo_read`、`grande_diff`、`grande_run_result`。
写工具在 Task 4，`grande_run` 在 Task 5。

- [ ] **Step 1: 写失败测试**

`tests/tools.test.ts` 覆盖：

```typescript
describe("工具注解", () => {
  it("六个只读工具全部 readOnlyHint: true", () => {
    // ChatGPT 的 Allow read actions 权限档靠它精确放行轮询而拦住写入。
    // 全标成写工具该档位即失效——这是 POC 实测确认过的杠杆。
    for (const t of buildTools(deps)) {
      expect(t.annotations.readOnlyHint, `${t.name} 应为只读`).toBe(true);
    }
  });

  it("所有工具 openWorldHint: false（S0 全禁网）", () => {
    for (const t of buildTools(deps)) expect(t.annotations.openWorldHint).toBe(false);
  });

  it("repoId 不出现在任何工具的入参 schema 里（D5：由端点决定）", () => {
    for (const t of buildTools(deps)) {
      expect(Object.keys(t.inputSchema.properties ?? {}), t.name).not.toContain("repoId");
    }
  });
});

describe("响应信封", () => {
  it("成功响应的字段顺序：truncated/nextCursor/hint 必须排在 data 之前", async () => {
    const r = await callTool("grande_repo_map", {});
    const keys = Object.keys(JSON.parse(r));
    for (const k of ["truncated", "nextCursor", "hint"]) {
      expect(keys.indexOf(k)).toBeLessThan(keys.indexOf("data"));
    }
  });

  it("内部异常被翻译成 error{code}，且【不】把内部 message 透出去", async () => {
    const r = JSON.parse(await callTool("grande_repo_read", { path: "../outside.ts" }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("POLICY_DENIED");
  });

  it("未知异常降级为 INTERNAL 而不是让整个调用失败", async () => {
    const r = JSON.parse(await callToolThatThrowsRaw());
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INTERNAL");
  });
});
```

`tests/server.test.ts` 覆盖（用 Hono 的 `app.request()`，不起真实端口）：

```typescript
describe("每-repo 端点与认证", () => {
  it("无 Bearer 的 POST /mcp/<repoId> 返回 401，且 WWW-Authenticate 指向【每-repo】元数据", async () => {
    // U1 实测：ChatGPT 先撞 401，再顺这个头去找元数据。写错握手起不来。
    const res = await app.request("/mcp/demo", { method: "POST" });
    expect(res.status).toBe(401);
    const h = res.headers.get("WWW-Authenticate") ?? "";
    expect(h).toContain("resource_metadata=");
    expect(h).toContain("/.well-known/oauth-protected-resource/mcp/demo");
  });

  it("未注册的 repoId 返回 404，且【不】泄漏工作区里有哪些目录", async () => {
    const res = await app.request("/mcp/not-registered", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("grande-gpt");
  });

  it("用 demo 的令牌打 other 端点被拒（D5）", async () => { /* … */ });

  it("每-repo 的发现文档可取，且 resource 是该 repo 自己的端点", async () => { /* … */ });
});

describe("启动流程", () => {
  it("startGateway 在开始接受工具调用【之前】跑完 reconcileRunningJobs", async () => {
    // 规格 §7.0③：AC-11 在系统层面成立的前提。顺序反了，新 job 会与对账竞争。
    const order: string[] = [];
    await startGateway({ ...cfg, onReconcile: () => order.push("reconcile"),
                                 onListen:    () => order.push("listen") });
    expect(order).toEqual(["reconcile", "listen"]);
  });
});
```

- [ ] **Step 2–4: RED → 实现 → GREEN**

实现要点：
- **transport 用 `WebStandardStreamableHTTPServerTransport`**，从
  `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` 引入。
  Node 风格那个与 Hono 不兼容 —— POC 阶段踩过。
- 每个工具处理器统一包一层：`try { … } catch (e) { return err(toToolError(e)) }`。
  **这是唯一的翻译点。**
- `taskContext` 每个响应都回带（分支、变更文件数、最近 job 状态），
  让 `taskId` 持续出现在上下文里 —— POC 实测模型在长会话里会弄丢它。

- [ ] **Step 5: 承重性验证**

把 `startGateway` 里 reconcile 与 listen 的顺序对调，确认启动顺序那条变红；还原。
**写进报告。**

- [ ] **Step 6: 提交 + 人工挂机实测**

```bash
git add src/tools.ts src/server.ts tests/tools.test.ts tests/server.test.ts
git commit -m "feat(s0-d): MCP 服务端骨架与六个只读工具"
```

**然后停下来交给 Human Owner**：起服务、走隧道、在 ChatGPT 里加一次连接器，
确认 OAuth 握手通过且六个只读工具可用。**这一步不能自动化验证** —— U1 的
refresh_token 缺口正是 curl 全绿、静态检查也发现不了的那类问题。

---

### Task 4: 写工具 + 审计结构性接入

**Files:** Modify `src/tools.ts`、`src/repoFile.ts`、`src/runner.ts`；Test 同名测试

**规格 §7.0①**：`repoEdit` 与 `startJob` 的签名**必须**带 `AuditHandle` 参数。

- [ ] **Step 1: 改签名并写测试**

```typescript
// src/repoFile.ts —— 签名变更
export function repoEdit(
  root: string,
  ops: readonly EditOp[],
  rules: DenyRules,
  audit: AuditHandle,   // ← 新增，非可选
): EditResult;
```

测试必须覆盖：

```typescript
it("repoEdit 在写盘【之前】把句柄推进到 EXECUTING", () => {
  // INTENT 先行的意义在于：崩在中途也留下可发现的未完成记录。
  // 若推进发生在写盘之后，崩溃窗口里的记录会停在 INTENT 而文件已经改了。
  const seen: string[] = [];
  const spy = { ...handle, executing: () => { seen.push("executing"); return handle.executing(); } };
  repoEdit(root, [{ op: "create", path: "a.ts", content: "x" }], RULES, spy);
  expect(seen).toEqual(["executing"]);
  expect(getAudit(db, handle.opId)!.state).toBe("SUCCEEDED");
});

it("句柄推进失败时【不写盘】", () => {
  // executing() 返回 false 意味着 Policy 从未放行（或有人先到了）。
  // 这时候写下去就是「没有裁决记录的变更」——审计账本最不该出现的东西。
  const h = beginAudit(db, { taskId: null, tool: "grande_repo_edit", input: {} });
  // 故意不调用 allowed()，executing() 因此返回 false
  expect(() => repoEdit(root, [{ op: "create", path: "a.ts", content: "x" }], RULES, h))
    .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  expect(existsSync(join(root, "a.ts"))).toBe(false);
});

it("失败时句柄落到 FAILED 且带 reason", () => { /* … */ });

it("类型层面无法绕过：repoEdit 少传句柄不能编译（本条由 tsc 保证，此处记录意图）", () => {
  expect(repoEdit.length).toBe(4);
});
```

- [ ] **Step 2–4: RED → 实现 → GREEN**

`startJob` 同样加 `audit: AuditHandle`，并在 spawn 之前 `executing()`。

工具处理器负责创建句柄：`beginAudit` → `allowed()`（Policy 通过后）→ 传进去。

- [ ] **Step 5: 承重性验证**

把 `repoEdit` 里的 `executing()` 返回值检查去掉，确认「推进失败时不写盘」变红；还原。

- [ ] **Step 6: 提交**

---

### Task 5: `grande_run` / `grande_task_open` + NETWORK_DENIED 信号

**Files:** Modify `src/tools.ts`、`src/runner.ts`、`src/sbpl.ts`；Test 同名

- [ ] **Step 1: 写测试**

```typescript
it("grande_run 立刻返回 jobId 与 pollAfterSeconds，不等命令跑完", async () => {
  const t0 = Date.now();
  const r = JSON.parse(await callTool("grande_run", { profile: "slow" }));
  expect(Date.now() - t0).toBeLessThan(1000);   // 规格 §5.4①
  expect(r.data.jobId).toMatch(/^job_/);
  expect(r.data.pollAfterSeconds).toBeGreaterThan(0);
  expect(r.hint).toContain("grande_run_result");  // 明确告诉模型下一步
});

it("联网尝试产生 NETWORK_DENIED，而不是与普通测试失败混在一起", async () => {
  // 规格 §7.0②：这是 AC-5 验收断言得以成立的前提。
  const r = JSON.parse(await callTool("grande_run", { profile: "curl-probe" }));
  await settle(r.data.jobId);
  const res = JSON.parse(await callTool("grande_run_result", { jobId: r.data.jobId }));
  expect(res.data.networkDenied).toBe(true);
});

it("普通的测试失败【不】被误判成 NETWORK_DENIED（过度触发也是 bug）", async () => {
  const r = JSON.parse(await callTool("grande_run", { profile: "fail" }));
  await settle(r.data.jobId);
  const res = JSON.parse(await callTool("grande_run_result", { jobId: r.data.jobId }));
  expect(res.data.networkDenied).toBe(false);
});
```

**NETWORK_DENIED 的实现取舍**：Seatbelt 不给我们一个权威的「因为网络被拒」信号。
可行做法是在摘要解析阶段匹配常见特征（`Operation not permitted` 配合网络相关的
系统调用名、curl 的退出码 7/6、Node 的 `EPERM` + `connect`）。**这是启发式，
必须在 `hint` 里如实说明**，不能让模型以为这是沙箱的权威判定。第二条测试
（不过度触发）与第一条同等重要。

- [ ] **Step 2–6: RED → 实现 → GREEN → 承重性 → 提交**

---

### Task 6: 端到端与 AC-13

- [ ] 在 fixture 仓库上跑完整闭环：`task_open` → `repo_read` → `repo_edit` →
      `run` → `run_result`（失败）→ `repo_edit` → `run` → `run_result`（通过）
- [ ] **人工**：在真实 ChatGPT 对话里做一次同样的闭环，记录对话轮数、确认框次数、
      模型选错工具的次数、`taskId` 是否丢失
- [ ] 观察记录写入 `docs/research/`，**这是 AC-13 的交付物**

**规格 §9.2**：AC-13 的观察记录直接决定 S1–S5 的工具设计，必须成文留存而非口头结论。

---

## 本切片明确不做

| 不做 | 归属 |
|---|---|
| 删除文件、Checkpoint、Trash | S1 |
| `git commit` / push / GitHub | S2 及以后 |
| 前端控制台 | S2.5（T3，须过 Mockup Gate） |
| CIMD 注册路径（本轮走 DCR） | 若不想每次连接都动态注册新 client 时再做 |
| 多 repo 并存时 ChatGPT 的行为 | 第二个仓库进入 workspace 时 |
