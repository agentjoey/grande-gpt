# s0c-5-runner

> 本文件是 **S0C 切片**的第 5 个任务，从
> `docs/superpowers/plans/2026-07-27-s0-c-worktree-sandbox-runner.md` 切出。计划本身已通过一轮对抗性代码审查（发现并修掉了
> 可复现的安全绕过与跑不起来的测试），**请逐字使用其中给出的代码与测试，不要自行改写**。

---

# S0-C worktree 与 Seatbelt runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每任务一个 git worktree，在 Seatbelt 沙箱里跑注册好的命令，异步返回 `jobId`，
结果落 artifact 并生成摘要。外加 `grande_diff`。

**Architecture:** 五层，自下而上：profile 注册表 → SBPL 生成 → 沙箱执行 → worktree 生命周期
→ job 编排。**不碰 MCP**（S0-D 才接工具）、**不碰仓库文件读写**（S0-B 的事）。

**Tech Stack:** TypeScript（Node 24 原生剥离类型）、`sandbox-exec`（macOS Seatbelt）、
`git worktree`、`node:child_process`、`yaml`、vitest。

## Global Constraints

取自规格 `docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`，**每个任务隐含包含本节**。

- **本切片不碰 MCP、不碰仓库文件读写。** 工具注册与错误码映射属 S0-D；
  `repoMap`/`repoSearch`/`repoRead`/`repoEdit` 属 S0-B，**不要实现也不要 import**
  （它们此刻可能还不存在，两个切片并行开发）。
- **不做错误码映射。** 规格 §7.1：映射在 S0-D。本切片**只抛带结构化 `.code` 的异常**，
  照抄 `PathSecurityError` 的形状（`.code` 存码、`name` 为 `XxxError [CODE]`、
  message 不含码前缀）。
  **本切片实际会抛出的码**（MINOR 修复：S0-D 的映射表必须照这份清单核对，而不是
  照旧版——旧版列的 `JOB_TIMEOUT`/`RESOURCE_EXHAUSTED`/`NETWORK_DENIED`/
  `WORKTREE_DIRTY` 四个码在本切片代码里从未被 `throw` 过）：
  - `ProfileError`（Task 1）：`BAD_CONFIG`、`PROFILE_NOT_FOUND`
  - `GitError`（Task 4）：`GIT_FAILED`、`CANONICAL_BUSY`、`WORKTREE_EXISTS`、`INVALID_INPUT`
  - `RunnerError`（Task 5）：`JOB_NOT_FOUND`、`POLICY_DENIED`
  - 经 Task 4 透传的 S0-A `PathSecurityError`：`REPO_NOT_REGISTERED`、
    `REPO_NOT_FOUND`、`PATH_ESCAPE`、`INVALID_INPUT`（与 `GitError` 的
    `INVALID_INPUT` 同码不同类，S0-D 按 `.code` 字符串映射即可，不必区分来源类）

  **执行结果不是异常，但 S0-D 同样需要映射**——映射的输入是 `JobRow.state` /
  `RunResult.killedBy`，不是某个 `.code`：`state: "timeout"` ← 墙钟超时；
  `state: "killed"` + `summary.killedBy: "rss"|"output"` ← 资源耗尽兜底；
  网络拒绝没有独立信号——Seatbelt 在子进程内部拒绝网络系统调用，子进程自己按
  非零退出码收场，orchestrator 侧看到的只是 `state: "failed"`。`WORKTREE_DIRTY`
  从清单中移除：S0 从不 commit（D8），worktree 天然总是「dirty」，`removeWorktree`
  一律 `--force` 移除，本切片没有场景需要因为「脏」而拒绝一个操作。
- **`grande_run` 是唯一异步的工具**，必须 **< 1s 返回 `jobId`**（规格 §5.4①）。
  ChatGPT 的 ~60s 工具超时不可配置，同步等待跑测试必然撞墙。
