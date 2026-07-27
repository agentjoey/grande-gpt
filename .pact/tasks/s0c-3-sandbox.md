# s0c-3-sandbox

> 本文件是 **S0C 切片**的第 3 个任务，从
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

### Task 3: 沙箱执行器 —— 从 spike 移植

**Files:**
- Create: `src/sandbox.ts`（**移植自 `spike/src/sandbox.ts`**）
- Test: `tests/sandbox.test.ts`（移植自 `spike/tests/sandbox.test.ts`）

**Interfaces:**
- Consumes: `buildProfile`、`SandboxPaths`（Task 2）
- Produces: `interface RunOptions`（含 `onSpawn?: (pgid: number) => void`，见 Step 2）、
  `interface RunResult`、`function runSandboxed(o: RunOptions): Promise<RunResult>`、
  `function defaultExecRoots(): string[]`

**同样是移植。** `spike/src/sandbox.ts` 已过四轮审查，修掉过四个真实缺陷：
exec 放行清单漏了本机 node 的安装位置、进程组 kill 的测试是假的、`kill(-0)` 的
杀伤半径、以及 **PATH 与 execRoots 两处独立硬编码导致分叉**（pnpm 的
`#!/usr/bin/env node` shebang 因此 exit 127）。

- [ ] **Step 1: 阅读源文件**

读 `spike/src/sandbox.ts` 与 `spike/tests/sandbox.test.ts`。
**注意 PATH 必须从 `execRoots` 派生**，不得另行硬编码 —— 那正是被修掉的缺陷。

**已知限制，照抄不代表可以忽略**（MINOR）：`spike/src/sbpl.ts` 里放行
`node_modules/.bin` 的那条规则自带一段注释，记录了它只在「非 workspace 布局」
（`poc/`，单层 `node_modules/.bin`）下验证过；pnpm workspace/monorepo 会有多个
`packages/*/node_modules/.bin`，这条规则不覆盖，需要递归匹配才能补上，是需要
单独设计的后续工作。**核对结论**：`grande-gpt` 自身当前是单层布局（仓库根一个
`node_modules`，没有 `packages/*/node_modules`），今天不受影响；但这是需要跟着
仓库结构变化持续核对的事——把这条核对记下来，而不是只在代码注释里重复一遍
「不要改语义」就当处理过了。

- [ ] **Step 2: 移植并调整 import**

复制两个文件，改 import 路径指向 `../src/sbpl.ts`。**不要改语义**——除了下面这
一处刻意的加法。

**一处加法（C-5，不改语义）**：`RunOptions` 增加 `onSpawn?: (pgid: number) => void`，
在 `const pgid = child.pid ?? 0;` 之后立即加一行 `if (pgid) o.onSpawn?.(pgid);`。
这不是加固、是给调用方一个同步拿到真实 pgid 的钩子——Task 5 的 `startJob` 需要
它：若把 `pgid: null` 写进 job 行，`reconcileRunningJobs` 会把活着的 job 判成
killed（S0-A 实测复现过）。`runSandboxed` 前半段（realpath、写 profile、spawn）
是同步的，`onSpawn` 在这次函数调用返回的 promise 落地之前就已经同步触发，调用方
不需要 `await` 就能拿到 pgid（细节见 Task 5 的 `startJob` 实现）。

- [ ] **Step 3: 加固 —— 磁盘实际拼写（这道检查属于这里，不属于 Task 2）**

在 `src/sandbox.ts` 里，紧接 `canonicalPaths` 构造之后，对六个字段逐一断言拼写与磁盘一致。
`sbpl.ts` **不动**（它是纯函数，测试要用不存在的假路径；把断言放进 `buildProfile` 会让
移植过来的 11 个用例里 10 个直接崩在 ENOENT 上）。

```typescript
import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * 断言路径的**每一段**都与磁盘上的实际拼写逐字节相同。
 *
 * 为什么不是 `realpathSync(p) === p`：**那个检查抓不到本条要防的东西**（本机实测）。
 * APFS 大小写与 Unicode 归一化不敏感，`realpathSync` 只解符号链接、不改写调用方给的
 * 拼写——目录实为 `MixedCase` 时问 `mixedcase`，原样返回 `mixedcase`，`real === p`
 * 成立、断言通过；NFD 问 NFC 同理。而 Seatbelt 按字节精确匹配 profile 文本里的
 * subpath：拼写不一致会让 allow 规则过严、**deny 规则静默失效**（fail-open）。
 * 逐段跟 `readdirSync` 的结果对，才是规格 §11 说的「取磁盘实际拼写」。
 */
function assertOnDiskSpelling(label: string, p: string): void {
  let cur = p;
  let dir = dirname(cur);
  while (dir !== cur) {
    if (!readdirSync(dir).includes(basename(cur))) {
      throw new Error(
        `SBPL 路径 ${label} 的拼写与磁盘不一致：${dir} 下没有逐字节等于 ` +
          `${JSON.stringify(basename(cur))} 的条目（${p}）。Seatbelt 按字节匹配策略路径，` +
          `拼写不一致会让 deny 规则静默失效（规格 §11）。`,
      );
    }
    cur = dir;
    dir = dirname(cur);
  }
}
```

紧接着 `const canonicalPaths: SandboxPaths = { … };` 之后：

```typescript
  for (const [label, value] of [
    ["worktree", canonicalPaths.worktree], ["canonicalGit", canonicalPaths.canonicalGit],
    ["jobTmp", canonicalPaths.jobTmp], ["controlRoot", canonicalPaths.controlRoot],
    ["worktreesRoot", canonicalPaths.worktreesRoot],
  ] as const) assertOnDiskSpelling(label, value);
  canonicalPaths.execRoots.forEach((r, i) => assertOnDiskSpelling(`execRoots[${i}]`, r));
```

追加到 `tests/sandbox.test.ts`（该文件的路径 fixture 叫 `paths`，在顶层 `beforeEach`
里赋值；下面两个用例复用它，注意从 `node:path` 多 import `basename`/`dirname`）：

```typescript
it("拼写与磁盘不一致的路径被拒，而不是生成一份 deny 规则静默失效的 profile", async () => {
  // APFS 大小写不敏感：这个路径 open() 得开，realpathSync 也原样返回它，
  // 但 Seatbelt 按字节匹配——它对应的 deny 规则会静默失效。
  const wrongCase = join(dirname(paths.worktree), basename(paths.worktree).toUpperCase());
  await expect(
    runSandboxed({ argv: ["/bin/echo", "x"], cwd: paths.worktree,
      paths: { ...paths, worktree: wrongCase }, timeoutMs: 5_000, maxOutputBytes: 4096 }),
  ).rejects.toThrow(/拼写与磁盘不一致/);
});

it("拼写正确的路径正常跑（不能过度拒绝）", async () => {
  const r = await runSandboxed({ argv: ["/bin/echo", "ok"], cwd: paths.worktree,
    paths, timeoutMs: 5_000, maxOutputBytes: 4096 });
  expect(r.exitCode).toBe(0);
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/sandbox.test.ts`
Expected: PASS（移植过来的用例 + 新增 2 个）

**若有用例失败，先判断是移植错误还是本机环境差异**（例如 node 安装位置不同），
在报告里写清楚是哪一种。**不要为了让测试变绿而放宽沙箱规则。**

- [ ] **Step 5: 提交**

```bash
git add src/sandbox.ts tests/sandbox.test.ts
git commit -m "feat(s0-c): 沙箱执行器移植自 spike，加磁盘拼写断言与 onSpawn 钩子"
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