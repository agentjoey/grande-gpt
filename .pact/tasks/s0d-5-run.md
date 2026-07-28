# s0d-5-run

> S0-D 的第 5 个任务，从 `docs/superpowers/plans/2026-07-27-s0-d-mcp-oauth-endpoint.md` 切出。
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

### Task 5: `grande_run` / `grande_task_open` + NETWORK_DENIED 信号

**Files:** Modify `src/tools.ts`、`src/runner.ts`、`src/sbpl.ts`；Test 同名

**Interfaces 新增**：`function jobStateToError(r: JobReport): ToolError | null`
（`src/runner.ts`，I-1b）——补齐规格 §7.1 点名"声明了但没有任何模块抛出"的
`JOB_TIMEOUT`/`RESOURCE_EXHAUSTED` 两个码。这两个码的真实信号在 `jobReport` 的
`state`/`summary.killedBy` 里，**不经过 `toToolError`**：它们不是异常，是一次
job 结果的终态。

```typescript
// src/runner.ts —— 追加在 jobReport() 之后
import type { ToolError } from "./errors.ts";

/** jobReport 的终态 → 工具错误码。这一层不经过 toToolError：它不是异常，是 job 结果。 */
export function jobStateToError(r: JobReport): ToolError | null {
  if (r.state === "timeout") {
    return { code: "JOB_TIMEOUT", message: "作业超过 profile 的 timeoutSeconds。", retryable: false, details: { killedBy: r.killedBy } };
  }
  if (r.state === "killed" && r.killedBy === "rss") {
    return { code: "RESOURCE_EXHAUSTED", message: "作业 RSS 超限被终止。", retryable: false, details: { peakRssMb: r.peakRssMb } };
  }
  return null;   // killedBy: "output" 已被 S0-B/C 移除，故意不映射
}
```

`grande_run_result` 的处理器在拿到 `jobReport()` 之后调用 `jobStateToError()`，
非 `null` 时把它编成 `error{...}` 信封而不是 `data`。

测试（`tests/runner.test.ts` 新增一个 `describe`）：

```typescript
describe("jobStateToError()", () => {
  it("timeout 终态映射到 JOB_TIMEOUT", () => {
    const r = { ...BASE_REPORT, state: "timeout", killedBy: "timeout" } as JobReport;
    expect(jobStateToError(r)?.code).toBe("JOB_TIMEOUT");
  });

  it("killed + killedBy rss 映射到 RESOURCE_EXHAUSTED", () => {
    const r = { ...BASE_REPORT, state: "killed", killedBy: "rss", peakRssMb: 4200 } as JobReport;
    expect(jobStateToError(r)?.code).toBe("RESOURCE_EXHAUSTED");
  });

  it("passed/failed 终态不映射（不是异常）", () => {
    expect(jobStateToError({ ...BASE_REPORT, state: "passed", killedBy: null } as JobReport)).toBeNull();
    expect(jobStateToError({ ...BASE_REPORT, state: "failed", killedBy: null } as JobReport)).toBeNull();
  });

  it("running 终态不映射（还没到终态）", () => {
    expect(jobStateToError({ ...BASE_REPORT, state: "running", killedBy: null } as JobReport)).toBeNull();
  });
});
```

（`BASE_REPORT` 是一个覆盖 `JobReport` 全部字段的最小合法对象，测试文件顶部定义一次复用。）

- [ ] **Step 1: 写测试**

`grande_run`/`grande_run_result` 的 fixture 需要 `slow`/`curl-probe`/`fail` 三个
profile——**原计划这三个测试引用了从未定义的 profile，不可执行。** 需要在
`beforeEach` 里追加写入（与 `runner.test.ts` 既有 `beforeEach` 里的
`profiles.yaml` 写法同构，追加而非替换）：

```yaml
repos:
  demo:
    slow:       { argv: ["/bin/sh", "-c", "sleep 5"], timeoutSeconds: 30 }
    curl-probe: { argv: ["/usr/bin/curl", "-sS", "--max-time", "3", "http://example.com"], timeoutSeconds: 10 }
    fail:       { argv: ["/bin/sh", "-c", "echo boom >&2; exit 1"], timeoutSeconds: 30 }
```

（`curl` 位于 `/usr/bin`，已经在 `sandbox.ts` 的 `STANDARD_EXEC_ROOTS` 里，不需要
额外放行；`deny network*` 会让它连接失败。）

`settle()` 此前也是未定义引用；复用 `runner.ts` 已经导出的 `awaitJobSettled`
（专为测试/优雅关停设计，不需要重新发明轮询）：

```typescript
async function settle(jobId: string): Promise<void> {
  await awaitJobSettled(jobId);
}
```

```typescript
it("grande_run 立刻返回 jobId 与 pollAfterSeconds，不等命令跑完，且真的 spawn 了", async () => {
  // 原计划只断言响应形状——一个伪造 jobId、什么都不启动的 grande_run 同样能
  // 让这条测试通过。补一条对 job 表本身的断言，证明真的有一行 running 记录。
  const t0 = Date.now();
  const r = JSON.parse(await callTool("grande_run", { profile: "slow" }));
  expect(Date.now() - t0).toBeLessThan(1000);   // 规格 §5.4①
  expect(r.data.jobId).toMatch(/^job_/);
  expect(r.data.pollAfterSeconds).toBeGreaterThan(0);
  expect(r.hint).toContain("grande_run_result");  // 明确告诉模型下一步
  const row = getJob(db, r.data.jobId);
  expect(row).toBeDefined();
  expect(row!.state).toBe("running");
  await settle(r.data.jobId); // 避免这条测试留下一个仍在跑的子进程
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

`grande_task_open` 的实现只需要 `openWorktree`（S0-C 已交付，见 `src/worktree.ts`）
与 `createTask`（S0-A 已交付），**不需要 `AuditHandle`**——规格 §7.0① 点名的
"本切片仅有的两个变更操作"是 `repoEdit` 与 `startJob`，开 worktree/建分支不在
这个硬要求范围内（它本身没有 Policy 决策要记录：不存在"允许/拒绝开一个新任务"
这个语义，只有"能不能成功"）。

承重性验证：把 `jobStateToError` 里 `killedBy === "output"` 的（不存在的）分支
误加回去（即让某个旧摘要字段重新映射到 `RESOURCE_EXHAUSTED`），确认「普通的
测试失败不被误判」那条测试变红；还原。**把观察写进报告。**

```bash
git add src/tools.ts src/runner.ts src/sbpl.ts tests/tools.test.ts tests/runner.test.ts
git commit -m "feat(s0-d): grande_run/grande_task_open + NETWORK_DENIED 启发式信号"
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