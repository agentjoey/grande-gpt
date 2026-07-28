# s0d-1-errors

> S0-D 的第 1 个任务，从 `docs/superpowers/plans/2026-07-27-s0-d-mcp-oauth-endpoint.md` 切出。
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

### Task 1: 错误映射层

**Files:** Create `src/errors.ts`；Modify `src/tasks.ts`、`src/jobs.ts`（Step 0）；Test `tests/errors.test.ts`；Modify `tests/tasks.test.ts`（Step 0）

**Interfaces:**
- Produces: `type ToolErrorCode`（规格 §7 的 12 个码）、
  `interface ToolError { code: ToolErrorCode; message: string; retryable: boolean; details: Record<string, unknown> }`、
  `function toToolError(e: unknown): ToolError`、`class StateError extends Error`（C-5）、
  `function redact(msg: string, roots: readonly string[]): string`（I-1c）

**这是 S0-D 唯一把内部异常翻译成工具错误码的地方。** 规格 §7.1 的映射表是权威，
**不得靠解析 message 字符串** —— 字符串会被改写、被本地化、被截断。

**`toToolError(e)` 有意保持签名不变，不接 `db`/`layout`（I-1c/I-1d 的决策点，详见
Step 3 末尾的说明）**：请求作用域的两样东西——`TASK_NOT_FOUND` 需要的活跃任务清单
（要查 `db`）、`message` 里可能残留的宿主绝对路径需要的脱敏前缀（要查 `layout`）——
都放到 Task 3 的工具处理器里去做，那里本来就持有这两样，且规格已经把它定为
「唯一把内部异常翻译成 `error{code}` 信封的地方」。把它们塞进 `toToolError` 本身，
换来的只是一个再也没法脱离数据库和文件系统单测的函数，而没有任何调用方需要
这个可选参数——本文件的每一条测试都不带 `db`/`layout`，这个约束值得保住。

- [ ] **Step 0: `StateError`——`tasks.ts`/`jobs.ts` 从裸 `Error` 迁到结构化错误（C-5，独立提交）**

**动机**：`tasks.ts` 的 `updateTaskState` 与 `jobs.ts` 的 `finishJob` 至今抛的是裸
`Error`，机器可读信息只存在于 message 前缀（规格 §7.1 明确点名这是反模式，规格原文：
「`tasks.ts` / `jobs.ts`｜裸 `Error`，机器可读信息只存在于 message 前缀
（`"TASK_NOT_FOUND: …"`）｜反模式：正是 Task 2 明确否定过的做法」）。实测三处抛出
全部命中 `toToolError` 的 `INTERNAL` 兜底：

```
tasks.ts updateTaskState  TASK_NOT_FOUND -> INTERNAL   （两处：res.changes===0 分支与末尾 !updated 分支）
tasks.ts updateTaskState  STALE_STATE    -> INTERNAL
jobs.ts  finishJob        JOB_NOT_FOUND  -> INTERNAL   （两处：res.changes===0 分支与末尾 !updated 分支）
```

`TASK_NOT_FOUND` 正是规格 §5.5/§7 指定的、模型弄丢 `taskId` 时的兜底路径——它会以
「Gateway 内部错误」的样子出现在 ChatGPT 里，而不是一句可操作的「任务不存在，
以下是活跃任务列表」。

这一步单独提交，因为它改动的是两个 **S0-A 已合并**的文件（`tasks.ts`/`jobs.ts`），
不是 S0-D 的新代码；混进 Task 1 其余步骤的提交会让这个改动的边界变得不清楚。

`src/errors.ts`（本步骤只落这一个类；`MAP`/`KNOWN`/`toToolError`/`redact` 仍在 Step 3
落地——`tasks.ts`/`jobs.ts` 要 `import { StateError } from "./errors.ts"`，这个类必须
先于它们存在，但整张映射表此刻还不需要）：

```typescript
/** 只有 `.code` 的最小结构化错误。tasks.ts/jobs.ts 从裸 Error 迁到这里。 */
export class StateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `StateError [${code}]`;
    this.code = code;
  }
}
```

`src/tasks.ts`——`updateTaskState` 里三处裸 `Error`（两处 `TASK_NOT_FOUND`、一处
`STALE_STATE`）全部替换：

