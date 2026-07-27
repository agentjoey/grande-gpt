# s0c-4-worktree

> 本文件是 **S0C 切片**的第 4 个任务，从
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

### Task 4: worktree 生命周期与 `grande_diff`

**Files:**
- Create: `src/worktree.ts`
- Test: `tests/worktree.test.ts`

**Interfaces:**
- Consumes: `Layout`、`resolveRepoPath`、`registeredIds`、`assertValidId`、`loadDepDirs`（Task 1）
- Produces:
  - `class GitError extends Error { readonly code: string }`
  - `interface WorktreeInfo { taskId: string; branch: string; baseCommit: string; worktreePath: string }`
  - `function openWorktree(layout: Layout, repoId: string, slug: string, taskId: string): WorktreeInfo`
  - `function removeWorktree(layout: Layout, info: { repoId: string; worktreePath: string; branch: string }): void`
    （`branch` 字段是 MINOR 修复新增的——见 Step 3 的说明）
  - `function listChangedFiles(worktreePath: string, baseCommit: string): string[]`
  - `interface DiffResult { truncated: boolean; nextCursor: string | null; files: { path: string; hunks: string }[] }`
  - `function repoDiff(worktreePath: string, baseCommit: string, opts?: { maxLines?: number; cursor?: string | null }): DiffResult`

**关键约束：**
- **绝不 `git fetch`**（规格 §5.4①）—— 大仓库上会直接撑爆 ChatGPT 的 ~60s 超时。
  base 就取本机当前 `HEAD`。
- **git 一律用 argv 数组调用**（`execFileSync`），绝不拼 shell 字符串（铁律二）。
- 分支名 `grande/<slug>-<taskId 后 4 位>`（规格 §5.2）。
- diff 上限 400 行（规格 §5.4②），按文件分页。
- **`git diff`/`git diff --no-index` 在「有差异」时以 exit 1 退出**（C-1）——那是它们
  的正常成功路径，不是错误。`execFileSync` 对任何非零退出一律抛异常，必须显式
  把 exit 1 + 非空 stdout 还原成正常返回，否则新增文件的 diff 内容会全部丢失。
  同理 `git symbolic-ref -q HEAD`（检测 detached HEAD）用 exit 1 表示「没有分支」，
  同样不是失败。
- **`taskId` 会直接成为 worktree 目录名**（C-4）——`assertValidId` 不挡路径分隔符
  与 `..`，本文件必须自己补一道更严的校验，否则一个恶意/畸形 `taskId` 能让
  worktree 落到工作区之外，并被写进 SBPL 的 `allow file-write*`。
- **worktree 需要能跑项目自己的测试套件**（I-6）——`git worktree add` 不含
  `node_modules`，S0 全离线装不回来；`openWorktree` 必须把 `loadDepDirs` 声明的
  目录从 canonical 克隆进新 worktree。

- [ ] **Step 1: 写失败测试**

`tests/worktree.test.ts`：

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { listChangedFiles, openWorktree, removeWorktree, repoDiff } from "../src/worktree.ts";

let ws: string, ctrl: string, layout: Layout, repo: string;
let savedWs: string | undefined, savedCtrl: string | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** 与 layout.ts/paths.ts 里同名函数逻辑一致，本文件单独放一份而不是跨模块 import
 *  （项目既有约定，见 layout.ts 同名函数的 JSDoc）：真正判断 child 是否在 parent
 *  之下，而不是裸 `.startsWith`——后者在 `/a/bc` 相对 `/a/b` 这类相邻兄弟路径上
 *  会给出假阳性（MINOR 修复）。 */
