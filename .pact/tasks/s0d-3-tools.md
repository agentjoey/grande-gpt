# s0d-3-tools

> S0-D 的第 3 个任务，从 `docs/superpowers/plans/2026-07-27-s0-d-mcp-oauth-endpoint.md` 切出。
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

### Task 3: 六个只读工具 + MCP 服务端骨架

**Files:** Create `src/tools.ts`、`src/server.ts`；Test `tests/tools.test.ts`、`tests/server.test.ts`

**做完这个任务就有一个能连、能认证、能读的端点** —— 可以挂上 ChatGPT 实测。

**Interfaces:**
- Produces: `function buildTools(deps: ToolDeps): ToolDef[]`、
  `interface ToolDeps { db: DatabaseSync; layout: Layout; repoId: string }`、
  `function createApp(cfg: AppConfig): Hono`、
  `function startGateway(cfg: AppConfig): Promise<{ app: Hono; close: () => Promise<void> }>`
  （**返回值从 `Promise<void>` 改为 `{ app, close }`，I-2，见下）
- `ToolDef`/`AppConfig` 原计划从未定义，这里补上最小形状，供 Step 1 的测试代码引用：

  ```typescript
  interface ToolDef {
    name: string;
    description: string;
    inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
    handler: (args: Record<string, unknown>) => Promise<{ structuredContent: unknown }>;
  }

  interface AppConfig {
    issuer: string;
    layout: Layout;
    db: DatabaseSync;
  }
  ```

**本任务只注册六个只读工具**：`grande_task_status`、`grande_repo_map`、
`grande_repo_search`、`grande_repo_read`、`grande_diff`、`grande_run_result`。
写工具在 Task 4，`grande_run` 与 `grande_task_open` 在 Task 5。

> **Task 3 结束时的交接说明（任务排序，minor）**：`grande_task_open` 在 Task 5 才
> 注册。这意味着做完 Task 3 交给 Human Owner 挂机实测时，`grande_task_status`、
> `grande_diff`、`grande_run_result` 三个工具**没有任何办法产生非空数据**——它们
> 都要求一个已存在的 `taskId`/worktree，而开 task 的工具还不存在。这是有意选择
> 保留的排序，不是遗漏：这三个工具挪到 Task 5 需要把 `AuditHandle` 的接入面进一步
> 打散（`grande_task_open` 本身不需要 `AuditHandle`——规格 §7.0① 只点名了
> `repoEdit`/`startJob` 这两个"本切片仅有的变更操作"，但它仍然是一次写操作，
> 混进"六个只读工具"那批会打破 Task 3 "全部 readOnlyHint: true" 这条测试断言
> 的干净边界），而 Task 3 结尾本就有一个必须由人完成的手工验收关卡（起服务、
> 走隧道、连 ChatGPT），"六个只读工具连接与鉴权是否工作"已经是一个自洽、可
> 验证的目标，不依赖 `grande_task_open`。人工验收时**如实告知** Human Owner
> 这三个工具此刻打不出真实数据，只验证 OAuth 握手 + 六个工具的 schema/注解
> 可见，完整闭环验收留到 Task 5/6。

- [ ] **Step 0: 安装 Task 3 引入的四个依赖（I-7）**

根 `package.json` 目前只有 `{ "yaml": "2.8.1" }`（加上 Task 2 引入的 `jose`）。
本任务要用的 `hono`、`@hono/node-server`、`@modelcontextprotocol/sdk`、`zod`
一个都还没装：

```bash
pnpm add hono @hono/node-server @modelcontextprotocol/sdk@1.30.0 zod
```

（版本与 Tech Stack 声明的 `@modelcontextprotocol/sdk@1.30.0` 保持一致。）

- [ ] **Step 1: 写失败测试**

