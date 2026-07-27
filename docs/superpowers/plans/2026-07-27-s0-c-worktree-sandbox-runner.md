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
  message 不含码前缀）。本切片的码：`PROFILE_NOT_FOUND` / `JOB_TIMEOUT` /
  `RESOURCE_EXHAUSTED` / `NETWORK_DENIED` / `WORKTREE_DIRTY` / `CANONICAL_BUSY`。
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
  - `interface RunProfile { name: string; argv: readonly string[]; timeoutSeconds: number; maxOutputBytes: number }`
  - `function loadProfiles(layout: Layout, repoId: string): Map<string, RunProfile>`
  - `function getProfile(layout: Layout, repoId: string, name: string): RunProfile`

**配置形状**（规格 §6.1），`~/.grande-control/config/profiles.yaml`：

```yaml
repos:
  grande-gpt:
    unit:      { argv: ["pnpm", "test"],            timeoutSeconds: 300 }
    lint:      { argv: ["pnpm", "run", "lint"],     timeoutSeconds: 120 }
    typecheck: { argv: ["pnpm", "typecheck"],       timeoutSeconds: 180 }
```

**为什么 profile 必须来自控制平面而不是仓库**（铁律一）：profile 就是「允许执行什么」的
白名单。若从仓库读，仓库里放一个 `profiles.yaml` 就等于任意命令执行 —— 而仓库内容
（包括模型自己刚写进去的内容）按定义是不可信的。

- [ ] **Step 1: 写失败测试**

`tests/profiles.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { getProfile, loadProfiles } from "../src/profiles.ts";

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
}

/** 墙钟超时是唯一可靠的资源兜底（规格 §6.5），上限防止一个笔误挂住 job 一整天 */
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

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
    const { argv, timeoutSeconds, maxOutputBytes } = raw as Record<string, unknown>;

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

    out.set(name, {
      name,
      argv: argv as string[],
      timeoutSeconds,
      maxOutputBytes: (maxOutputBytes as number | undefined) ?? DEFAULT_MAX_OUTPUT_BYTES,
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/profiles.test.ts`
Expected: PASS（10 + 2 = 12 个用例）

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
`tests/sbpl.test.ts`，调整 import 路径。**不要改任何规则的语义。**

- [ ] **Step 3: 加固 —— 磁盘实际拼写**

规格 §11 记录的 S0-A 审查发现：`realpathSync` **不改写调用方给的拼写**
（目录实为 `MixedCase` 时问 `mixedcase` 返回 `mixedcase`；问 NFD 返回 NFD）。
而 Seatbelt 按字节精确匹配 —— 拼写不一致会让 deny 规则静默失效。

在 `buildProfile` 开头加一道断言：所有路径必须已是 canonical 形式，否则抛错。

```typescript
import { realpathSync } from "node:fs";

/**
 * 断言路径已 canonical。
 *
 * 这不是洁癖：Seatbelt 按字节精确匹配 profile 文本里的 subpath，而 macOS 文件系统
 * 大小写与 Unicode 归一化不敏感、`realpathSync` 又不改写调用方给的拼写。
 * 拼写不一致的后果是 **deny 规则静默失效**（fail-open）——
 * spike U2 实测过这个陷阱的另一个版本。宁可在这里响亮地失败。
 */
function assertCanonical(label: string, p: string): void {
  let real: string;
  try {
    real = realpathSync(p);
  } catch (e) {
    throw new Error(`SBPL 路径 ${label} 无法解析：${p}（${(e as Error).message}）`);
  }
  if (real !== p) {
    throw new Error(
      `SBPL 路径 ${label} 不是 canonical 形式：给的是 ${p}，磁盘上是 ${real}。` +
        `Seatbelt 按字节匹配策略路径，拼写不一致会让 deny 规则静默失效。`,
    );
  }
}
```

在 `buildProfile` 里对 `worktree` / `canonicalGit` / `jobTmp` / `controlRoot` /
`worktreesRoot` 逐一调用（`execRoots` 逐项调用）。

- [ ] **Step 4: 加固的测试**

追加到 `tests/sbpl.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";

it("非 canonical 的路径被拒绝，而不是生成一份 deny 规则静默失效的 profile", () => {
  const real = mkdtempSync(join(tmpdir(), "sbpl-real-"));
  const linkDir = mkdtempSync(join(tmpdir(), "sbpl-link-"));
  const link = join(linkDir, "alias");
  symlinkSync(real, link);
  try {
    expect(() => buildProfile({ ...basePaths, worktree: link })).toThrow(/canonical/);
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
  }
});

it("canonical 的路径正常生成（不能过度拒绝）", () => {
  expect(() => buildProfile(basePaths)).not.toThrow();
  expect(buildProfile(basePaths)).toContain("deny network*");
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/sbpl.test.ts`
Expected: PASS（移植过来的用例 + 新增 2 个）