- **`task_open` 不做 `git fetch`**（规格 §5.4①）。大仓库上 fetch 可能几十秒直接撑爆超时。
  S0 无 GitHub，直接用本地当前 ref 作 base。
- **S0 全禁网**：SBPL 里 `deny network*`，无例外。
- **进 SBPL 的路径一律取磁盘实际拼写**（规格 §11，S0-A 审查发现）：macOS 文件系统
  大小写与 Unicode 归一化不敏感，但 `realpathSync` **不改写调用方给的拼写**。
  Seatbelt 按字节精确匹配策略路径 —— 拼写不一致会让 allow 规则过严、
  **deny 规则静默失效**（fail-open）。所有路径必须 `realpathSync` 后再进 profile 文本。
- 严格 TS：`strict: true`、`noUncheckedIndexedAccess: true`。
- 环境变量：`GRANDE_WORKSPACE`（无默认值）、`GRANDE_CONTROL`（默认 `~/.grande-control`）。

## 三条铁律（来自 CLAUDE.md）

1. **仓库内容不可信。** profile 只从 `~/.grande-control/config/profiles.yaml` 读，
   **绝不从仓库内读**（否则仓库里放一个 `profiles.yaml` 就能让任意命令被执行）。
2. **没有通用逃生舱。** 不提供 `shell_exec`。**argv 永远是数组，绝不拼 shell 字符串。**
3. **能做成硬约束的绝不做成软约束。**

## 已有的可消费接口（S0-A，勿重复实现）

```typescript
// src/layout.ts
export interface Layout {
  workspaceRoot: string; controlRoot: string; stateDb: string;
  configDir: string; reposConfig: string; artifactsDir: string;
  derivedRoot: string; worktreesRoot: string;
}
export function loadLayout(): Layout;
export function ensureLayout(l: Layout): void;

// src/paths.ts
export class PathSecurityError extends Error { readonly code: string }
export function resolveRepoPath(layout: Layout, repoId: string, registered: ReadonlySet<string>): string;
export function assertValidId(id: string, label: string): void;

// src/registry.ts
export function registeredIds(layout: Layout): Set<string>;

// src/db.ts
export function openDb(layout: Layout): DatabaseSync;

// src/tasks.ts
export type TaskState = "CREATING" | "READY" | "RUNNING" | "CLOSED";
export interface TaskRow { taskId; repoId; branch; baseCommit; worktreePath; state; createdAt; updatedAt; stateVersion }
export function createTask(db, t: Omit<TaskRow, "createdAt"|"updatedAt"|"stateVersion">): TaskRow;
export function getTask(db, taskId: string): TaskRow | undefined;
export function updateTaskState(db, taskId: string, state: TaskState, expectedVersion: number): TaskRow;

// src/jobs.ts
export type JobState = "running" | "passed" | "failed" | "timeout" | "killed" | "cancelled";
export function createJob(db, j: { jobId; taskId; profile; argv: string[]; pgid: number | null }): JobRow;
export function getJob(db, jobId: string): JobRow | undefined;
export function finishJob(db, jobId: string, r: { state: Exclude<JobState,"running">; exitCode; artifactPath; summary }): JobRow | undefined;
export function reconcileRunningJobs(db, isAlive: (pgid: number) => boolean): number;

// src/envelope.ts
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean };
```