function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "wt-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "wt-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);

  repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.ts"), "v1\n", "utf8");
  // z.ts 必须在初始提交里（C-3）：排序的承重性靠「已跟踪且被修改的文件排在
  // 未跟踪文件之后」才能测出来——见下面「顺序确定」测试的注释。
  writeFileSync(join(repo, "z.ts"), "v1\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  writeFileSync(join(layout.reposConfig), `repos:\n  - repoId: demo\n    path: ${repo}\n    registered: true\n`, "utf8");
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("openWorktree()", () => {
  it("建出 worktree 与分支，路径在 worktreesRoot 之下", () => {
    const info = openWorktree(layout, "demo", "fix-parser", "task_abcd");
    expect(existsSync(info.worktreePath)).toBe(true);
    // 用真正的「在……之下」判断，不用裸 `.startsWith`（MINOR 修复，见上面 isUnder）。
    expect(isUnder(layout.worktreesRoot, info.worktreePath)).toBe(true);
    expect(info.branch).toBe("grande/fix-parser-abcd");
    expect(info.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    // worktree 里能看到 canonical 的内容
    expect(existsSync(join(info.worktreePath, "a.ts"))).toBe(true);
  });

  it("canonical 的工作区【不受影响】：分支没被切走，文件没变", () => {
    // 这是原地模型（D4）的核心承诺——用户还在用编辑器干活，不能被我们切分支。
    const before = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
    openWorktree(layout, "demo", "fix", "task_abcd");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(before);
  });

  it("两个任务的 worktree 互相隔离", () => {
    const a = openWorktree(layout, "demo", "one", "task_aaaa");
    const b = openWorktree(layout, "demo", "two", "task_bbbb");
    expect(a.worktreePath).not.toBe(b.worktreePath);
    writeFileSync(join(a.worktreePath, "only-a.ts"), "x", "utf8");
    expect(existsSync(join(b.worktreePath, "only-a.ts"))).toBe(false);
  });

  it("未注册的仓库被拒", () => {
    expect(() => openWorktree(layout, "not-registered", "s", "task_abcd")).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/REPO_NOT_REGISTERED|REPO_NOT_FOUND/) }),
    );
  });

  it("重复的 taskId 被拒，而不是静默复用别人的 worktree", () => {
    openWorktree(layout, "demo", "one", "task_abcd");
    expect(() => openWorktree(layout, "demo", "two", "task_abcd")).toThrow(
      expect.objectContaining({ code: "WORKTREE_EXISTS" }),
    );
  });

  it.each(["../../../../tmp/evil", "..", ".", "a/b", "task abcd", ""])(
    "含路径穿越的 taskId 被拒：%s（C-4）", (bad) => {
      expect(() => openWorktree(layout, "demo", "s", bad)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
      // 关键在于「worktree 没被建到工作区外面」，不只是「抛了个错」
      expect(existsSync("/tmp/evil")).toBe(false);
    },
  );

  it("canonical 处于 rebase 中时拒绝开新任务", () => {
    mkdirSync(join(repo, ".git", "rebase-merge"), { recursive: true });
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).toThrow(
      expect.objectContaining({ code: "CANONICAL_BUSY" }),
    );
  });

  it("canonical 处于 detached HEAD 时拒绝开新任务（规格 §7：CANONICAL_BUSY 明确列出这一种状态）", () => {
    const sha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", sha); // 直接检出一个 sha，产生 detached HEAD
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).toThrow(
      expect.objectContaining({ code: "CANONICAL_BUSY" }),
    );
  });

  it("绝不执行 git fetch（规格 §5.4①：大仓库上会撑爆 60s 超时）", () => {
    // 无 remote 的仓库里 `git fetch` 静默 exit 0（实测），所以「不抛错」证明不了任何事。
    // 改成给仓库配一个必然失败的 remote：只要实现里有 fetch，就一定抛 GIT_FAILED（I-1）。
    git(repo, "remote", "add", "origin", "file:///nonexistent-remote-for-fetch-probe.git");
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).not.toThrow();
  });

  it("depDirs 声明的目录（如 node_modules）会从 canonical 克隆进新 worktree（I-6）", () => {
    const nm = join(repo, "node_modules", "some-pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "index.js"), "module.exports = 1;\n", "utf8");
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      'depDirs:\n  demo: ["node_modules"]\nrepos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
      "utf8",
    );
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    expect(existsSync(join(info.worktreePath, "node_modules", "some-pkg", "index.js"))).toBe(true);
  });

  it("canonical 里没有的 depDirs 目录被跳过，不报错（比如全新仓库还没 install）", () => {
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      'depDirs:\n  demo: ["node_modules"]\nrepos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
      "utf8",
    );
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).not.toThrow();
  });
});

