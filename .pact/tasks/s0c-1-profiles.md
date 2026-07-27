# s0c-1-profiles

> 本文件是 **S0C 切片**的第 1 个任务，从
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

### Task 1: Profile 注册表

**Files:**
- Create: `src/profiles.ts`
- Test: `tests/profiles.test.ts`

**Interfaces:**
- Consumes: `Layout`（`configDir`）
- Produces:
  - `class ProfileError extends Error { readonly code: string }`
  - `interface RunProfile { name: string; argv: readonly string[]; timeoutSeconds: number; maxOutputBytes: number; maxRssMb: number }`
  - `function loadProfiles(layout: Layout, repoId: string): Map<string, RunProfile>`
  - `function getProfile(layout: Layout, repoId: string, name: string): RunProfile`
  - `function loadDepDirs(layout: Layout, repoId: string): readonly string[]`（I-6，见下）

**配置形状**（与规格 §6.1 的分歧见下方独立说明），`~/.grande-control/config/profiles.yaml`：

```yaml
depDirs:
  grande-gpt: ["node_modules"]
repos:
  grande-gpt:
    unit:      { argv: ["pnpm", "test"],            timeoutSeconds: 300 }
    lint:      { argv: ["pnpm", "run", "lint"],     timeoutSeconds: 120 }
    typecheck: { argv: ["pnpm", "typecheck"],       timeoutSeconds: 180 }
```

**为什么 profile 必须来自控制平面而不是仓库**（铁律一）：profile 就是「允许执行什么」的
白名单。若从仓库读，仓库里放一个 `profiles.yaml` 就等于任意命令执行 —— 而仓库内容
（包括模型自己刚写进去的内容）按定义是不可信的。

**`depDirs`：为什么需要它，以及为什么不挤进 `repos.<id>.<name>` 那一层（I-6）**：
`git worktree add` 产出的是一份干净 checkout，不含 `node_modules`；S0 全离线
（Global Constraints）意味着新 worktree 里 `pnpm install` 跑不通——`pnpm test`
这个最现实的 profile 会在**每一个** worktree 里失败。跑不了自己项目测试套件的
runner 不能算交付。`depDirs` 因此单独占一个与 `repos` 平级的顶层键
（`depDirs.<repoId>` → 字符串数组），而不是塞进 `repos.<repoId>` 之下与 profile
名字共用同一层命名空间——`loadProfiles` 把 `repos.<repoId>` 下每一个键都当 profile
名解析，`depDirs` 若挤在那一层会被当成一个 profile 尝试解析，报出一个跟真实配置
错误无关的 `BAD_CONFIG`。实际克隆动作在 Task 4 的 `openWorktree` 里做（`cloneDepDirs`），
这里只负责把列表从配置里读出来。

**与规格 §6.1 的形状分歧（记录，不修正）**：§6.1 写的是 `repos.<id>.profiles.<name>`
（profile 嵌一层 `profiles` 键，整份配置嵌在 `repos.yaml` 里）；这里用的是扁平的
`repos.<id>.<name>`、单独一份 `profiles.yaml`。**这是故意的、更好的选择**——S0-A 的
`repos.yaml` 是一个列表（`repos: [{repoId, path, registered}, …]`，见 `src/registry.ts`），
不是映射，没法再嵌一层 `repos.<id>.profiles.<name>` 而不破坏既有 schema。但 **S0-D
会按 §6.1 的形状去找 profile**，这里必须显式记录分歧，否则 S0-D 实现时会读错文件、
读错层级。

另外，规格 §6.1 规则 3 的 `argSchema` / `{{file}}` 参数化未在本切片实现——本切片的
profile 只有裸 `argv`，不支持模型在调用时传参替换。S0-D 若要开放这类能力需要
单独设计。

- [ ] **Step 1: 写失败测试**