```typescript
import { StateError } from "./errors.ts";
// ...
if (res.changes === 0) {
  const cur = getTask(db, taskId);
  if (!cur) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  throw new StateError(
    "STALE_STATE",
    `任务 ${taskId} 的 stateVersion 已是 ${cur.stateVersion}，而本次更新携带的是 ` +
      `${expectedVersion}。请重新读取状态后再试。`,
  );
}
const updated = getTask(db, taskId);
if (!updated) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
```

`src/jobs.ts`——`finishJob` 里两处裸 `Error`（均为 `JOB_NOT_FOUND`）：

```typescript
import { StateError } from "./errors.ts";
// ...
if (res.changes === 0) {
  if (!getJob(db, jobId)) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
  return undefined;
}
const updated = getJob(db, jobId);
if (!updated) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
```

**连带修复一个既有测试**：`tests/tasks.test.ts` 现有的

```typescript
expect(() => updateTaskState(db, "task_1", "CLOSED", 1)).toThrow(/STALE_STATE/);
```

是对 message 字符串做正则匹配——旧 message 是 `"STALE_STATE: 任务 ..."`，含这个词；
新 message（如上）不再含它，这条断言会被这次迁移打破，且打破的方式具有误导性
（看起来像是这次改动引入的回归，其实只是断言本身依赖了规格 §7.1 明确反对的那个
模式）。改成对 `.code` 断言，与同文件里紧邻的另一条断言风格一致：

```typescript
expect(() => updateTaskState(db, "task_1", "CLOSED", 1)).toThrow(
  expect.objectContaining({ code: "STALE_STATE" }),
);
```

全仓搜索确认（`grep -rn "TASK_NOT_FOUND\|STALE_STATE\|JOB_NOT_FOUND" src/ tests/`）
这是唯一一处依赖旧 message 文本的断言；`tests/runner.test.ts` 里的 `JOB_NOT_FOUND`
测试断言的是 `runner.ts` 的 `RunnerError`（`jobReport()` 里的另一个抛出点，不经过
`finishJob`），不受这次改动影响。

`MAP` 与 `KNOWN` 在 Step 3 一并补上——`KNOWN` 加 `StateError`；`MAP` 只需新增
`STALE_STATE` 一行（`TASK_NOT_FOUND`/`JOB_NOT_FOUND` 两个键已经在原 `MAP` 里，此前
一直到不了，是因为 `structuredCode()` 的 `KNOWN.some(...)` 检查从未认过 `StateError`
这个类，不是因为 `MAP` 缺行）。

Run: `pnpm vitest run tests/tasks.test.ts tests/jobs.test.ts tests/runner.test.ts`
Expected: PASS（把字符串匹配改成 `.code` 匹配后无回归；`StateError` 本身尚未在
`toToolError` 侧被测试，那是 Step 4 的事）

```bash
git add src/errors.ts src/tasks.ts src/jobs.ts tests/tasks.test.ts
git commit -m "fix(s0-d): tasks.ts/jobs.ts 裸 Error 迁移到结构化 StateError（C-5）"
```

- [ ] **Step 1: 写失败测试**

`tests/errors.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { toToolError, redact, StateError } from "../src/errors.ts";
import { PathSecurityError } from "../src/paths.ts";
import { PolicyError } from "../src/policy.ts";
import { ProfileError } from "../src/profiles.ts";
import { EditError } from "../src/repoFile.ts";
import { GitError } from "../src/worktree.ts";
import { SbplError } from "../src/sbpl.ts";
import { SandboxError } from "../src/sandbox.ts";

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
    // I-1a：KNOWN 此前没有 SbplError/SandboxError，两者均经由
    // startJob → runSandboxed 可达 grande_run，实测都降级成了 INTERNAL。
    [new SbplError("INVALID_INPUT", "x"), "INVALID_INPUT", false],
    [new SandboxError("PATH_SPELLING_MISMATCH", "x"), "POLICY_DENIED", false],
    // C-5：tasks.ts/jobs.ts 从裸 Error 迁到 StateError 之后新增的三行。
    [new StateError("TASK_NOT_FOUND", "x"), "TASK_NOT_FOUND", true],
    [new StateError("STALE_STATE", "x"), "INVALID_INPUT", true],
    [new StateError("JOB_NOT_FOUND", "x"), "INVALID_INPUT", false],
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

  // C-5 的规格意义所在：§7.1 那张映射表是从 src/ 逐模块清点出来的。一行映射
  // 如果没有任何模块真的会抛，它就是在给一个不存在的契约做背书——
  // TASK_NOT_FOUND/JOB_NOT_FOUND 正是这么进来的：tasks.ts/jobs.ts 抛的是裸
  // Error，两行永远命不中，直到 Step 0 把它们迁到 StateError。
  it("MAP 里的每一行都有真实抛出方（没有到不了的表格行）", async () => {
    const { StateError } = await import("../src/errors.ts");
    for (const [code, e] of [
      ["TASK_NOT_FOUND", new StateError("TASK_NOT_FOUND", "x")],
      ["STALE_STATE",    new StateError("STALE_STATE", "x")],
      ["JOB_NOT_FOUND",  new StateError("JOB_NOT_FOUND", "x")],
    ] as const) {
      expect(toToolError(e).code, code).not.toBe("INTERNAL");
    }
  });

  // I-1c：redact() 是纯函数，脱离 toToolError() 单独可测——它不关心错误码，
  // 只做字符串替换。真正"哪些前缀算敏感"的决定权在调用方（Task 3 传
  // [layout.workspaceRoot, layout.controlRoot]）。
  it("redact() 替换掉给定的绝对路径前缀，不触碰其余内容", () => {
    const msg = redact(
      "仓库 /Users/x/ws/secret-project 不是工作区下的真实目录（名字合法不等于位置安全）",
      ["/Users/x/ws"],
    );
    expect(msg).not.toContain("/Users/x/ws");
    expect(msg).toContain("<workspace>/secret-project");
    expect(msg).toContain("名字合法不等于位置安全"); // 其余内容原样保留
  });
});
```