`tests/tools.test.ts` 覆盖：

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let ws: string, ctrl: string, layout: Layout, deps: ToolDeps;
let savedWs: string | undefined, savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "tools-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "tools-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);
  // ……（fixture repo 的建立与 registry.yaml 的写入，与 runner.test.ts 的
  // beforeEach 同构，此处从略，实现时直接照搬那份 fixture）
  deps = { db, layout, repoId: "demo" };
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

/** 直接调用工具处理器，绕开 MCP transport——这份测试文件验证的是 buildTools()
 *  产出的 schema/注解/处理器本身，不是协议层（那是 server.test.ts 的职责）。 */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = buildTools(deps).find((t) => t.name === name);
  if (!tool) throw new Error(`未注册的工具：${name}`);
  const r = await tool.handler(args);
  return JSON.stringify(r.structuredContent);
}

/** 故意绕过声明的入参类型、直接喂一个必然导致处理器内部抛出【未分类】异常的值
 *  ——不是任何 KNOWN 错误类的实例，用来证明 INTERNAL 兜底真的兜住了任意异常，
 *  而不仅仅是我们自己抛出的那些结构化错误。 */
async function callToolThatThrowsRaw(): Promise<string> {
  const tool = buildTools(deps).find((t) => t.name === "grande_repo_read")!;
  // repoRead() 内部第一步就是 resolveInRepo(root, relativePath)，relativePath
  // 若是 undefined，`.length` 访问会抛裸 TypeError——不经过任何 PathSecurityError。
  const r = await tool.handler({ path: undefined as unknown as string });
  return JSON.stringify(r.structuredContent);
}

const READ_ONLY = [
  "grande_task_status", "grande_repo_map", "grande_repo_search",
  "grande_repo_read", "grande_diff", "grande_run_result",
] as const;

describe("工具注解", () => {
  // 集合断言而不是"遍历返回值"：`buildTools = () => []` 能让下面每一条遍历式
  // 断言全绿——空数组上的 for 循环一次都不执行。这一条把"到底注册了哪几个
  // 工具"钉死，是下面几条遍历断言真正有意义的前提。
  it("恰好注册六个只读工具，且名字与规格 §5.2 一致", () => {
    expect(buildTools(deps).map((t) => t.name).sort()).toEqual([...READ_ONLY].sort());
    expect(buildTools(deps)).toHaveLength(READ_ONLY.length);
  });

  it("六个只读工具全部 readOnlyHint: true", () => {
    // ChatGPT 的 Allow read actions 权限档靠它精确放行轮询而拦住写入。
    // 全标成写工具该档位即失效——这是 POC 实测确认过的杠杆。
    const tools = buildTools(deps);
    expect(tools).toHaveLength(READ_ONLY.length);
    for (const t of tools) {
      expect(t.annotations.readOnlyHint, `${t.name} 应为只读`).toBe(true);
    }
  });

  it("所有工具 openWorldHint: false（S0 全禁网）", () => {
    const tools = buildTools(deps);
    expect(tools).toHaveLength(READ_ONLY.length);
    for (const t of tools) expect(t.annotations.openWorldHint).toBe(false);
  });

  it("repoId 不出现在任何工具的入参 schema 里（D5：由端点决定）", () => {
    const tools = buildTools(deps);
    expect(tools).toHaveLength(READ_ONLY.length);
    for (const t of tools) {
      // `?? {}` 会让"根本没有 inputSchema"与"inputSchema.properties 是空对象"
      // 表现成同一个通过结果——先断言它确实存在，否则一个完全没有声明
      // inputSchema 的工具定义也能让这条测试通过。
      expect(t.inputSchema.properties, t.name).toBeDefined();
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

  // I-1c：绝对宿主路径不能原样进 ChatGPT 对话（D12 下等同于对外发布）。
  it("错误消息里不含 layout.workspaceRoot 这个绝对路径前缀", async () => {
    const r = JSON.parse(await callTool("grande_repo_read", { path: "../outside.ts" }));
    expect(JSON.stringify(r)).not.toContain(layout.workspaceRoot);
  });
});
```

`tests/server.test.ts` 覆盖（用 Hono 的 `app.request()`，不起真实端口）：

```typescript
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
// ……（beforeEach 建 app/layout/db/fixture repo，与上面 tools.test.ts 同构，
// 额外注册两个 repoId："demo" 与 "other"，供 D5 隔离测试使用；从略）

const ISSUER = "https://grande.example.test"; // 与 AppConfig.issuer 一致

/** 走完一遍 HTTP 层面的 OAuth 流程，返回某个 repoId 的 access_token。
 *  之所以经 app.request() 走完整 HTTP 路径而不是直接调 oauth 对象的方法——
 *  这份文件测的是 Hono 路由本身有没有正确接上 oauth.ts，不是 oauth.ts 自己
 *  的逻辑（那是 tests/oauth.test.ts 的职责）。 */
async function mintToken(app: Hono, repoId: string): Promise<string> {
  const reg = await app.request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test", redirect_uris: ["https://chatgpt.com/connector/oauth/x"],
      grant_types: ["authorization_code"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }).then((r) => r.json());
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: reg.client_id, redirect_uri: reg.redirect_uris[0],
    code_challenge: challenge, code_challenge_method: "S256", response_type: "code",
    resource: `${ISSUER}/mcp/${repoId}`, scope: `grande:repo:${repoId}`,
  });
  const authRes = await app.request(`/authorize?${q}`, { redirect: "manual" });
  const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
  const tok = await app.request("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0], resource: `${ISSUER}/mcp/${repoId}`,
    }),
  }).then((r) => r.json());
  return tok.access_token;
}