**`finishJob` 有 compare-and-swap**：它只更新仍处于 `running` 的行，返回 `undefined`
表示这次调用输给了竞争者。**必须检查返回值** —— 这个 CAS 是为了防止「进程正常跑完退出的
瞬间，崩溃恢复判定它崩了、把真实的 passed 覆盖成 killed」，那个缺陷在 S0-A 实测复现过。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/profiles.ts` | 从控制平面加载 `profiles.yaml`，校验 argv 与超时 |
| `src/sbpl.ts` | SBPL profile 文本生成（**从 `spike/src/sbpl.ts` 移植**） |
| `src/sandbox.ts` | `sandbox-exec` 执行、超时、进程组 kill、输出截断（**从 `spike/src/sandbox.ts` 移植**） |
| `src/worktree.ts` | git worktree 生命周期 + `grande_diff` |
| `src/runner.ts` | job 编排：启动、artifact 落盘、摘要解析、状态收敛 |

五个任务，一一对应。

**Task 1、2、3 相互独立**（`profiles` / `sbpl` / `sandbox` 之间无 import 关系，
`sandbox` 只消费 `sbpl` 的 `buildProfile`），Task 4 独立，Task 5 消费全部。
若并行执行，1–4 可同时开工。

---

---

### Task 5: Job 编排 —— 启动、artifact、摘要、状态收敛

**Files:**
- Create: `src/runner.ts`
- Test: `tests/runner.test.ts`

**Interfaces:**
- Consumes: `getProfile`（Task 1，含 `maxRssMb`）、`resolveRepoPath` / `registeredIds`
  （S0-A）、`runSandboxed` / `defaultExecRoots`（Task 3，`RunOptions` 含 `onSpawn`）、
  `SandboxPaths`（Task 2）、`createJob` / `finishJob` / `getJob`（S0-A）、`Layout`
- Produces:
  - `interface StartedJob { jobId: string; state: "running"; pollAfterSeconds: number }`
  - `function startJob(deps: RunnerDeps, a: { taskId; repoId; worktreePath; profileName }): StartedJob`
  - `interface JobReport { truncated: boolean; state: JobState; exitCode: number | null; outputTruncated: boolean; killedBy: "timeout"|"rss"|"output"|null; durationMs: number | null; artifactPath: string | null; summary: string }`
    （I-5：`outputTruncated`/`killedBy`/`durationMs` 是新增字段，取自 `finishJob` 存的
    结构化 `summary`——此前这些信息落了库却从没被读出来过，模型没法区分
    「是超时还是真的被杀」「输出是不是被截断过」）
  - `function jobReport(db: DatabaseSync, jobId: string): JobReport`（MINOR：**不接
    `layout`**——旧签名里有，函数体从未用过）
  - `function awaitJobSettled(jobId: string): Promise<void>`（C-7：等某个 job 的后台
    收尾 promise 落地；生产路径不 await 它，测试与优雅关停用它）
  - `interface RunnerDeps { db: DatabaseSync; layout: Layout }`

**核心约束：`startJob` 必须 < 1s 返回**（规格 §5.4①）。它启动子进程后**立刻**
落 job 行并返回，实际执行在后台继续；完成时由回调调 `finishJob`。`worktreePath`
必须落在 `worktreesRoot` 之下——它会直接变成沙箱的可写根，这道校验
（`POLICY_DENIED`，C-6）跟 profile 校验一样必须在任何有副作用的操作之前完成。
后台收尾走一条独立的、绝不对外抛出的路径（C-7）：生产调用方不 await 它
（否则就不是「立刻返回」了），但它自己也绝不能产生 unhandled rejection——
测试与优雅关停用新增的 `awaitJobSettled(jobId)` 等它落地。

- [ ] **Step 1: 写失败测试**

`tests/runner.test.ts`：

```typescript
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { getJob } from "../src/jobs.ts";
import { createTask } from "../src/tasks.ts";
import { awaitJobSettled, jobReport, startJob } from "../src/runner.ts";

let ws: string, ctrl: string, layout: Layout, db: ReturnType<typeof openDb>, wt: string;
let savedWs: string | undefined, savedCtrl: string | undefined;

const waitFor = async (p: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!p()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 100));
  }
};

