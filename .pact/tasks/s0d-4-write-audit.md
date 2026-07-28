# s0d-4-write-audit

> S0-D 的第 4 个任务，从 `docs/superpowers/plans/2026-07-27-s0-d-mcp-oauth-endpoint.md` 切出。
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

### Task 4: 写工具 + 审计结构性接入

**Files:** Modify `src/tools.ts`、`src/repoFile.ts`、`src/runner.ts`；Test `tests/repoFile.test.ts`、`tests/runner.test.ts`、`tests/tools.test.ts`

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

// src/runner.ts —— 同样的变更
export function startJob(
  deps: RunnerDeps,
  a: { taskId: string; repoId: string; worktreePath: string; profileName: string },
  audit: AuditHandle,   // ← 新增，非可选
): StartedJob;
```

**I-3b：这个签名变更会破坏 `tests/repoFile.test.ts` 里全部 19 个 `repoEdit(` 调用点
与 `tests/runner.test.ts` 里全部 5 个 `startJob(` 调用点**（两个数字已在真实文件里
用 `grep -c` 核对）。这些文件目前都不持有 `DatabaseSync`（`repoFile.test.ts` 甚至
完全不 import `db.ts`）。新增共享 fixture：

```typescript
// tests/_audit.ts —— 24 个现有调用点都需要一个已放行的句柄
import type { DatabaseSync } from "node:sqlite";
import { beginAudit, type AuditHandle } from "../src/audit.ts";

export function allowedHandle(db: DatabaseSync, tool: string): AuditHandle {
  const h = beginAudit(db, { taskId: null, tool, input: {} });
  h.allowed();     // executing() 的 CAS 谓词要求 decision='ALLOWED'（audit.ts）
  return h;
}
```

`tests/repoFile.test.ts` 的 `beforeEach` 需要新增（此前完全没有 DB）：

```typescript
import { openDb } from "../src/db.ts";
import type { Layout } from "../src/layout.ts";
import { allowedHandle } from "./_audit.ts";

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rf-"));
  db = openDb({ stateDb: ":memory:" } as Layout); // node:sqlite 原生支持 :memory:
});
```

**机械变换规则**：把每个既有调用点尾部的 `RULES)` 改成
`RULES, allowedHandle(db, "grande_repo_edit"))`（`runner.test.ts` 里对应
`startJob(...)` 的调用点用 `allowedHandle(db, "grande_run")`），**每个调用点内联
生成一个全新的句柄，不要提到外层共享一个 `handle` 变量**——一个句柄只支持一次
完整的 INTENT → EXECUTING → 终态生命周期（`executing()`/`succeeded()` 的 CAS
谓词一旦被推进就无法回退，见 `audit.ts`），而 `repoFile.test.ts`/`runner.test.ts`
里有不止一个测试在同一个 `it()` 内连续调用 `repoEdit`/`startJob` 两次以上
（例如先 create 再 modify），共享同一个句柄会让第二次调用因为 CAS 落空而抛出
`POLICY_DENIED`，报出一个看起来像回归、实际是 fixture 用法错误的失败。实现者
执行本步骤时应先跑一遍 `grep -B2 "repoEdit(" tests/repoFile.test.ts`（及
`startJob(` 于 runner.test.ts）确认每个调用点各自的句柄。

测试必须覆盖（`RULES`/`handle`/`db`/`root` 等既有变量沿用同文件的 fixture 命名）：

```typescript
it("repoEdit 在写盘【之前】把句柄推进到 EXECUTING", () => {
  // INTENT 先行的意义在于：崩在中途也留下可发现的未完成记录。
  // 断言必须在 executing() 被调用的【那一刻】检查磁盘——只记录「调用过」的话，
  // 「先写盘、后推进」的实现同样全绿，而那正是这条测试要挡的形状（I-4）。
  const target = join(root, "a.ts");
  const handle = allowedHandle(db, "grande_repo_edit");
  let fileExistedAtAdvance: boolean | null = null;
  const spy: AuditHandle = { ...handle, executing: () => {
    fileExistedAtAdvance = existsSync(target);
    return handle.executing();
  } };
  repoEdit(root, [{ op: "create", path: "a.ts", content: "x" }], RULES, spy);
  expect(fileExistedAtAdvance).toBe(false);
  expect(existsSync(target)).toBe(true);
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

it("失败时句柄落到 FAILED 且带 reason", () => {
  // 阶段一（校验）会通过——create 到一个尚不存在、但父目录已存在的路径完全
  // 合法；用 chmod 把父目录改成只读，让阶段二的 writeFileSync 在磁盘层面
  // 真实失败，而不是伪造一个 mock——这是本条要证明的行为本身就发生在
  // 「校验之后、落盘失败时」。
  mkdirSync(join(root, "locked"), { recursive: true });
  chmodSync(join(root, "locked"), 0o500); // r-x：目录可进入不可写
  const h = allowedHandle(db, "grande_repo_edit");
  try {
    expect(() =>
      repoEdit(root, [{ op: "create", path: "locked/a.ts", content: "x" }], RULES, h),
    ).toThrow();
  } finally {
    chmodSync(join(root, "locked"), 0o700); // afterEach 的 rmSync 需要能删掉它
  }
  const row = getAudit(db, h.opId)!;
  expect(row.state).toBe("FAILED");
  expect(row.reason).toBeTruthy();
});

it("repoEdit 的形参数量仍是 4（tsc 才是真正拦住漏传 audit 的那道关卡）", () => {
  // tsc（pnpm typecheck）负责拦住"少传 audit 编译不过"；这里的 .length 断言
  // 只是一个廉价的运行时冒烟信号，能抓住"audit 参数被整个删掉或不小心给了
  // 默认值"这类回归，但【不能】区分 `audit: AuditHandle`（必填）与
  // `audit?: AuditHandle`（可选，仍然编译通过）——两种写法下 repoEdit.length
  // 都是 4。不要把这条断言本身读成"证明了不能编译"。
  expect(repoEdit.length).toBe(4);
});
```

**I-3：`startJob` 此前零测试，而 `repoEdit` 有四个——同一种"兄弟没同步修"的
模式第三次出现（`docs/superpowers/plans` 历史上已经在 S0-B/S0-C 各出现过一次）。
镜像上面全部四条，落在 `tests/runner.test.ts`**（复用文件既有的 `layout`/`db`/`wt`
fixture）：

```typescript
it("startJob 在 spawn【之前】把句柄推进到 EXECUTING", async () => {
  // 镜像 repoEdit 的同名测试：用一个跑起来会创建标记文件的 profile 当探针——
  // 如果 executing() 真的先于 spawn，标记文件在那一刻应该还不存在。
  const marker = join(wt, "marker");
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    `repos:\n  demo:\n    touch: { argv: ["/usr/bin/touch", "${marker}"], timeoutSeconds: 10 }\n`,
    "utf8",
  );
  const h = allowedHandle(db, "grande_run");
  let markerExistedAtAdvance: boolean | null = null;
  const spy: AuditHandle = { ...h, executing: () => {
    markerExistedAtAdvance = existsSync(marker);
    return h.executing();
  } };
  const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "touch" }, spy);
  started.push(s.jobId);
  await awaitJobSettled(s.jobId);
  expect(markerExistedAtAdvance).toBe(false);
  expect(existsSync(marker)).toBe(true);
  expect(getAudit(db, h.opId)!.state).toBe("SUCCEEDED");
});