`tests/profiles.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { getProfile, loadDepDirs, loadProfiles } from "../src/profiles.ts";

let ws: string, ctrl: string, savedWs: string | undefined, savedCtrl: string | undefined;

function writeConfig(body: string) {
  const l = loadLayout();
  ensureLayout(l);
  writeFileSync(join(l.configDir, "profiles.yaml"), body, "utf8");
  return l;
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "prof-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "prof-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});
afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("loadProfiles()", () => {
  it("按 repoId 加载该仓库的 profile", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300 }\n');
    const m = loadProfiles(l, "demo");
    expect(m.get("unit")?.argv).toEqual(["pnpm", "test"]);
    expect(m.get("unit")?.timeoutSeconds).toBe(300);
    expect(m.get("unit")?.name).toBe("unit");
  });

  it("maxOutputBytes 与 maxRssMb 省略时落回默认值", () => {
    // I-3：maxRssMb 此前根本不存在于 RunProfile，RSS 轮询兜底因此永远拿不到
    // 上限、RESOURCE_EXHAUSTED 这条路径不可达（实测复现）。
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300 }\n');
    const p = loadProfiles(l, "demo").get("unit")!;
    expect(p.maxOutputBytes).toBeGreaterThan(0);
    expect(p.maxRssMb).toBeGreaterThan(0);
  });

  it("仓库之间互不可见：demo 的 profile 不会出现在 other 里", () => {
    // 这一条不是形式主义——两个仓库共用一份配置文件，若按 repoId 过滤写错，
    // 一个仓库就能跑另一个仓库注册的命令。
    const l = writeConfig(
      'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n' +
      '  other:\n    build: { argv: ["b"], timeoutSeconds: 10 }\n',
    );
    expect([...loadProfiles(l, "demo").keys()]).toEqual(["unit"]);
    expect([...loadProfiles(l, "other").keys()]).toEqual(["build"]);
  });

  it("配置文件不存在时返回空表，而不是抛错", () => {
    const l = loadLayout();
    ensureLayout(l);
    expect(loadProfiles(l, "demo").size).toBe(0);
  });

  it.each([
    ['repos:\n  demo:\n    unit: { argv: "pnpm test", timeoutSeconds: 10 }\n', "argv 必须是数组（字符串会被当成 shell 拼接，铁律二禁止）"],
    ['repos:\n  demo:\n    unit: { argv: [], timeoutSeconds: 10 }\n', "argv 不能为空"],
    ['repos:\n  demo:\n    unit: { argv: ["a", 1], timeoutSeconds: 10 }\n', "argv 每一项必须是字符串"],
    ['repos:\n  demo:\n    unit: { argv: ["a"] }\n', "缺 timeoutSeconds"],
    ['repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 0 }\n', "timeoutSeconds 必须为正"],
    ['repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 99999 }\n', "timeoutSeconds 超过上限"],
    ['repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10, maxRssMb: -1 }\n', "maxRssMb 必须为正"],
    ['repos: 42\n', "repos 必须是映射"],
  ])("非法配置响亮地失败：%s", (body) => {
    const l = writeConfig(body);
    expect(() => loadProfiles(l, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("绝不从仓库内读（铁律一）：仓库里放同名文件不产生任何影响", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["real"], timeoutSeconds: 10 }\n');
    const repo = join(l.workspaceRoot, "demo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "profiles.yaml"), 'repos:\n  demo:\n    evil: { argv: ["curl"], timeoutSeconds: 10 }\n', "utf8");
    const m = loadProfiles(l, "demo");
    expect(m.has("evil")).toBe(false);
    expect(m.get("unit")?.argv).toEqual(["real"]);
  });
});

describe("getProfile()", () => {
  it("未注册的 profile 抛 PROFILE_NOT_FOUND，且错误信息列出可用的 profile", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n    lint: { argv: ["b"], timeoutSeconds: 10 }\n');
    try {
      getProfile(l, "demo", "nope");
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as { code: string }).code).toBe("PROFILE_NOT_FOUND");
      // 干巴巴报错对模型没用——它需要知道能选什么
      expect((e as Error).message).toContain("unit");
      expect((e as Error).message).toContain("lint");
    }
  });

  it("已注册的 profile 正常返回", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n');
    expect(getProfile(l, "demo", "unit").argv).toEqual(["a"]);
  });
});

describe("loadDepDirs()", () => {
  it("未声明 depDirs 时返回空数组", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n');
    expect(loadDepDirs(l, "demo")).toEqual([]);
  });

  it("按 repoId 返回声明的目录列表", () => {
    const l = writeConfig(
      'depDirs:\n  demo: ["node_modules"]\n' +
      'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
    );
    expect(loadDepDirs(l, "demo")).toEqual(["node_modules"]);
  });

  it("depDirs 不是字符串数组时响亮失败", () => {
    const l = writeConfig(
      'depDirs:\n  demo: "node_modules"\n' +
      'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
    );
    expect(() => loadDepDirs(l, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("depDirs 是独立命名空间，不会被 loadProfiles 当成一个 profile（否则会报一个跟真实错误无关的 BAD_CONFIG）", () => {
    const l = writeConfig(
      'depDirs:\n  demo: ["node_modules"]\n' +
      'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
    );
    expect([...loadProfiles(l, "demo").keys()]).toEqual(["unit"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/profiles.test.ts`