describe("listChangedFiles() 与 repoDiff()", () => {
  it("无改动时返回空", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    expect(listChangedFiles(info.worktreePath, info.baseCommit)).toEqual([]);
    expect(repoDiff(info.worktreePath, info.baseCommit).files).toEqual([]);
  });

  it("列出已改与新增的文件，顺序确定（已跟踪的 z.ts 排在未跟踪的 b.ts 之后）", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "z.ts"), "v2\n", "utf8");   // 已跟踪，被修改
    writeFileSync(join(info.worktreePath, "b.ts"), "new\n", "utf8");  // 未跟踪，新增
    // 未排序时 git 给的是 ["z.ts","b.ts"]（两个列表各自有序，拼接后无序）——
    // 这正是去掉 .sort() 会变红的形状（C-3）。
    expect(listChangedFiles(info.worktreePath, info.baseCommit)).toEqual(["b.ts", "z.ts"]);
  });

  it("diff 含实际改动内容", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "a.ts"), "v2\n", "utf8");
    const d = repoDiff(info.worktreePath, info.baseCommit);
    expect(d.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(d.files[0]!.hunks).toContain("+v2");
    expect(d.files[0]!.hunks).toContain("-v1");
  });

  it("新增文件的 diff 也含实际内容，不是空字符串（C-1：git diff --no-index 有差异时 exit 1，此前被 catch 吞成空）", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "new.ts"), "brand new\n", "utf8");
    const d = repoDiff(info.worktreePath, info.baseCommit);
    expect(d.files.map((f) => f.path)).toEqual(["new.ts"]);
    expect(d.files[0]!.hunks).toContain("+brand new");
  });

  it("非 ASCII 文件名的新增文件也能被列出与 diff（C-1：默认 core.quotePath 会把它 C-quote 成匹配不到任何文件的字面量）", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "café.ts"), "bonjour\n", "utf8");
    expect(listChangedFiles(info.worktreePath, info.baseCommit)).toEqual(["café.ts"]);
    const d = repoDiff(info.worktreePath, info.baseCommit);
    expect(d.files.map((f) => f.path)).toEqual(["café.ts"]);
    expect(d.files[0]!.hunks).toContain("+bonjour");
  });

  it("超过 maxLines 时按文件分页，续取不重不漏", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    for (const n of ["f1.ts", "f2.ts", "f3.ts"]) {
      writeFileSync(join(info.worktreePath, n), "x\n".repeat(20), "utf8");
    }
    const first = repoDiff(info.worktreePath, info.baseCommit, { maxLines: 25 });
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = repoDiff(info.worktreePath, info.baseCommit, { maxLines: 1000, cursor: first.nextCursor });
    const seen = [...first.files, ...second.files].map((f) => f.path);
    expect(new Set(seen).size).toBe(seen.length);       // 不重
    expect(new Set(seen)).toEqual(new Set(["f1.ts", "f2.ts", "f3.ts"])); // 不漏
  });

  it("单个超过 maxLines 的大文件仍会被给出，cursor 必须前进（否则模型永远轮询，I-2）", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "big.ts"), "y\n".repeat(600), "utf8");
    writeFileSync(join(info.worktreePath, "s2.ts"), "small\n", "utf8");
    const first = repoDiff(info.worktreePath, info.baseCommit, { maxLines: 400 });
    expect(first.files.map((f) => f.path)).toEqual(["big.ts"]); // 去掉 files.length>0 守卫时这里是 []
    expect(first.nextCursor).toBe("1");                         // …且 nextCursor 恒为 "0"
    const second = repoDiff(info.worktreePath, info.baseCommit, { maxLines: 400, cursor: first.nextCursor });
    expect(second.files.map((f) => f.path)).toEqual(["s2.ts"]);
    expect(second.nextCursor).toBeNull();
  });

  it("字段声明顺序：truncated/nextCursor 排在 files 之前", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    const keys = Object.keys(repoDiff(info.worktreePath, info.baseCommit));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("files"));
    expect(keys.indexOf("nextCursor")).toBeLessThan(keys.indexOf("files"));
  });
});