describe("每-repo 端点与认证", () => {
  it("已注册 repoId 无 Bearer 的 POST 返回 401，且 WWW-Authenticate 指向【每-repo】元数据", async () => {
    // U1 实测：ChatGPT 先撞 401，再顺这个头去找元数据。写错握手起不来。
    const res = await app.request("/mcp/demo", { method: "POST" });
    expect(res.status).toBe(401);
    const h = res.headers.get("WWW-Authenticate") ?? "";
    expect(h).toContain("resource_metadata=");
    expect(h).toContain("/.well-known/oauth-protected-resource/mcp/demo");
  });

  // I-10：原计划这里另有一条「未注册的 repoId 返回 404」、且不需要携带任何
  // Bearer 的测试——这条测试本身就【是】枚举 oracle：未认证时 已注册=401、
  // 未注册=404，任何匿名探测者靠这一个位差就能枚举用户的私有项目目录名
  // （D12 下等同于把它们交给对话）。收口方式是把两者拉平，见下。
  it("未注册与已注册的 repoId 在【未认证】时响应完全一致（不可匿名枚举）", async () => {
    const a = await app.request("/mcp/demo", { method: "POST" });
    const b = await app.request("/mcp/not-registered", { method: "POST" });
    expect(b.status).toBe(a.status);
    expect(b.status).toBe(401);         // ← 否则「两边都 404」的空实现也算通过
    expect(b.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  // 404 仍然存在，但现在只在"认证已经通过"之后才可能出现——真实场景是一个
  // repo 曾经注册过、已经签发过令牌，之后被从 registry.yaml 里移除（例如
  // 用户不想再对 ChatGPT 暴露它）；旧令牌签名仍然合法，直到这一步才应该
  // 得知"这个 repo 已经不可用"，而不是在鉴权之前就得知。
  it("已认证但 repoId 已被撤销注册时返回 404，且【不】泄漏工作区里还有哪些目录", async () => {
    const token = await mintToken(app, "demo");
    unregister(layout, "demo"); // 测试辅助：把 demo 从 registry.yaml 标记为未注册
    const res = await app.request("/mcp/demo", {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("grande-gpt");
  });

  it("用 demo 的令牌打 other 端点被拒（D5）", async () => {
    const token = await mintToken(app, "demo");
    const res = await app.request("/mcp/other", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("每-repo 的发现文档可取，且 resource 是该 repo 自己的端点", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource/mcp/demo");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(`${ISSUER}/mcp/demo`);
    expect(body.authorization_servers).toContain(ISSUER);
  });

  // I-5：repoId 直接拼进 WWW-Authenticate 响应头。`a%22%20error%3D%22x` 解码后
  // 产出 `WWW-Authenticate: Bearer resource_metadata="…/mcp/a" error="x"`；一个
  // CRLF payload 会让 Response 构造函数直接抛出、变成 500。此前测不到是因为
  // 404（未注册）检查排在 401 之前，而 I-10 的修复把 401 挪到了 404 前面，
  // 这条路径因此变得可达，必须同时补上校验。
  it("形状异常的 repoId 段（可能是响应头注入）返回 404 而不是让响应构造抛出", async () => {
    const res = await app.request(
      `/mcp/${encodeURIComponent('a" error="x')}`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});

describe("启动流程", () => {
  // I-2：原计划这条测试断言的是注入回调 onReconcile/onListen 的调用顺序——
  // 这个断言在"函数一开始就依次调用两个回调，真正的 reconcile 与 listen 随后
  // 以任意顺序发生"这种实现下同样全绿，而那正是规格 §7.0③ 要挡的形状（新 job
  // 与对账竞争）。而且原来的 startGateway 返回 Promise<void>，测试里那次调用
  // 会启动一个真实监听的 HTTP server 且从不关闭，整个测试进程因此会挂着一个
  // 泄漏的句柄退出。改成断言可观察的系统效果：一个 pgid 已死的 running job，
  // 在服务开始接受第一次工具调用时必须已经收敛完毕。
  it("startGateway 在接受第一次工具调用之前已经完成对账（观察效果，不观察回调）", async () => {
    const dead = createJob(db, { jobId: "job_dead", taskId: TASK, profile: "unit", argv: ["x"], pgid: 999999 });
    expect(getJob(db, dead.jobId)!.state).toBe("running");
    const gw = await startGateway(cfg);
    try {
      expect(getJob(db, dead.jobId)!.state).not.toBe("running");
      const res = await gw.app.request(`/mcp/${REPO}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
    } finally { await gw.close(); }
  });
});
```

- [ ] **Step 2–4: RED → 实现 → GREEN**

实现要点：
- **transport 用 `WebStandardStreamableHTTPServerTransport`**，从
  `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` 引入。
  Node 风格那个与 Hono 不兼容 —— POC 阶段踩过。
- 每个工具处理器统一包一层：

  ```typescript
  try {
    // ……工具逻辑……
  } catch (e) {
    const te = toToolError(e);
    // I-1c：绝对宿主路径脱敏——放在拿到 toToolError() 结果之后，而不是塞进
    // toToolError() 本身（Task 1 已经说明了为什么）。
    te.message = redact(te.message, [layout.workspaceRoot, layout.controlRoot]);
    // I-1d：TASK_NOT_FOUND 必须列出活跃任务及分支/变更数（规格 §7/§5.5）。
    // toToolError() 没有 db，结构性做不到；这里是唯一同时持有 db 与已经拿到
    // 分类结果的地方，选在这里补，而不是让 toToolError() 接一个可选 db 参数
    // ——那样会让 Task 1 的纯函数单测全部改成要接 db。
    if (te.code === "TASK_NOT_FOUND") {
      te.details.activeTasks = listActiveTasks(db).map((t) => ({
        taskId: t.taskId,
        branch: t.branch,
        filesChanged: listChangedFiles(t.worktreePath, t.baseCommit).length,
      }));
    }
    return err({ ...te, taskId: currentTaskId ?? null });
  }
  ```

  **这是唯一的翻译点。**
- `taskContext` 每个响应都回带（分支、变更文件数、最近 job 状态），
  让 `taskId` 持续出现在上下文里 —— POC 实测模型在长会话里会弄丢它。
- **repoId 路由参数校验 + 编码（I-5）**：

  ```typescript
  const repoId = c.req.param("repoId");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(repoId)) return c.json({ error: "not_found" }, 404);
  const metadataUrl = `${ISSUER}/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(repoId)}`;
  ```

- **`/mcp/:repoId` 的鉴权顺序（I-10，收口枚举 oracle）**：认证之前不区分「未注册」
  与「未认证」——未认证一律 401，未注册的判定推迟到令牌验过之后：

  ```typescript
  if (!VALID_REPO_ID.test(repoId)) return c.json({ error: "not_found" }, 404);
  const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  if (!bearer) return unauthorized(repoId);
  try { await oauth.verifyBearer(bearer, cfg.endpointFor(repoId)); }
  catch { return unauthorized(repoId); }
  if (!registeredIds(layout).has(repoId)) return c.json({ error: "not_found" }, 404);
  ```

- **构造 `OAuthConfig`（CRITICAL-2 + I-9 的落地处）**：

  ```typescript
  const oauthCfg: OAuthConfig = {
    issuer: cfg.issuer,
    endpointFor: (repoId) => `${cfg.issuer}/mcp/${repoId}`,
    isRegistered: (repoId) => registeredIds(layout).has(repoId),
    keyPath: join(layout.controlRoot, "secrets", "oauth-key"),
  };
  ```

  `expectedAudience` 必须是 `cfg.endpointFor(validatedRepoId)` —— **绝不能**是
  `c.req.url`（那样会让令牌验证的基准从"我们自己签的时候用了什么"变成"客户端
  这次请求恰好用了什么 URL"，两者本该恒等，但把它写成从请求里取，等于让攻击者
  部分控制了验证基准）。
- **`startGateway` 的对账时机（I-2）**：`reconcileRunningJobs()` 必须在
  `app.request`/`serve()` 开始监听**之前**同步跑完，且函数返回
  `{ app, close }`——`close` 负责优雅关停底层 HTTP server（`@hono/node-server`
  的 `serve()` 返回值带 `.close()`），供测试与未来的进程管理复用，避免测试
  进程遗留监听句柄。

- [ ] **Step 5: 承重性验证**

1. 把 `startGateway` 里 reconcile 挪到 listen **之后**，确认"在接受第一次工具调用
   之前已经完成对账"那条变红；还原。
2. 把 I-10 的鉴权顺序改回"先判 404 再判 401"，确认"未注册与已注册在未认证时
   响应完全一致"变红；还原。
3. 把 `expectedAudience` 从 `cfg.endpointFor(validatedRepoId)` 改成直接读
   `new URL(c.req.url).pathname` 推导，确认 D5 隔离测试仍然绿（这条故意验证
   "看起来等价的两种写法在正常路径下无区别，但把验证基准换成请求本身"这件事
   本身值得被记录，而不仅仅依赖 review 阅读代码发现）——**如果这一步测试
   仍然全绿**，说明现有测试集没有真正区分这两种实现，需要另外补一条直接
   针对"请求路径与 aud 编码不同但语义指向同一 repo"的用例（例如大小写、
   尾部斜杠）。**把这一步的实际观察写进报告，不要假设它一定变红。**

**把观察写进报告。**

- [ ] **Step 6: 提交 + 人工挂机实测**

```bash
git add src/tools.ts src/server.ts tests/tools.test.ts tests/server.test.ts package.json pnpm-lock.yaml
git commit -m "feat(s0-d): MCP 服务端骨架与六个只读工具"
```

**然后停下来交给 Human Owner**：起服务、走隧道、在 ChatGPT 里加一次连接器，
确认 OAuth 握手通过且六个只读工具可用（`grande_task_status`/`grande_diff`/
`grande_run_result` 此刻打不出真实数据，如实告知，见上方交接说明）。
**这一步不能自动化验证** —— U1 的 refresh_token 缺口正是 curl 全绿、静态检查
也发现不了的那类问题。

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