Expected: FAIL —— `Cannot find module '../src/profiles.ts'`

- [ ] **Step 3: 实现**

`src/profiles.ts`：

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";

export class ProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `ProfileError [${code}]`;
    this.code = code;
  }
}

export interface RunProfile {
  name: string;
  argv: readonly string[];
  timeoutSeconds: number;
  maxOutputBytes: number;
  maxRssMb: number;
}

/** 墙钟超时是唯一可靠的资源兜底（规格 §6.5），上限防止一个笔误挂住 job 一整天 */
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** RSS 轮询兜底的默认上限（「已接受的风险」：轮询不是 cgroup，这只是尽力而为的兜底） */
const DEFAULT_MAX_RSS_MB = 4096;

/**
 * 加载某仓库的 run profile。
 *
 * **只从控制平面读**（铁律一）。profile 是「允许执行什么」的白名单；若从仓库读，
 * 仓库里放一个 profiles.yaml 就等于任意命令执行 —— 而仓库内容（包括模型自己刚写
 * 进去的）按定义不可信。
 */
export function loadProfiles(layout: Layout, repoId: string): Map<string, RunProfile> {
  const file = join(layout.configDir, "profiles.yaml");
  const out = new Map<string, RunProfile>();
  if (!existsSync(file)) return out;

  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ProfileError("BAD_CONFIG", `无法解析 ${file}：${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return out;
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ProfileError("BAD_CONFIG", `${file} 顶层必须是映射`);
  }
  const repos = (doc as { repos?: unknown }).repos;
  if (repos === undefined) return out;
  if (typeof repos !== "object" || repos === null || Array.isArray(repos)) {
    throw new ProfileError("BAD_CONFIG", `${file} 的 repos 必须是映射，实际是 ${typeof repos}`);
  }

  const forRepo = (repos as Record<string, unknown>)[repoId];
  if (forRepo === undefined) return out;
  if (typeof forRepo !== "object" || forRepo === null || Array.isArray(forRepo)) {
    throw new ProfileError("BAD_CONFIG", `${file} 中 repos.${repoId} 必须是映射`);
  }

  for (const [name, raw] of Object.entries(forRepo as Record<string, unknown>)) {
    const where = `${file} 中 repos.${repoId}.${name}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ProfileError("BAD_CONFIG", `${where} 必须是映射`);
    }
    const { argv, timeoutSeconds, maxOutputBytes, maxRssMb } = raw as Record<string, unknown>;

    if (!Array.isArray(argv)) {
      throw new ProfileError(
        "BAD_CONFIG",
        `${where} 的 argv 必须是数组。字符串会被当成 shell 命令拼接，而 argv 永远是数组、` +
          `绝不拼 shell 字符串（铁律二）。`,
      );
    }
    if (argv.length === 0) throw new ProfileError("BAD_CONFIG", `${where} 的 argv 不能为空`);
    for (const a of argv) {
      if (typeof a !== "string") throw new ProfileError("BAD_CONFIG", `${where} 的 argv 每一项必须是字符串`);
    }
    if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new ProfileError("BAD_CONFIG", `${where} 的 timeoutSeconds 必须是正整数`);
    }
    if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new ProfileError("BAD_CONFIG", `${where} 的 timeoutSeconds 超过上限 ${MAX_TIMEOUT_SECONDS}`);
    }
    if (maxOutputBytes !== undefined && (typeof maxOutputBytes !== "number" || maxOutputBytes <= 0)) {
      throw new ProfileError("BAD_CONFIG", `${where} 的 maxOutputBytes 必须是正数`);
    }
    // 与 maxOutputBytes 同一种校验形状：省略即用默认值，给了就必须是正数（I-3）。
    // maxRssMb 此前根本不存在于这个接口，RSS 轮询兜底（sandbox.ts 已经实现）因此
    // 永远拿不到调用方设置的上限，RESOURCE_EXHAUSTED 这条路径永远不可达。
    if (maxRssMb !== undefined && (typeof maxRssMb !== "number" || maxRssMb <= 0)) {
      throw new ProfileError("BAD_CONFIG", `${where} 的 maxRssMb 必须是正数`);
    }

    out.set(name, {
      name,
      argv: argv as string[],
      timeoutSeconds,
      maxOutputBytes: (maxOutputBytes as number | undefined) ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxRssMb: (maxRssMb as number | undefined) ?? DEFAULT_MAX_RSS_MB,
    });
  }
  return out;
}