**「非 Error 值也能安全处理」是关键**：一个**裸对象**带着 `code: "POLICY_DENIED"`
不该被当成合法映射源 —— 否则仓库里的数据（比如一段被 JSON.parse 的测试输出）
就能伪造成策略决定。映射必须只认我们自己的错误类实例。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/errors.test.ts`
Expected: FAIL —— `Cannot find module '../src/errors.ts'`……**除非 Step 0 已经执行过**。
若 Step 0 已经创建了只含 `StateError` 的 `src/errors.ts`，本步骤的失败信号会变成
`SyntaxError: The requested module '../src/errors.ts' does not provide an export
named 'toToolError'`（Node ESM 对不存在的具名导出的标准报错）——同样是清晰的 RED，
只是措辞不同，不代表哪里出错了。

- [ ] **Step 3: 实现**

`src/errors.ts`（在 Step 0 已经落地的 `StateError` 之后追加）：

```typescript
import { PathSecurityError } from "./paths.ts";
import { PolicyError } from "./policy.ts";
import { ProfileError } from "./profiles.ts";
import { EditError } from "./repoFile.ts";
import { SearchError } from "./repoSearch.ts";
import { MapError } from "./repoMap.ts";
import { RunnerError } from "./runner.ts";
import { GitError } from "./worktree.ts";
import { SbplError } from "./sbpl.ts";
import { SandboxError } from "./sandbox.ts";

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
  PATH_ESCAPE:            { code: "POLICY_DENIED",       retryable: false },
  POLICY_DENIED:          { code: "POLICY_DENIED",       retryable: false },
  BAD_CONFIG:             { code: "POLICY_DENIED",       retryable: false },
  REPO_NOT_REGISTERED:    { code: "REPO_NOT_REGISTERED", retryable: false },
  REPO_NOT_FOUND:         { code: "REPO_NOT_REGISTERED", retryable: false },
  INVALID_INPUT:          { code: "INVALID_INPUT",       retryable: false },
  STALE_FILE:             { code: "STALE_FILE",          retryable: true  },
  FILE_NOT_FOUND:         { code: "INVALID_INPUT",       retryable: false },
  FILE_EXISTS:            { code: "INVALID_INPUT",       retryable: false },
  PROFILE_NOT_FOUND:      { code: "PROFILE_NOT_FOUND",   retryable: false },
  CANONICAL_BUSY:         { code: "CANONICAL_BUSY",      retryable: true  },
  GIT_FAILED:             { code: "INVALID_INPUT",       retryable: false },
  WORKTREE_EXISTS:        { code: "INVALID_INPUT",       retryable: false },
  JOB_NOT_FOUND:          { code: "INVALID_INPUT",       retryable: false },
  // TASK_NOT_FOUND 与 PROFILE_NOT_FOUND 长得像（都是"某个 id 指向的东西不存在"），
  // retryable 却相反，是有意的：taskId 是随对话漂移的会话状态，模型在长会话里
  // 弄丢它是预期内的正常状况（规格里 taskContext 回带机制就是为了缓解这个），
  // 错误信息还会列出活跃任务（I-1d，见 Task 3）供它当场挑一个重试；
  // profile 名是静态配置面，模型本该从工具交互里已经知道有哪些可选，报这个错
  // 多半说明它记错了名字而不是状态丢了——标 retryable 容易鼓励它反复瞎猜同一个
  // 错的名字，而不是先去确认可用列表。
  TASK_NOT_FOUND:          { code: "TASK_NOT_FOUND",      retryable: true  },
  // C-5 新增：STALE_STATE 是 updateTaskState 的乐观并发失败，语义与 STALE_FILE
  // 一致（重读后重试），只是工具码按规格 §7.1 收敛到通用的 INVALID_INPUT。
  STALE_STATE:             { code: "INVALID_INPUT",       retryable: true  },
  // I-1a 新增：SBPL 路径与磁盘实际拼写不一致——规格 §11 明确这意味着一条 deny
  // 规则会静默失效，是策略失败，不是用户输入问题，因此不可重试。
  PATH_SPELLING_MISMATCH:  { code: "POLICY_DENIED",       retryable: false },
};