- [ ] **Step 6: 提交**

```bash
git add src/sbpl.ts tests/sbpl.test.ts
git commit -m "feat(s0-c): SBPL 生成器移植自 spike，加 canonical 路径断言"
```

---

### Task 3: 沙箱执行器 —— 从 spike 移植

**Files:**
- Create: `src/sandbox.ts`（**移植自 `spike/src/sandbox.ts`**）
- Test: `tests/sandbox.test.ts`（移植自 `spike/tests/sandbox.test.ts`）

**Interfaces:**
- Consumes: `buildProfile`、`SandboxPaths`（Task 2）
- Produces: `interface RunOptions`、`interface RunResult`、
  `function runSandboxed(o: RunOptions): Promise<RunResult>`、`function defaultExecRoots(): string[]`

**同样是移植。** `spike/src/sandbox.ts` 已过四轮审查，修掉过四个真实缺陷：
exec 放行清单漏了本机 node 的安装位置、进程组 kill 的测试是假的、`kill(-0)` 的
杀伤半径、以及 **PATH 与 execRoots 两处独立硬编码导致分叉**（pnpm 的
`#!/usr/bin/env node` shebang 因此 exit 127）。

- [ ] **Step 1: 阅读源文件**

读 `spike/src/sandbox.ts` 与 `spike/tests/sandbox.test.ts`。
**注意 PATH 必须从 `execRoots` 派生**，不得另行硬编码 —— 那正是被修掉的缺陷。

- [ ] **Step 2: 移植并调整 import**

复制两个文件，改 import 路径指向 `../src/sbpl.ts`。**不要改语义。**

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm vitest run tests/sandbox.test.ts`
Expected: PASS

**若有用例失败，先判断是移植错误还是本机环境差异**（例如 node 安装位置不同），
在报告里写清楚是哪一种。**不要为了让测试变绿而放宽沙箱规则。**

- [ ] **Step 4: 提交**

```bash
git add src/sandbox.ts tests/sandbox.test.ts
git commit -m "feat(s0-c): 沙箱执行器移植自 spike"
```

---

### Task 4: worktree 生命周期与 `grande_diff`

**Files:**
- Create: `src/worktree.ts`
- Test: `tests/worktree.test.ts`

**Interfaces:**
- Consumes: `Layout`、`resolveRepoPath`、`registeredIds`、`assertValidId`
- Produces:
  - `class GitError extends Error { readonly code: string }`
  - `interface WorktreeInfo { taskId: string; branch: string; baseCommit: string; worktreePath: string }`
  - `function openWorktree(layout: Layout, repoId: string, slug: string, taskId: string): WorktreeInfo`
  - `function removeWorktree(layout: Layout, info: { repoId: string; worktreePath: string }): void`
  - `function listChangedFiles(worktreePath: string, baseCommit: string): string[]`
  - `interface DiffResult { truncated: boolean; nextCursor: string | null; files: { path: string; hunks: string }[] }`
  - `function repoDiff(worktreePath: string, baseCommit: string, opts?: { maxLines?: number; cursor?: string | null }): DiffResult`

**关键约束：**
- **绝不 `git fetch`**（规格 §5.4①）—— 大仓库上会直接撑爆 ChatGPT 的 ~60s 超时。
  base 就取本机当前 `HEAD`。
- **git 一律用 argv 数组调用**（`execFileSync`），绝不拼 shell 字符串（铁律二）。
- 分支名 `grande/<slug>-<taskId 后 4 位>`（规格 §5.2）。
- diff 上限 400 行（规格 §5.4②），按文件分页。

- [ ] **Step 1: 写失败测试**

`tests/worktree.test.ts`：

```typescript
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { listChangedFiles, openWorktree, removeWorktree, repoDiff } from "../src/worktree.ts";