/** 取一个 profile；不存在时的错误信息列出可选项 —— 干巴巴报错对模型没用 */
export function getProfile(layout: Layout, repoId: string, name: string): RunProfile {
  const all = loadProfiles(layout, repoId);
  const p = all.get(name);
  if (p) return p;
  const available = [...all.keys()].sort();
  throw new ProfileError(
    "PROFILE_NOT_FOUND",
    available.length === 0
      ? `仓库 ${repoId} 没有注册任何 run profile。请在 ${join(layout.configDir, "profiles.yaml")} 中注册。`
      : `仓库 ${repoId} 没有名为 ${name} 的 profile。可用：${available.join("、")}`,
  );
}

/**
 * 某仓库在新 worktree 里需要克隆的依赖目录（相对仓库根，如 `node_modules`）。
 *
 * **独立于 `repos.<repoId>.<profileName>` 存放**（顶层 `depDirs.<repoId>`），
 * 不与 profile 名字共用同一层命名空间——`loadProfiles` 把 `repos.<repoId>` 下每一个
 * 键都当 profile 名解析，若 `depDirs` 也挤在那一层，会被当成一个 profile 尝试解析，
 * 报出一个跟真实配置错误无关的 `BAD_CONFIG`。
 *
 * **为什么这个函数存在**（I-6）：`git worktree add` 产出的是一份干净 checkout，
 * 不含 `node_modules`；S0 全离线（Global Constraints），新 worktree 里 `pnpm install`
 * 跑不通——`pnpm test` 这个最现实的 profile 会在每一个 worktree 里失败。跑不了
 * 自己项目测试套件的 runner 不能算交付，因此 Task 4 的 `openWorktree` 会用这里
 * 返回的列表逐个把 canonical 里已经存在的目录克隆进新 worktree
 * （见 Task 4 `cloneDepDirs`）。
 */
export function loadDepDirs(layout: Layout, repoId: string): readonly string[] {
  const file = join(layout.configDir, "profiles.yaml");
  if (!existsSync(file)) return [];

  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ProfileError("BAD_CONFIG", `无法解析 ${file}：${(e as Error).message}`);
  }
  if (doc === null || doc === undefined || typeof doc !== "object" || Array.isArray(doc)) return [];

  const depDirs = (doc as { depDirs?: unknown }).depDirs;
  if (depDirs === undefined) return [];
  if (typeof depDirs !== "object" || depDirs === null || Array.isArray(depDirs)) {
    throw new ProfileError("BAD_CONFIG", `${file} 的 depDirs 必须是映射（repoId → 字符串数组）`);
  }

  const forRepo = (depDirs as Record<string, unknown>)[repoId];
  if (forRepo === undefined) return [];
  if (!Array.isArray(forRepo) || forRepo.some((d) => typeof d !== "string")) {
    throw new ProfileError("BAD_CONFIG", `${file} 中 depDirs.${repoId} 必须是字符串数组`);
  }
  return forRepo as string[];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/profiles.test.ts`
Expected: PASS（19 个用例：loadProfiles 3 + 1 + 8(it.each) + 1 = 13，getProfile 2，loadDepDirs 4）

- [ ] **Step 5: 提交**

```bash
git add src/profiles.ts tests/profiles.test.ts
git commit -m "feat(s0-c): run profile 注册表，只从控制平面加载"
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