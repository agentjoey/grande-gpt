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

### Task 2: OAuth 授权服务器（含 refresh_token）

---

> ## ⛔⛔⛔ BLOCKING —— 本任务在 `/authorize` 的认证方案定稿之前不得开始实现 ⛔⛔⛔
>
> spike 的 `/authorize` 注释写着「spike 直接同意，不做登录页」，本计划原样继承了那个
> 刻意的捷径：任何能访问该端点的人自带一个 PKCE verifier 就能换到合法令牌，
> 而该令牌可以驱动 `grande_repo_edit` 与 `grande_run` 在本机写文件、执行命令。
> **PKCE 挡不住这条 —— 攻击者自己就是发起流程的那一方。**
>
> 方案定为 Cloudflare Access 挂在 `/authorize*`（其余路径不挂，否则 OpenAI 后端
> 过不去），并由 `/authorize` 校验 `Cf-Access-Jwt-Assertion`。待实测确认后补写。
>
> **这套 Access 方案本身尚未定稿**——待验证 ChatGPT 的 authorize 重定向能否穿过
> Access 的拦截页，尤其是 iOS 内嵌 webview 那条路径。在这条验证完成、结论写回
> 本计划之前，下面 Task 2 的 Step 1–6 **不得开始执行**。
>
> 下面的测试与实现步骤修的是本任务范围内另一类、正交的问题——CRITICAL-2/3/4 与
> I-9/I-11 处理的是「令牌一旦被签发，是否精确绑定 repo、防重放、防跨端点提权、
> 密钥管理是否安全」，**不处理「谁能触发签发」**。即使这些修复全部落地、测试全绿，
> `/authorize` 本身依然对公网任何人开放——本阻断说明所指的洞不会被下面任何一条
> 测试变绿而消失，必须等 Cloudflare Access 方案定稿、单独补一个任务（或在
> `/authorize` 内部加 JWT 校验，具体形态视实测结论而定）后才能解除。

---

**Files:** Create `src/oauth.ts`；Test `tests/oauth.test.ts`

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
pnpm add hono @hono/node-server @modelcontextprotocol/sdk@1.29.0 zod
```

（版本与 Tech Stack 声明的 `@modelcontextprotocol/sdk@1.29.0` 保持一致。）

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
| `/authorize` 的用户认证（Cloudflare Access） | 见 Task 2 顶部的阻断说明；方案定稿并实测通过后单开任务 |