let ws: string, ctrl: string, layout: Layout, repo: string;
let savedWs: string | undefined, savedCtrl: string | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

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
    expect(info.worktreePath.startsWith(layout.worktreesRoot)).toBe(true);
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

  it("canonical 处于 rebase 中时拒绝开新任务", () => {
    mkdirSync(join(repo, ".git", "rebase-merge"), { recursive: true });
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).toThrow(
      expect.objectContaining({ code: "CANONICAL_BUSY" }),
    );
  });

  it("绝不执行 git fetch（规格 §5.4①：大仓库上会撑爆 60s 超时）", () => {
    // 用一个没有 remote 的仓库：若实现里有 fetch，git 会报错而不是静默成功
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).not.toThrow();
  });
});

describe("listChangedFiles() 与 repoDiff()", () => {
  it("无改动时返回空", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    expect(listChangedFiles(info.worktreePath, info.baseCommit)).toEqual([]);
    expect(repoDiff(info.worktreePath, info.baseCommit).files).toEqual([]);
  });

  it("列出已改与新增的文件，顺序确定", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "a.ts"), "v2\n", "utf8");
    writeFileSync(join(info.worktreePath, "z.ts"), "new\n", "utf8");
    writeFileSync(join(info.worktreePath, "b.ts"), "new\n", "utf8");
    const files = listChangedFiles(info.worktreePath, info.baseCommit);
    expect(files).toEqual(["a.ts", "b.ts", "z.ts"]);
    expect(files).toEqual([...files].sort());
  });

  it("diff 含实际改动内容", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "a.ts"), "v2\n", "utf8");
    const d = repoDiff(info.worktreePath, info.baseCommit);
    expect(d.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(d.files[0]!.hunks).toContain("+v2");
    expect(d.files[0]!.hunks).toContain("-v1");
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
    removeWorktree(layout, { repoId: "demo", worktreePath: info.worktreePath });
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(() => git(repo, "status", "--short")).not.toThrow();
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
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./layout.ts";
import { assertValidId, resolveRepoPath } from "./paths.ts";
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
 * canonical 是否处于不适合派生 worktree 的状态。
 *
 * 这些状态下建 worktree 会留下难以理解的现场，而用户此刻正在手动处理某件事 ——
 * 拒绝比「帮忙」更有用。
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
}

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

  return { taskId, branch, baseCommit, worktreePath: realpathSync(dir) };
}

/** 移除 worktree。用 `--force` 是因为里面必然有未提交改动（S0 不做 commit） */
export function removeWorktree(layout: Layout, info: { repoId: string; worktreePath: string }): void {
  const repoRoot = resolveRepoPath(layout, info.repoId, registeredIds(layout));
  git(repoRoot, ["worktree", "remove", "--force", info.worktreePath]);
}

