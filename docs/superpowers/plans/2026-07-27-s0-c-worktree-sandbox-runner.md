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

### Task 2: SBPL 生成器 —— 从 spike 移植并加固

**Files:**
- Create: `src/sbpl.ts`（**移植自 `spike/src/sbpl.ts`**）
- Test: `tests/sbpl.test.ts`（移植自 `spike/tests/sbpl.test.ts`）

**Interfaces:**
- Produces: `interface SandboxPaths { worktree; canonicalGit; jobTmp; controlRoot; worktreesRoot; execRoots: string[] }`
  与 `function buildProfile(p: SandboxPaths): string`

**这是移植，不是重写。** `spike/src/sbpl.ts` 已经过 U2 spike 的四轮审查加固，
每一条规则都做过最小性证明（`spike/findings/U2-seatbelt.md`）。**重新推导等于重新
引入那些已经被抓出来的 bug。**

**本任务不加「磁盘实际拼写」断言**（C-2）——那道检查（规格 §11 记录的 S0-A 审查
发现）放在 Task 3（`src/sandbox.ts`）里做。原因：`buildProfile` 是纯函数，
`tests/sbpl.test.ts` 移植过来的用例大量使用形如 `/W/demo/.git` 这样刻意不存在于
磁盘上的假路径来验证生成逻辑；把「路径必须在磁盘上真实存在且拼写一致」的断言
塞进 `buildProfile`，会让这 11 个用例里的大多数在到达它们真正要测的断言之前就先
撞上 `ENOENT` 崩溃（实测：11 个里 10 个）。真正需要文件系统的地方是
`sandbox.ts`——`runSandboxed` 已经在调用 `buildProfile` 之前对六个路径字段做
`realpathSync`，拼写检查天然属于那一层，而不是这一层。

- [ ] **Step 1: 阅读源文件与既有结论**

先读这三个文件，理解每条规则为什么存在：
- `spike/src/sbpl.ts`
- `spike/tests/sbpl.test.ts`
- `spike/findings/U2-seatbelt.md`

**其中三条结论务必内化：**
1. **Seatbelt 按「最具体规则优先」裁决，与书写顺序无关。** `deny (subpath X)` 写在
   `allow file-read*` 之前或之后，X 都被拒。
2. **`sandbox-exec` 在真实文件操作里解析符号链接，但【不】解析 profile 文本里的
   `subpath`。** 未 canonical 化的路径会让 allow 规则过严、**deny 规则静默失效**
   —— fail-open，最危险的失败方向。
3. **`(allow signal (target same-sandbox))` 不可省** —— 缺它会导致约 19 倍的减速。

- [ ] **Step 2: 移植文件**

把 `spike/src/sbpl.ts` 复制到 `src/sbpl.ts`，`spike/tests/sbpl.test.ts` 复制到
`tests/sbpl.test.ts`，调整 import 路径。**不要改任何规则的语义，也不要在这里加
canonical / 磁盘拼写断言**（见上，属于 Task 3）。

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run tests/sbpl.test.ts`
Expected: PASS（11 个用例，与 `spike/tests/sbpl.test.ts` 原样一致）

- [ ] **Step 4: 提交**

```bash
git add src/sbpl.ts tests/sbpl.test.ts
git commit -m "feat(s0-c): SBPL 生成器移植自 spike"
```

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