it("句柄推进失败时【不 spawn】", () => {
  const h = beginAudit(db, { taskId: null, tool: "grande_run", input: {} });
  // 故意不调用 allowed()
  expect(() =>
    startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "ok" }, h),
  ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  expect(listJobs(db, "task_abcd")).toHaveLength(0);
});

it("失败时句柄落到 FAILED 且带 reason", () => {
  // 让阶段一校验本身失败（profile 不存在）——句柄此刻应该终结为 FAILED，
  // 不能停在 INTENT（listUnfinishedAudit 会把它当成崩溃残留）。
  const h = allowedHandle(db, "grande_run");
  expect(() =>
    startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "does-not-exist" }, h),
  ).toThrow();
  const row = getAudit(db, h.opId)!;
  expect(row.state).toBe("FAILED");
  expect(row.reason).toBeTruthy();
});

it("startJob 的形参数量仍是 3（tsc 才是真正拦住漏传 audit 的那道关卡）", () => {
  expect(startJob.length).toBe(3);
});
```

- [ ] **Step 2–4: RED → 实现 → GREEN**

`startJob` 同样加 `audit: AuditHandle`，并在 spawn 之前 `executing()`；成功 spawn
且 `createJob()` 落库后立即 `succeeded()`——它标记的是"这次 EXECUTING 动作（spawn
一个进程组并把它记录下来）本身有没有成功"，不是"命令最终 exit 0 还是非 0"：后者
是 `job.state` 的职责，两者是不同的账本，不要混着用同一个信号。

**任何失败路径（阶段一校验失败、阶段二写盘/spawn 失败）都必须在重新抛出异常
之前调用 `audit.failed(reason)`**——`failed()` 的 CAS 谓词是 `state NOT IN
('SUCCEEDED','FAILED')`，INTENT 与 EXECUTING 都覆盖，可以安全地在一个包住整个
函数体的 `try { … } catch (e) { audit.failed(String(e instanceof Error ? e.message
: e)); throw e; }` 里统一调用，不需要在每个校验分支各写一次。

工具处理器负责创建句柄：`beginAudit` → `allowed()`（Policy 通过后）→ 传进去。

**I-8：写工具必须用控制平面的拒绝表，不是空表**——`ToolDeps` 目前只有
`{ db, layout, repoId }`，没有 `DenyRules`；`policy.ts` 的 JSDoc 明确警告
`repoEdit(root, ops, {prefixes: []})` 一行就能关掉 AC-14。`grande_repo_edit`
的处理器必须调用 `loadDenyRules(layout)` 取真实拒绝表，不能自己构造一个空的
或部分的。追加到 `tests/tools.test.ts`：

```typescript
it("写工具用的是控制平面里的拒绝表，不是空表（AC-14 第二条断言）", async () => {
  const r = JSON.parse(await callTool("grande_repo_edit", {
    ops: [{ op: "create", path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" }],
  }));
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe("POLICY_DENIED");
  expect(existsSync(join(canonical, ".git/hooks/pre-commit"))).toBe(false);
});
```

- [ ] **Step 5: 承重性验证**

1. 把 `repoEdit` 里的 `executing()` 返回值检查去掉，确认「推进失败时不写盘」变红；还原。
2. 把 `startJob` 里的 `executing()` 返回值检查去掉，确认「推进失败时不 spawn」变红；还原（I-3）。

- [ ] **Step 6: 提交**

```bash
git add src/tools.ts src/repoFile.ts src/runner.ts tests/_audit.ts tests/repoFile.test.ts tests/runner.test.ts tests/tools.test.ts
git commit -m "feat(s0-d): 写工具接入结构性审计（AuditHandle 必填，规格 §7.0①）"
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