/** worktree 相对 base 改动过的文件，排序后返回（顺序必须确定） */
export function listChangedFiles(worktreePath: string, baseCommit: string): string[] {
  const tracked = git(worktreePath, ["diff", "--name-only", baseCommit]).split("\n");
  const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard"]).split("\n");
  return [...new Set([...tracked, ...untracked])].filter((s) => s.length > 0).sort();
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
    // 对未跟踪文件 `git diff <base> -- <path>` 是空的，用 --no-index 与 /dev/null 比
    let hunks: string;
    try {
      hunks = git(worktreePath, ["diff", baseCommit, "--", p]);
      if (hunks.length === 0) {
        hunks = git(worktreePath, ["diff", "--no-index", "--", "/dev/null", p]);
      }
    } catch {
      // --no-index 在有差异时以非零退出，这是它的正常行为
      hunks = "";
    }
    const n = hunks.split("\n").length;
    // 至少给出一个文件，否则单个超大文件会导致永远返回空、cursor 原地踏步
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
Expected: PASS（7 + 5 + 1 = 13 个用例）

- [ ] **Step 5: 承重性验证**

去掉 `listChangedFiles` 末尾的 `.sort()`，确认「顺序确定」那条变红；还原后确认变绿。
再去掉 `repoDiff` 里的 `files.length > 0 &&` 守卫，构造一个超过 `maxLines` 的单文件，
确认它会返回空 `files` 且 cursor 不前进（这一条如果现有测试抓不到，**补一个**）。
**把两次观察都写进报告。**

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
- Consumes: `getProfile`（Task 1）、`runSandboxed` / `defaultExecRoots`（Task 3）、
  `SandboxPaths`（Task 2）、`createJob` / `finishJob` / `getJob`（S0-A）、`Layout`
- Produces:
  - `interface StartedJob { jobId: string; state: "running"; pollAfterSeconds: number }`
  - `function startJob(deps: RunnerDeps, a: { taskId; repoId; worktreePath; profileName }): StartedJob`
  - `interface JobReport { state: JobState; exitCode: number | null; truncated: boolean; summary: string; artifactPath: string | null }`
  - `function jobReport(db: DatabaseSync, layout: Layout, jobId: string): JobReport`
  - `interface RunnerDeps { db: DatabaseSync; layout: Layout }`

**核心约束：`startJob` 必须 < 1s 返回**（规格 §5.4①）。它启动子进程后**立刻**
落 job 行并返回，实际执行在后台继续；完成时由回调调 `finishJob`。

- [ ] **Step 1: 写失败测试**

`tests/runner.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { getJob } from "../src/jobs.ts";
import { createTask } from "../src/tasks.ts";
import { jobReport, startJob } from "../src/runner.ts";

let ws: string, ctrl: string, layout: Layout, db: ReturnType<typeof openDb>, wt: string;
let savedWs: string | undefined, savedCtrl: string | undefined;

const waitFor = async (p: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!p()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 100));
  }
};

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

  wt = join(layout.worktreesRoot, "demo", "task_abcd");
  mkdirSync(wt, { recursive: true });
  createTask(db, {
    taskId: "task_abcd", repoId: "demo", branch: "grande/x-abcd",
    baseCommit: "0".repeat(40), worktreePath: wt, state: "READY",
  });
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    'repos:\n  demo:\n' +
    '    ok:   { argv: ["/bin/sh", "-c", "echo hello; exit 0"], timeoutSeconds: 30 }\n' +
    '    fail: { argv: ["/bin/sh", "-c", "echo boom >&2; exit 3"], timeoutSeconds: 30 }\n' +
    '    slow: { argv: ["/bin/sh", "-c", "sleep 60"], timeoutSeconds: 2 }\n',
    "utf8",
  );
});

afterEach(() => {
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
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "slow" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.state).toBe("running");
    expect(s.jobId).toMatch(/^job_/);
    expect(s.pollAfterSeconds).toBeGreaterThan(0);
    expect(getJob(db, s.jobId)?.state).toBe("running");
  });

  it("成功的命令最终收敛为 passed，exitCode 为 0", async () => {
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "ok" });
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.state).toBe("passed");
    expect(j.exitCode).toBe(0);
  });

  it("失败的命令收敛为 failed，并保留真实 exitCode", async () => {
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "fail" });
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.state).toBe("failed");
    expect(j.exitCode).toBe(3);
  });

  it("超时收敛为 timeout 而不是 failed（两者对模型意味着不同的下一步）", async () => {
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "slow" });
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    expect(getJob(db, s.jobId)!.state).toBe("timeout");
  });

  it("完整输出落 artifact，路径在控制平面之下（不在工作区）", async () => {
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "ok" });
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.artifactPath).not.toBeNull();
    expect(j.artifactPath!.startsWith(layout.controlRoot)).toBe(true);
    expect(j.artifactPath!.startsWith(layout.workspaceRoot)).toBe(false);
    expect(readFileSync(j.artifactPath!, "utf8")).toContain("hello");
  });

  it("未注册的 profile 抛 PROFILE_NOT_FOUND，且【不】留下 running 的 job 行", async () => {
    expect(() =>
      startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "nope" }),
    ).toThrow(expect.objectContaining({ code: "PROFILE_NOT_FOUND" }));
    // 校验必须发生在建 job 行【之前】，否则会留下永远不会收敛的僵尸 job
    const rows = db.prepare("SELECT COUNT(*) AS n FROM job").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("jobReport()", () => {
  it("running 的 job 报告 running，且不假装有结果", () => {
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "slow" });
    const r = jobReport(db, layout, s.jobId);
    expect(r.state).toBe("running");
    expect(r.exitCode).toBeNull();
  });

  it("结束后给出摘要，尾部日志被截断且显式标记", async () => {
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "fail" });
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const r = jobReport(db, layout, s.jobId);
    expect(r.state).toBe("failed");
    expect(r.summary).toContain("boom");
    expect(typeof r.truncated).toBe("boolean");
  });

  it("字段声明顺序：truncated 排在 summary 之前", async () => {
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "ok" });
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const keys = Object.keys(jobReport(db, layout, s.jobId));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("summary"));
  });

  it("不存在的 jobId 抛 JOB_NOT_FOUND", () => {
    expect(() => jobReport(db, layout, "job_nope")).toThrow(
      expect.objectContaining({ code: "JOB_NOT_FOUND" }),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/runner.test.ts`
Expected: FAIL —— `Cannot find module '../src/runner.ts'`

- [ ] **Step 3: 实现**

`src/runner.ts`：

```typescript
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { truncateText } from "./envelope.ts";
import type { Layout } from "./layout.ts";
import { createJob, finishJob, getJob, type JobState } from "./jobs.ts";
import { getProfile } from "./profiles.ts";
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
 * 启动一个 job，**立刻返回**。
 *
 * ChatGPT 的工具调用 ~60s 超时不可配置（规格 §5.4①），同步等待跑测试必然撞墙。
 * 因此本函数只负责：校验 → 落 job 行 → 启动子进程 → 返回。实际执行在后台继续，
 * 结束时回调 `finishJob`。
 *
 * **校验必须在建 job 行之前完成**，否则一个 profile 名打错就会留下一条永远不会
 * 收敛的 running 记录。
 */
export function startJob(
  deps: RunnerDeps,
  a: { taskId: string; repoId: string; worktreePath: string; profileName: string },
): StartedJob {
  const { db, layout } = deps;

  // 先校验——抛错时不能留下任何痕迹
  const profile = getProfile(layout, a.repoId, a.profileName);
  const worktree = realpathSync(a.worktreePath);
  const canonicalGit = join(realpathSync(join(layout.workspaceRoot, a.repoId)), ".git");

  const jobId = `job_${randomUUID()}`;
  const jobTmp = join(layout.derivedRoot, "tmp", jobId);
  mkdirSync(join(jobTmp, "home"), { recursive: true });

  const artifactDir = join(layout.artifactsDir, a.taskId, jobId);
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, "output.log");

  createJob(db, {
    jobId,
    taskId: a.taskId,
    profile: profile.name,
    argv: [...profile.argv],
    pgid: null,
  });

  void runSandboxed({
    argv: [...profile.argv],
    cwd: worktree,
    paths: {
      worktree,
      canonicalGit,
      jobTmp: realpathSync(jobTmp),
      controlRoot: layout.controlRoot,
      worktreesRoot: realpathSync(layout.worktreesRoot),
      execRoots: defaultExecRoots(),
    },
    timeoutMs: profile.timeoutSeconds * 1000,
    maxOutputBytes: profile.maxOutputBytes,
  })
    .then((r) => {
      writeFileSync(artifactPath, `${r.stdout}\n--- stderr ---\n${r.stderr}\n`, "utf8");
      const state: Exclude<JobState, "running"> =
        r.killedBy === "timeout" ? "timeout" : r.exitCode === 0 ? "passed" : "failed";
      // finishJob 有 CAS，返回 undefined 表示这次调用输给了竞争者（例如崩溃恢复
      // 已经把这条判成 killed）。那种情况下【不要】覆盖——真实结果已经有归属了。
      finishJob(db, jobId, {
        state,
        exitCode: r.exitCode,
        artifactPath,
        summary: { truncated: r.truncated, killedBy: r.killedBy ?? null },
      });
    })
    .catch((e: unknown) => {
      writeFileSync(artifactPath, `runner 内部错误：${(e as Error).message}\n`, "utf8");
      finishJob(db, jobId, {
        state: "killed",
        exitCode: null,
        artifactPath,
        summary: { error: (e as Error).message },
      });
    });

  return { jobId, state: "running", pollAfterSeconds: pollHint(profile.timeoutSeconds) };
}

export interface JobReport {
  truncated: boolean;
  state: JobState;
  exitCode: number | null;
  artifactPath: string | null;
  summary: string;
}

/** 摘要给模型看的尾部行数（规格 §5.4②：失败用例名 + 关键堆栈 + 尾部 40 行） */
const TAIL_LINES = 40;
const SUMMARY_MAX_BYTES = 8 * 1024;

/**
 * 生成给模型看的 job 报告。完整日志留在 artifact，这里只给尾部摘要 ——
 * 整份测试日志轻易就能撑爆 ChatGPT 的响应上限。
 */
export function jobReport(db: DatabaseSync, layout: Layout, jobId: string): JobReport {
  const j = getJob(db, jobId);
  if (!j) throw new RunnerError("JOB_NOT_FOUND", `job 不存在：${jobId}`);

  if (j.state === "running") {
    return { truncated: false, state: "running", exitCode: null, artifactPath: null, summary: "仍在运行中。" };
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
  return {
    truncated: capped.truncated,
    state: j.state,
    exitCode: j.exitCode,
    artifactPath: j.artifactPath,
    summary: capped.text,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/runner.test.ts`
Expected: PASS（6 + 4 = 10 个用例）

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