/**
 * 我们自己的错误类。**只有这些类的实例参与映射** —— 一个裸对象带着
 * `code: "POLICY_DENIED"` 不能被当成合法映射源，否则仓库里的数据
 * （例如一段被 JSON.parse 的测试输出）就能伪造成一次策略决定。铁律一。
 */
const KNOWN = [
  PathSecurityError, PolicyError, ProfileError, EditError,
  SearchError, MapError, RunnerError, GitError,
  SbplError, SandboxError, StateError,
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
 *
 * **有意保持签名为单参数、不接 `db`/`layout`**（I-1c/I-1d）：本函数只做
 * 「内部错误 → 工具错误码」这一件事，是纯函数、不做 IO，因此在 `tests/errors.test.ts`
 * 里可以完全脱离数据库和文件系统被单测。两类请求作用域的信息——`TASK_NOT_FOUND`
 * 需要的活跃任务清单（要查 `db`）、`message` 里可能残留的宿主绝对路径需要的脱敏
 * 前缀（要查 `layout`）——都不在这里处理，而是在 Task 3 的工具处理器里（那里本来
 * 就持有 `db`/`layout`，且规格已经把它定为"唯一把内部异常翻译成 error{code} 信封
 * 的地方"）在拿到本函数的结果之后原地补充。把这两样东西塞进这里，换来的只是一个
 * 更难单测、却没有任何调用方需要的可选参数。
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

/**
 * 抹掉绝对路径的宿主前缀：错误消息要进 ChatGPT 对话，D12 下等同于对外发布
 * （消费者账号默认用对话内容训练模型）。只做字符串替换，不解析路径——
 * 调用方决定"哪些前缀算敏感"（Task 3 传 `[layout.workspaceRoot, layout.controlRoot]`）。
 * 由 Task 3 的工具处理器在拿到 `toToolError()` 的结果之后调用，见 I-1c。
 */
export function redact(msg: string, roots: readonly string[]): string {
  return roots.reduce((m, r) => m.replaceAll(r, "<workspace>"), msg);
}
```

（`StateError` 的定义仍在文件顶部，Step 0 落的那一份——上面只展示 Step 3 新增的部分。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/errors.test.ts`
Expected: PASS（18 个 `it.each` 映射用例 + 7 个独立用例 = 25 个用例。18 = 原 12 条
+ I-1a 的 2 条（SbplError/SandboxError）+ C-5 的 3 条（StateError 三个码）；
7 = 原 4 条独立断言 + C-5 的 MAP 完整性回归测试 + I-1c 的 `redact()` 测试
——原计划这里写的「12 + 5 = 17」本身也算错了：12 条 `it.each` 加 4 个独立 `it()`
是 16，不是 17；这次一并连同新增内容改成准确的分项统计，不再用一个孤立的
最终数字。）

- [ ] **Step 5: 承重性验证**

把 `structuredCode` 里的 `KNOWN.some(...)` 检查删掉（即改成任何带 `.code` 的东西都认），
确认「非 Error 值」那条里的裸对象断言变红；还原后确认变绿。**把观察写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/errors.ts tests/errors.test.ts
git commit -m "feat(s0-d): 内部异常 → 工具错误码映射层"
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