// C-6：原 fixture 从没创建过 `<workspaceRoot>/demo`、也没注册它，`startJob` 因此
// 要么在 realpathSync 上直接 ENOENT 崩溃，要么（若这两步被跳过）完全没有路径逃逸
// 校验可测——一个 `worktreePath: "/"` 会被直接接受，变成 `(allow file-write* (subpath "/"))`。
// `start()` 把「注册 taskId、追踪 jobId 供 afterEach 清理」这些样板收进一处。
const started: string[] = [];
const start = (profileName: string) => {
  const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName });
  started.push(s.jobId);
  return s;
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "run-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "run-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);

  // canonical 仓库必须真实存在且已注册：startJob 要用 resolveRepoPath 求 canonicalGit，
  // 而 runSandboxed 对 SandboxPaths 的每个字段做 realpathSync——路径不存在会在 buildProfile
  // 之前就抛 ENOENT（spike findings/U2 记过同一个坑）。
  const repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.ts"), "v1\n", "utf8");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  writeFileSync(layout.reposConfig, `repos:\n  - repoId: demo\n    registered: true\n`, "utf8");

  // worktree 必须是真的 worktree，且位置就是 startJob 会校验的 worktreesRoot 之下
  wt = join(layout.worktreesRoot, "demo", "task_abcd");
  g(repo, "worktree", "add", "-b", "grande/x-abcd", wt, g(repo, "rev-parse", "HEAD").trim());

  createTask(db, {
    taskId: "task_abcd", repoId: "demo", branch: "grande/x-abcd",
    baseCommit: g(repo, "rev-parse", "HEAD").trim(), worktreePath: wt, state: "READY",
  });
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    'repos:\n  demo:\n' +
    '    ok:   { argv: ["/bin/sh", "-c", "echo hello; exit 0"], timeoutSeconds: 30 }\n' +
    '    fail: { argv: ["/bin/sh", "-c", "echo boom >&2; exit 3"], timeoutSeconds: 30 }\n' +
    '    slow: { argv: ["/bin/sh", "-c", "sleep 60"], timeoutSeconds: 2 }\n' +
    // I-4：短日志（fail/ok）不足以证明「超过 8KB 就截断」——需要一个真的会产出
    // 大量输出的 profile。用 node 直接打一行 20000 字节，而不是很多短行：jobReport
    // 只取 artifact 尾部 40 行（TAIL_LINES），很多短行会在「只取 40 行」这一步就已经
    // 被压到 8KB 以下，测不出 truncateText 的截断上限。maxOutputBytes 故意给得比
    // 20000 大，让 sandbox 层不做截断——这样「truncated: true」只可能来自 jobReport
    // 自己 8KB 的摘要上限，而不是和沙箱层的截断混在一起。
    '    noisy: { argv: ["' + process.execPath + '", "-e", "console.log(\'A\'.repeat(20000))"], timeoutSeconds: 30, maxOutputBytes: 65536 }\n',
    "utf8",
  );
});

afterEach(async () => {
  // 先等后台收尾落地再拆环境：fire-and-forget 的 job 会在 db.close()/rmSync 之后才
  // 结束，writeFileSync 与 finishJob 双双抛错 → unhandled rejection（C-7，实测：
  // 进程非零退出）。
  await Promise.all(started.map(awaitJobSettled));
  started.length = 0;
  db.close();
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("startJob()", () => {
  it("立刻返回 jobId 与 running，不等命令跑完", () => {
    // 这一条是 ChatGPT ~60s 工具超时的直接要求（规格 §5.4①）
    const t0 = Date.now();
    const s = start("slow");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.state).toBe("running");
    expect(s.jobId).toMatch(/^job_/);
    expect(s.pollAfterSeconds).toBeGreaterThan(0);
    expect(getJob(db, s.jobId)?.state).toBe("running");
  });

  it("成功的命令最终收敛为 passed，exitCode 为 0", async () => {
    const s = start("ok");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.state).toBe("passed");
    expect(j.exitCode).toBe(0);
  });

  it("失败的命令收敛为 failed，并保留真实 exitCode", async () => {
    const s = start("fail");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.state).toBe("failed");
    expect(j.exitCode).toBe(3);
  });

  it("超时收敛为 timeout 而不是 failed（两者对模型意味着不同的下一步）", async () => {
    const s = start("slow");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    expect(getJob(db, s.jobId)!.state).toBe("timeout");
  });

  it("完整输出落 artifact，路径在控制平面之下（不在工作区）", async () => {
    const s = start("ok");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.artifactPath).not.toBeNull();
    expect(j.artifactPath!.startsWith(layout.controlRoot)).toBe(true);
    expect(j.artifactPath!.startsWith(layout.workspaceRoot)).toBe(false);
    expect(readFileSync(j.artifactPath!, "utf8")).toContain("hello");
  });

  it("未注册的 profile 抛 PROFILE_NOT_FOUND，且【不】留下 running 的 job 行", async () => {
    expect(() => start("nope")).toThrow(expect.objectContaining({ code: "PROFILE_NOT_FOUND" }));
    // 校验必须发生在建 job 行【之前】，否则会留下永远不会收敛的僵尸 job
    const rows = db.prepare("SELECT COUNT(*) AS n FROM job").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("落进 job 行的 pgid 是真实进程组，不是 null（否则重启对账会把活着的 job 判成 killed，C-5）", () => {
    const s = start("slow");
    expect(getJob(db, s.jobId)!.pgid).toBeGreaterThan(0);
  });
}, 30_000);