describe("removeWorktree()", () => {
  it("移除 worktree 目录，且 canonical 仓库仍然健康", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    removeWorktree(layout, { repoId: "demo", worktreePath: info.worktreePath, branch: info.branch });
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(() => git(repo, "status", "--short")).not.toThrow();
  });

  it("同时清理分支：换一个不同 taskId 但后四位相同时，不会因为分支已存在而失败（MINOR）", () => {
    const info = openWorktree(layout, "demo", "s", "task_1abcd");
    removeWorktree(layout, { repoId: "demo", worktreePath: info.worktreePath, branch: info.branch });
    // 分支名只取决于 slug 与 taskId 后四位（见 openWorktree）：task_1abcd 与 task_2abcd
    // 后四位都是 abcd，会撞上同一个分支名 grande/s-abcd——如果上一次没把分支删干净，
    // 这里会因为分支已存在而抛错。
    expect(() => openWorktree(layout, "demo", "s", "task_2abcd")).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/worktree.test.ts`
Expected: FAIL —— `Cannot find module '../src/worktree.ts'`

- [ ] **Step 3: 实现**

`src/worktree.ts`：

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "./layout.ts";
import { assertValidId, resolveRepoPath } from "./paths.ts";
import { loadDepDirs } from "./profiles.ts";
import { registeredIds } from "./registry.ts";

export class GitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `GitError [${code}]`;
    this.code = code;
  }
}

export interface WorktreeInfo {
  taskId: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
}

/** git 一律以 argv 数组调用，绝不拼 shell 字符串（铁律二） */
function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    throw new GitError("GIT_FAILED", `git ${args[0]} 失败：${detail}`);
  }
}

/**
 * `git diff` 家族在「有差异」时以 **exit 1** 退出——那是它的正常成功路径，不是错误。
 * `execFileSync` 对任何非零退出都抛异常，所以这里必须把 exit 1 + 非空 stdout 还原成
 * 正常返回。原先那句 `catch { hunks = "" }` 把 exit 1 一律当失败吞掉，结果是**每个新增
 * 文件的 diff 内容全部丢失**（实测：hunkBytes 全为 0），而模型看到的是「文件变了但没有
 * 任何改动」。真正的错误（例如路径不存在）stdout 为空，仍然抛出。（C-1）
 */
function gitAllowingDiffExit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: Buffer | string; message: string };
    if (err.status === 1 && typeof err.stdout === "string" && err.stdout.length > 0) return err.stdout;
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    throw new GitError("GIT_FAILED", `git ${args[0]} 失败：${detail}`);
  }
}

/**
 * `git symbolic-ref -q HEAD` 用退出码本身携带语义：0 = 在某个分支上，
 * 1 = detached HEAD（`-q` 让这种情况不打印到 stderr）。这与上面 `git diff --no-index`
 * 退出码 1 = 有差异是同一类陷阱——退出码不是「失败/成功」二元开关，上面那个把非零
 * 退出一律转成 `GIT_FAILED` 的通用 `git()` helper 在这里不适用，必须单独处理，否则
 * detached HEAD 会被误判成一次 git 命令失败，而不是「这是一个需要报告的正常状态」（MINOR）。
 */
function isDetachedHead(repoRoot: string): boolean {
  try {
    execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return false;
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string; message: string };
    if (err.status === 1) return true;
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    throw new GitError("GIT_FAILED", `git symbolic-ref 失败：${detail}`);
  }
}

/**
 * canonical 是否处于不适合派生 worktree 的状态。
 *
 * 这些状态下建 worktree 会留下难以理解的现场，而用户此刻正在手动处理某件事 ——
 * 拒绝比「帮忙」更有用。detached HEAD 属于同一类（MINOR：规格 §7 的 `CANONICAL_BUSY`
 * 明确列出 rebase / index.lock / detached HEAD 三种）——用户很可能正用它临时检出
 * 某个 commit 做检查（例如 `git bisect`），这时候派生一个基于该瞬时 commit 的
 * 任务分支同样会制造一个不清楚从哪来的现场。
 */
function assertCanonicalIdle(repoRoot: string): void {
  const gitDir = join(repoRoot, ".git");
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "index.lock"]) {
    if (existsSync(join(gitDir, marker))) {
      throw new GitError(
        "CANONICAL_BUSY",
        `${repoRoot} 正处于 ${marker} 状态。请先在你自己的 checkout 里处理完，再开新任务。`,
      );
    }
  }
  if (isDetachedHead(repoRoot)) {
    throw new GitError(
      "CANONICAL_BUSY",
      `${repoRoot} 处于 detached HEAD（不在任何分支上）。请先在你自己的 checkout 里切回一个分支，再开新任务。`,
    );
  }
}

/**
 * `taskId` 会**直接成为 worktree 的目录名**，因此这里要的比 `assertValidId` 更严。
 * `assertValidId` 的 JSDoc 明确写着「id 字符串从不参与路径拼接，不必挡分隔符」——
 * 本函数打破了那个前提，就必须自己补上：实测 `assertValidId("../../../../tmp/evil")`
 * 通过，而 `join(worktreesRoot, repoId, "../../../../tmp/evil")` = `/tmp/evil`，
 * 随后它会作为 `allow file-write*` 的 subpath 进 SBPL。（C-4）
 */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 为一个任务派生 worktree 与分支。
 *
 * **绝不 `git fetch`**（规格 §5.4①）：大仓库上 fetch 可能几十秒，直接撑爆 ChatGPT
 * 那个不可配置的 ~60s 工具超时。base 取本机当前 HEAD。
 *
 * **canonical 不受影响**：`git worktree add` 不会切走用户当前分支 —— 原地模型（D4）
 * 承诺用户可以继续用编辑器干活。
 */
export function openWorktree(
  layout: Layout,
  repoId: string,
  slug: string,
  taskId: string,
): WorktreeInfo {
  assertValidId(taskId, "taskId");
  if (!TASK_ID_RE.test(taskId)) {
    throw new GitError(
      "INVALID_INPUT",
      `taskId 必须是 1–64 个 ASCII 字母/数字/下划线/连字符且首字符为字母或数字，` +
        `收到：${JSON.stringify(taskId)}。taskId 会直接成为 worktree 目录名，` +
        `路径分隔符与 .. 会让 worktree 落到工作区之外。`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) {
    throw new GitError("INVALID_INPUT", `slug 必须是 1–40 个小写字母、数字或连字符，收到：${slug}`);
  }

  const repoRoot = resolveRepoPath(layout, repoId, registeredIds(layout));
  assertCanonicalIdle(repoRoot);

  const dir = join(layout.worktreesRoot, repoId, taskId);
  if (existsSync(dir)) {
    throw new GitError("WORKTREE_EXISTS", `${taskId} 的 worktree 已存在：${dir}`);
  }

  const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const branch = `grande/${slug}-${taskId.slice(-4)}`;
  git(repoRoot, ["worktree", "add", "-b", branch, dir, baseCommit]);

  cloneDepDirs(layout, repoId, repoRoot, dir);

  return { taskId, branch, baseCommit, worktreePath: realpathSync(dir) };
}

/**
 * 把 canonical 里已经存在的依赖目录（`profiles.yaml` 顶层 `depDirs.<repoId>` 声明，
 * 见 `src/profiles.ts` 的 `loadDepDirs`）克隆进新 worktree。（I-6）
 *
 * **为什么需要这一步**：`git worktree add` 产出的是一份干净 checkout，`node_modules`
 * 通常被 gitignore，新 worktree 里天然没有它；而 S0 全离线（Global Constraints）
 * 意味着新 worktree 里没法 `pnpm install` 补回来。没有这一步，`pnpm test`——大概率
 * 是第一个被注册的 profile——会在**每一个** worktree 里失败，等于 runner 跑不了
 * 这个项目自己的测试套件。
 *
 * 用 APFS `cp -Rc`（clonefile）：写时复制、零额外磁盘、保留符号链接（本机 macOS
 * 26.5.1 实测核对：dest 与 src 的同一文件 inode 不同但字节内容相同，符号链接原样
 * 保留，与 U2 spike 记录的 pnpm store 内部机制是同一种复制方式，见
 * `spike/findings/U2-seatbelt.md`「pnpm store」一节）。canonical 里不存在的目录
 * 直接跳过——不是错误（例如一个还没跑过 `pnpm install` 的全新仓库）。目标已存在
 * 也跳过——`cp -R` 在目标已存在时会把源目录**嵌套**进目标而不是替换它，那不是
 * 想要的语义，而正常路径下 `worktreeDir` 是刚建出来的全新 checkout，dest 不应该
 * 已经存在。
 */
function cloneDepDirs(layout: Layout, repoId: string, repoRoot: string, worktreeDir: string): void {
  for (const rel of loadDepDirs(layout, repoId)) {
    const src = join(repoRoot, rel);
    if (!existsSync(src)) continue;
    const dest = join(worktreeDir, rel);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    try {
      execFileSync("/bin/cp", ["-Rc", src, dest], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message: string };
      const detail = err.stderr ? String(err.stderr).trim() : err.message;
      throw new GitError("GIT_FAILED", `克隆依赖目录 ${rel} 到 worktree 失败：${detail}`);
    }
  }
}

/**
 * 移除 worktree。用 `--force` 是因为里面必然有未提交改动（S0 不做 commit）。
 *
 * **随手删掉分支**（MINOR 修复）：`git worktree remove` 只删工作目录，分支本身
 * 留在 canonical 里。不删的后果不是美观问题——`openWorktree` 的分支名是
 * `grande/<slug>-<taskId 后 4 位>`，重新用同一个 (slug, taskId 后四位) 组合开
 * 新任务时，`git worktree add -b <同名分支>` 会因为分支已存在而失败，报出一个
 * 跟真实原因（上一次没清理干净）毫无关系的 `GIT_FAILED`。
 *
 * 分支删除失败不应该掩盖「worktree 目录本身已经被成功移除」这个事实，但也不能
 * 假装什么都没发生——重新抛成 `WORKTREE_EXISTS`，如实反映下一次同名 open 会
 * 撞到的真实症状。
 */
export function removeWorktree(
  layout: Layout,
  info: { repoId: string; worktreePath: string; branch: string },
): void {
  const repoRoot = resolveRepoPath(layout, info.repoId, registeredIds(layout));
  git(repoRoot, ["worktree", "remove", "--force", info.worktreePath]);
  try {
    git(repoRoot, ["branch", "-D", info.branch]);
  } catch (e) {
    throw new GitError(
      "WORKTREE_EXISTS",
      `worktree 已移除，但清理分支 ${info.branch} 失败：${(e as Error).message}。` +
        `再次使用同一个 slug/taskId 后四位开新任务前，可能需要手动清理该分支。`,
    );
  }
}

const splitZ = (s: string): string[] => s.split("\0").filter((x) => x.length > 0);

/**
 * worktree 相对 base 改动过的文件，排序后返回（顺序必须确定）。
 *
 * **必须用 `-z`**：默认 `core.quotePath=true` 下，非 ASCII 文件名会被 git 输出成
 * C 风格转义的字面量（`café.ts` → `"caf\303\251.ts"`，实测）。那个字符串既不能给人看，
 * 拿回去当 pathspec 也匹配不到任何文件——diff 于是恒为空。`-z` 输出原始 UTF-8 字节、
 * 以 NUL 分隔，顺带也解决了文件名里含换行的情况。（C-1）
 */
export function listChangedFiles(worktreePath: string, baseCommit: string): string[] {
  const tracked = splitZ(git(worktreePath, ["diff", "--name-only", "-z", baseCommit]));
  const untracked = splitZ(git(worktreePath, ["ls-files", "-z", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

export interface DiffResult {
  truncated: boolean;
  nextCursor: string | null;
  files: { path: string; hunks: string }[];
}

const DEFAULT_MAX_DIFF_LINES = 400;

/**
 * worktree 相对 base 的 diff，**按文件分页**（规格 §5.4②，上限 400 行）。
 *
 * 按文件而不是按行分页，是因为半个 hunk 对模型没有意义。
 * `cursor` 是「已经给过多少个文件」的偏移量。
 */
export function repoDiff(
  worktreePath: string,
  baseCommit: string,
  opts?: { maxLines?: number; cursor?: string | null },
): DiffResult {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_DIFF_LINES;
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GitError("INVALID_INPUT", `cursor 必须是非负整数，收到：${opts?.cursor}`);
  }

  const paths = listChangedFiles(worktreePath, baseCommit);
  const files: DiffResult["files"] = [];
  let lines = 0;
  let i = offset;

  for (; i < paths.length; i++) {
    const p = paths[i]!;
    // 对未跟踪文件 `git diff <base> -- <path>` 是空的，用 --no-index 与 /dev/null 比。
    // --no-index 有差异时 exit 1，交给 gitAllowingDiffExit 还原（见其 JSDoc，C-1）。
    let hunks = git(worktreePath, ["diff", "--no-color", baseCommit, "--", p]);
    if (hunks.length === 0) {
      hunks = gitAllowingDiffExit(worktreePath, ["diff", "--no-color", "--no-index", "--", "/dev/null", p]);
    }
    const n = hunks.split("\n").length;
    // 至少给出一个文件，否则单个超大文件会导致永远返回空、cursor 原地踏步（I-2）
    if (files.length > 0 && lines + n > maxLines) break;
    files.push({ path: p, hunks });
    lines += n;
    if (lines >= maxLines) {
      i++;
      break;
    }
  }

  const truncated = i < paths.length;
  return { truncated, nextCursor: truncated ? String(i) : null, files };
}
```

**注意 `repoDiff` 里那个「至少给出一个文件」的守卫**：没有它，一个超过 `maxLines`
的大文件会导致每次都返回空 `files` 且 `nextCursor` 不前进 —— 模型会永远轮询下去。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/worktree.test.ts`
Expected: PASS（26 个用例：openWorktree 16、listChangedFiles/repoDiff 8、removeWorktree 2）

- [ ] **Step 5: 承重性验证**

去掉 `listChangedFiles` 末尾的 `.sort()`，确认「顺序确定（已跟踪的 z.ts 排在未跟踪的
b.ts 之后）」那条变红（C-3 修复前的旧版断言无法在这一步变红——它的 fixture 巧合地
让排序前后结果一样；这正是本轮把 `beforeEach` 改成 `z.ts` 预先提交、`b.ts` 未跟踪
的原因）；还原后确认变绿。再去掉 `repoDiff` 里的 `files.length > 0 &&` 守卫，确认
「单个超过 maxLines 的大文件仍会被给出，cursor 必须前进」那条变红（I-2 已经把这个
用例加进 Step 1，不需要再另外补）；还原后确认变绿。**把两次观察都写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/worktree.ts tests/worktree.test.ts
git commit -m "feat(s0-c): worktree 生命周期与 grande_diff"
```

---


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