describe("jobReport()", () => {
  it("running 的 job 报告 running，且不假装有结果", () => {
    const s = start("slow");
    const r = jobReport(db, s.jobId);
    expect(r.state).toBe("running");
    expect(r.exitCode).toBeNull();
  });

  it("结束后给出摘要，短日志不截断，尾部不超过 40 行", async () => {
    const s = start("fail");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const r = jobReport(db, s.jobId);
    expect(r.state).toBe("failed");
    expect(r.summary).toContain("boom");
    expect(r.truncated).toBe(false);
    expect(r.summary.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("超过 8KB 的摘要被截断，且不超过截断上限（I-4：不是重言式的 typeof 断言）", async () => {
    const s = start("noisy");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const r = jobReport(db, s.jobId);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.summary, "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("宽出的字段：killedBy/durationMs 来自 finishJob 存的 summary，不再被丢弃（I-5）", async () => {
    const s = start("slow"); // timeoutSeconds: 2，必然超时
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const r = jobReport(db, s.jobId);
    expect(r.state).toBe("timeout");
    expect(r.killedBy).toBe("timeout");
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it("字段声明顺序：truncated 排在 summary 之前", async () => {
    const s = start("ok");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const keys = Object.keys(jobReport(db, s.jobId));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("summary"));
  });

  it("不存在的 jobId 抛 JOB_NOT_FOUND", () => {
    expect(() => jobReport(db, "job_nope")).toThrow(
      expect.objectContaining({ code: "JOB_NOT_FOUND" }),
    );
  });
}, 30_000);
```

**为什么每个 `describe` 都加了 `30_000` 超时**（I-7）：`vitest.config.ts` 没设
`testTimeout`，默认 5000ms；`waitFor` 的默认等待窗口是 20 秒，`slow` profile
本身就要跑满 2 秒超时再走完收尾——默认 5s 的 vitest 测试超时会在 `waitFor` 真正
等到结果之前就先把测试判成失败，`waitFor` 自己的「等待超时」永远没有机会触发。
**`describe` 的第三个参数是纯数字超时，不是选项对象**——`describe(name, fn, { timeout })`
在 vitest 4.1 下会被 TS 拒绝（`SuiteCollector` 的两个重载分别要求第三参数是
`number` 或者第二参数是 `SuiteOptions`），必须写成 `describe(name, fn, 30_000)`
（本条在移植代码块时曾经写错成对象形式，被 `tsc --noEmit` 当场拦下）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/runner.test.ts`
Expected: FAIL —— `Cannot find module '../src/runner.ts'`

- [ ] **Step 3: 实现**

`src/runner.ts`：

```typescript
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { truncateText } from "./envelope.ts";
import type { Layout } from "./layout.ts";
import { createJob, finishJob, getJob, type JobState } from "./jobs.ts";
import { resolveRepoPath } from "./paths.ts";
import { getProfile } from "./profiles.ts";
import { registeredIds } from "./registry.ts";
import { defaultExecRoots, runSandboxed } from "./sandbox.ts";

export class RunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `RunnerError [${code}]`;
    this.code = code;
  }
}

export interface RunnerDeps {
  db: DatabaseSync;
  layout: Layout;
}

export interface StartedJob {
  jobId: string;
  state: "running";
  pollAfterSeconds: number;
}

/** 建议轮询间隔：取超时的 1/10，夹在 3–20 秒之间。给模型一个具体数字比让它自己猜好 */
function pollHint(timeoutSeconds: number): number {
  return Math.min(20, Math.max(3, Math.round(timeoutSeconds / 10)));
}

/**
 * 后台收尾 promise，按 jobId 索引（C-7）。生产路径不 await 它——`grande_run` 必须
 * < 1s 返回，等它跑完就不是异步 job 了。测试与优雅关停用 `awaitJobSettled` 等它落地。
 */
const inFlight = new Map<string, Promise<void>>();

/** 等某个 job 的后台收尾跑完。未知或已收尾的 jobId 立即返回。 */
export function awaitJobSettled(jobId: string): Promise<void> {
  return inFlight.get(jobId) ?? Promise.resolve();
}

/**
 * 收尾路径**自己绝不能抛**（C-7）：它跑在没有调用方的 promise 尾巴上，抛出去就是
 * unhandled rejection——测试环境里这会让整个 vitest 套件非零退出（实测：进程
 * exit 99），生产环境里则是一条永远不会被任何人看到的崩溃。
 */
function safeWrite(path: string, body: string): void {
  try {
    writeFileSync(path, body, "utf8");
  } catch (e) {
    console.error(`[runner] 写 artifact 失败 ${path}：${(e as Error).message}`);
  }
}

/** @returns 这次收尾真的落库了吗。false = CAS 输了或库已关闭。 */
function safeFinish(
  db: DatabaseSync,
  jobId: string,
  r: {
    state: Exclude<JobState, "running">;
    exitCode: number | null;
    artifactPath: string | null;
    summary: Record<string, unknown> | null;
  },
): boolean {
  try {
    return finishJob(db, jobId, r) !== undefined;
  } catch (e) {
    console.error(`[runner] ${jobId} 收尾失败：${(e as Error).message}`);
    return false;
  }
}

/**
 * 启动一个 job，**立刻返回**。
 *
 * ChatGPT 的工具调用 ~60s 超时不可配置（规格 §5.4①），同步等待跑测试必然撞墙。
 * 因此本函数只负责：校验 → 启动子进程 → 落 job 行 → 返回。实际执行在后台继续，
 * 结束时回调 `finishJob`。
 *
 * **校验必须在任何有副作用的操作之前完成**，否则一个 profile 名打错、或一个
 * 指向工作区外的 `worktreePath`，会在留下痕迹之后才被拒绝。
 */
export function startJob(
  deps: RunnerDeps,
  a: { taskId: string; repoId: string; worktreePath: string; profileName: string },
): StartedJob {
  const { db, layout } = deps;

  // 先校验——抛错时不能留下任何痕迹
  const profile = getProfile(layout, a.repoId, a.profileName);
  // repoId 必须过注册与路径逃逸门禁：startJob 的 worktreePath 会变成
  // `allow file-write*` 的 subpath，裸 join(workspaceRoot, repoId) 等于没有门禁（C-6）。
  const canonicalGit = join(resolveRepoPath(layout, a.repoId, registeredIds(layout)), ".git");
  const worktree = realpathSync(a.worktreePath);
  const worktreesRoot = realpathSync(layout.worktreesRoot);
  if (worktree !== worktreesRoot && !worktree.startsWith(worktreesRoot + sep)) {
    throw new RunnerError(
      "POLICY_DENIED",
      `worktreePath 必须在 ${worktreesRoot} 之下，收到：${worktree}。` +
        `这条路径会直接成为沙箱的可写根。`,
    );
  }

  const jobId = `job_${randomUUID()}`;
  const jobTmp = join(layout.derivedRoot, "tmp", jobId);
  // jobTmp 必须先于下面的 realpathSync(jobTmp) 存在——这一步没法推迟到 createJob
  // 成功之后：它是构造 runSandboxed 调用参数的一部分（同步求值，在函数体真正
  // 执行之前）。
  mkdirSync(join(jobTmp, "home"), { recursive: true });

  // runSandboxed 的前半段（realpath、写 profile、spawn）是同步的，onSpawn 在返回
  // promise 之前就已经触发，所以 createJob 拿得到真实 pgid（C-5）。实测整段 6 ms。
  let pgid: number | null = null;
  const run = runSandboxed({
    argv: [...profile.argv],
    cwd: worktree,
    onSpawn: (p) => { pgid = p; },
    paths: {
      worktree, canonicalGit, jobTmp: realpathSync(jobTmp),
      controlRoot: layout.controlRoot, worktreesRoot, execRoots: defaultExecRoots(),
    },
    timeoutMs: profile.timeoutSeconds * 1000,
    maxOutputBytes: profile.maxOutputBytes,
    maxRssMb: profile.maxRssMb,
  });

  const artifactDir = join(layout.artifactsDir, a.taskId, jobId);
  const artifactPath = join(artifactDir, "output.log");

  createJob(db, { jobId, taskId: a.taskId, profile: profile.name, argv: [...profile.argv], pgid });

  // artifactDir 特意挪到 createJob 成功之后再建（MINOR 修复）：jobTmp 没法这样
  // 处理（上面解释过的顺序依赖），但 artifactDir 在 job 行落库之前完全用不上——
  // 挪到这里之后，createJob 失败时只留一个空目录（jobTmp），不是两个。下面的
  // `.then`/`.catch` 回调保证只会在这次同步调用返回之后才运行（Promise 语义），
  // 不存在「回调抢在 mkdirSync 前面执行」的竞态。
  mkdirSync(artifactDir, { recursive: true });

  inFlight.set(
    jobId,
    run
      .then((r) => {
        safeWrite(artifactPath, `${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
        const state: Exclude<JobState, "running"> =
          r.killedBy === "timeout" ? "timeout"
          : r.killedBy === "rss" || r.killedBy === "output" ? "killed"
          : r.exitCode === 0 ? "passed" : "failed";
        const won = safeFinish(db, jobId, {
          state, exitCode: r.exitCode, artifactPath,
          summary: { truncated: r.truncated, killedBy: r.killedBy ?? null, durationMs: r.durationMs, peakRssMb: r.peakRssMb },
        });
        if (!won) {
          // finishJob 的 CAS 输了：别人（多半是 reconcileRunningJobs）已经把这行判成终态。
          // **不覆盖**，但必须留痕——否则真实结果连同 artifactPath 一起悄无声息地消失。
          console.error(
            `[runner] ${jobId} 的真实结果（${state}, exit=${r.exitCode}）晚于收敛写入、已被丢弃；` +
              `完整日志仍在 ${artifactPath}`,
          );
        }
      })
      .catch((e: unknown) => {
        safeWrite(artifactPath, `runner 内部错误：${(e as Error).message}\n`);
        safeFinish(db, jobId, { state: "killed", exitCode: null, artifactPath, summary: { error: (e as Error).message } });
      })
      .finally(() => { inFlight.delete(jobId); }),
  );

  return { jobId, state: "running", pollAfterSeconds: pollHint(profile.timeoutSeconds) };
}

export interface JobReport {
  truncated: boolean;
  state: JobState;
  exitCode: number | null;
  outputTruncated: boolean;
  killedBy: "timeout" | "rss" | "output" | null;
  durationMs: number | null;
  artifactPath: string | null;
  summary: string;
}

/** 摘要给模型看的尾部行数（规格 §5.4②：失败用例名 + 关键堆栈 + 尾部 40 行） */
const TAIL_LINES = 40;
const SUMMARY_MAX_BYTES = 8 * 1024;

/**
 * 生成给模型看的 job 报告。完整日志留在 artifact，这里只给尾部摘要 ——
 * 整份测试日志轻易就能撑爆 ChatGPT 的响应上限。
 *
 * **不接 `layout` 参数**（MINOR 修复）：旧签名里有，函数体从未用过——`artifactPath`
 * 已经是 `getJob` 返回行里的绝对路径，不需要 `layout` 拼接。
 */
export function jobReport(db: DatabaseSync, jobId: string): JobReport {
  const j = getJob(db, jobId);
  if (!j) throw new RunnerError("JOB_NOT_FOUND", `job 不存在：${jobId}`);

  if (j.state === "running") {
    return {
      truncated: false, state: "running", exitCode: null, outputTruncated: false,
      killedBy: null, durationMs: null, artifactPath: null, summary: "仍在运行中。",
    };
  }

  let tail = "";
  if (j.artifactPath !== null) {
    try {
      const all = readFileSync(j.artifactPath, "utf8").split("\n");
      tail = all.slice(-TAIL_LINES).join("\n");
    } catch {
      tail = "（artifact 不可读）";
    }
  }
  const capped = truncateText(tail, SUMMARY_MAX_BYTES);
  // I-5：此前只吐 { truncated, state, exitCode, artifactPath, summary }，`finishJob`
  // 存进 JobRow.summary 列的 killedBy/durationMs/truncated（沙箱层的）全部被丢在
  // 地上——模型永远看不到「是超时还是真的被杀」，只能从 state 猜。
  const s = j.summary;
  return {
    truncated: capped.truncated,
    state: j.state,
    exitCode: j.exitCode,
    outputTruncated: (s?.truncated as boolean | undefined) ?? false,
    killedBy: (s?.killedBy as JobReport["killedBy"] | undefined) ?? null,
    durationMs: (s?.durationMs as number | undefined) ?? null,
    artifactPath: j.artifactPath,
    summary: capped.text,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/runner.test.ts`
Expected: PASS（13 个用例：startJob 7、jobReport 6）。**确认进程以 exit code 0
结束、没有 unhandled rejection 警告**（C-7：修复前两条用 `slow` profile 的用例
会在 `afterEach` 拆掉环境之后才收尾，`writeFileSync`/`finishJob` 在已拆的环境里
抛错，`.catch` 处理器自己又抛，最终整个 vitest 进程以非零 exit code 结束）。

- [ ] **Step 5: 承重性验证**

把 `getProfile(...)` 那一行挪到 `createJob(...)` **之后**，确认「不留下 running 的 job 行」
那条变红；还原后确认变绿。**把观察结果写进报告。**

- [ ] **Step 6: 全套测试 + typecheck + 提交**

```bash
pnpm test
pnpm typecheck
git add src/runner.ts tests/runner.test.ts
git commit -m "feat(s0-c): job 编排、artifact 落盘与摘要"
```


---

## 本切片明确不做

| 不做 | 归属 |
|---|---|
| MCP 工具注册、`readOnlyHint` 等注解 | S0-D |
| 内部异常 → 工具错误码映射（规格 §7.1） | S0-D |
| 仓库文件读写（`repoRead` / `repoEdit` 等） | S0-B |
| `git commit`、push、GitHub | S2 及以后（规格 §5.3） |
| Checkpoint、Trash、删除文件 | S1 |
| `reconcileRunningJobs` 接到 Gateway 启动流程 | S0-D（S0-A 已实现该函数，但至今**没有生产调用方**；S0-D 必须接上，否则 AC-11 在系统层面不成立） |