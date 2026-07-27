# S0-B 仓库读写层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「浏览 / 搜索 / 读 / 改」四类仓库操作做成纯函数，外加 AC-14 的仓内敏感路径拒绝表。

**Architecture:** 全部是**对一个给定根目录**的文件系统操作，不碰 git、不碰 MCP、不碰沙箱。
根目录由调用方给（S0-D 传 canonical，或传 `task.worktreePath`）。每个函数返回纯数据，
截断与分页由函数自己完成并显式标记 —— ChatGPT 会静默截断超大响应，所以宁可我们先截。

**Tech Stack:** TypeScript（Node 24 原生剥离类型）、`node:fs`、`node:crypto`、`yaml`、vitest。

## Global Constraints

取自规格 `docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`，**每个任务隐含包含本节**。

- **本切片不碰 git、不碰 MCP、不碰沙箱。** `grande_diff` 属 S0-C（它要 git），
  工具注册属 S0-D。
- **不实现删除。** 规格 §5.3：S0 没有 Checkpoint，删除不可撤销，那就必须标
  `destructiveHint: true`，导致每次弹框且无法「记住」。禁掉删除让写工具诚实地保持
  非破坏性。删除随 S1 的 Checkpoint 与 Trash 一同解禁。
- **不做错误码映射。** 规格 §7.1：映射在 S0-D。本切片**只负责抛带结构化 `.code`
  的异常**，照抄 `PathSecurityError` 已有的形状（`.code` 存码、`name` 为
  `XxxError [CODE]`、message 不含码前缀）。
- **不做事务性多文件 patch**（规格 §5.6，留 S1）。但**必须先全量校验再逐个落盘**，
  这样一个非法 op 不会留下改了一半的状态。
- **一切路径必须经 `resolveInRepo`**，不得自行拼接。
- **响应字段顺序**：`truncated` / `nextCursor` / `hint` 必须排在 `data` 之前
  （POC 实测该三字段曾落在第 73,896 字节）。本切片返回的是内部结构体，由 S0-D 装信封，
  但**结构体里也按此顺序声明**，避免 S0-D 顺手 spread 时丢掉顺序。
- 严格 TS：`strict: true`、`noUncheckedIndexedAccess: true`。
- `node:sqlite`（内置）而非 `better-sqlite3`；依赖只有 `yaml`。
- 环境变量：`GRANDE_WORKSPACE`（无默认值）、`GRANDE_CONTROL`（默认 `~/.grande-control`）。

## 三条铁律（来自 CLAUDE.md）

1. **仓库内容不可信。** 拒绝表只从 `~/.grande-control/config/` 读，**绝不从仓库内读**。
2. **没有通用逃生舱。** 不提供任意路径读写。
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
export function resolveInRepo(repoRoot: string, relativePath: string): string;
export function resolveRepoPath(layout: Layout, repoId: string, registered: ReadonlySet<string>): string;
export function assertValidId(id: string, label: string): void;

// src/envelope.ts
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean };
export function truncateList<T>(items: T[], max: number, offset?: number): { items: T[]; truncated: boolean; nextCursor: string | null };
```

**`resolveInRepo` 已经处理了**：路径穿越、绝对路径、符号链接逃逸（含悬空链接）、
控制字符、拼写欺骗字符。**不要重新实现这些检查**，也不要绕过它。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/policy.ts` | AC-14 仓内敏感路径拒绝表：加载 + 判定 |
| `src/repoMap.ts` | 目录树 + 关键文件识别 |
| `src/repoSearch.ts` | 文本/正则搜索，带时间预算 |
| `src/repoFile.ts` | 读（返 sha256）与改（校验 sha256），二者共享同一契约故同文件 |

四个任务，一一对应。

---

### Task 1: Policy —— AC-14 仓内敏感路径拒绝表

**Files:**
- Create: `src/policy.ts`
- Test: `tests/policy.test.ts`

**Interfaces:**
- Consumes: `Layout`（`configDir`）
- Produces:
  - `class PolicyError extends Error { readonly code: string }`
  - `interface DenyRules { prefixes: readonly string[] }`
  - `function loadDenyRules(layout: Layout): DenyRules`
  - `function assertWritable(relativePath: string, rules: DenyRules): void`

**为什么它必须存在**：规格 §4.6 —— `resolveInRepo` 的契约只有「在仓库之内」，
而 `.git/hooks/pre-commit` 确实在仓库之内，所以是合法目标。写入由 Gateway 执行，
**沙箱根本不在这条链路上**。往 hooks 写脚本、或改 `core.pager`，都能在你下次手动
git 操作时执行任意宿主命令，**而且是在沙箱退出之后执行的**。

这不是 `resolveInRepo` 的缺陷 —— 包含性检查做的就是包含性检查。这是缺一层策略。

- [ ] **Step 1: 写失败测试**

`tests/policy.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { assertWritable, loadDenyRules, PolicyError } from "../src/policy.ts";

let ws: string, ctrl: string, savedWs: string | undefined, savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "pol-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "pol-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("loadDenyRules()", () => {
  it("配置文件不存在时返回内置默认值，且默认值必须含 .git", () => {
    const l = loadLayout();
    ensureLayout(l);
    const rules = loadDenyRules(l);
    expect(rules.prefixes).toContain(".git/");
  });

  it("从控制平面的 deny.yaml 读取，并与内置默认值合并（配置只能加严，不能放宽）", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes:\n  - node_modules/\n", "utf8");
    const rules = loadDenyRules(l);
    expect(rules.prefixes).toContain("node_modules/");
    // 关键：用户配置【不能】把 .git 放出来——这是 AC-14 的底线
    expect(rules.prefixes).toContain(".git/");
  });

  it("配置格式非法时响亮地失败，而不是静默退回默认值", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes: 42\n", "utf8");
    expect(() => loadDenyRules(l)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("绝不从仓库内读配置（铁律一）：仓库里放同名文件不产生任何影响", () => {
    const l = loadLayout();
    ensureLayout(l);
    const repo = join(l.workspaceRoot, "demo");
    mkdirSync(repo, { recursive: true });
    // 仓库内伪造一份想把 .git 放行的配置
    writeFileSync(join(repo, "deny.yaml"), "prefixes: []\n", "utf8");
    const rules = loadDenyRules(l);
    expect(rules.prefixes).toContain(".git/");
  });
});

describe("assertWritable()", () => {
  const rules = { prefixes: [".git/", "node_modules/"] as const };

  it.each([
    [".git/config"],
    [".git/hooks/pre-commit"],
    ["src/../.git/config"],
    [".git"],
    ["node_modules/foo/index.js"],
  ])("拒绝敏感路径 %s", (p) => {
    expect(() => assertWritable(p, rules)).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it.each([
    ["src/index.ts"],
    ["README.md"],
    ["docs/.gitkeep"],
    ["src/git/helper.ts"],
    [".gitignore"],
  ])("放行正常路径 %s（过度拒绝也是 bug）", (p) => {
    expect(() => assertWritable(p, rules)).not.toThrow();
  });
});
```

**注意最后两组用例是成对的** —— 只有拒绝用例的话，一个「拒绝一切」的实现也能全绿。
`.gitignore` 与 `src/git/helper.ts` 是专门用来抓「前缀匹配写成了 `startsWith('.git')`」
这个错误的：那样写会把 `.gitignore` 也误杀。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/policy.test.ts`
Expected: FAIL —— `Cannot find module '../src/policy.ts'`

- [ ] **Step 3: 实现**

`src/policy.ts`：

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";

export class PolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    // 与 PathSecurityError 保持同一形状：码存 .code 供程序分支，name 带码供日志与
    // 堆栈定位，message 保持干净——码不进 message，因为它在响应信封里已有独立字段，
    // 重复一遍是在会被静默截断的响应里浪费字节。
    super(message);
    this.name = `PolicyError [${code}]`;
    this.code = code;
  }
}

export interface DenyRules {
  readonly prefixes: readonly string[];
}

/**
 * 内置拒绝项。**用户配置只能追加、不能移除这些** —— AC-14 是硬门禁，
 * 而配置文件是可编辑的；允许放宽就等于把硬约束降级成软约束（铁律三）。
 */
const BUILTIN_PREFIXES = [".git/"] as const;

/**
 * 从**控制平面**读拒绝表。绝不从仓库内读（铁律一：仓库内容不可信）。
 * 文件不存在是正常情况，返回内置默认值。
 */
export function loadDenyRules(layout: Layout): DenyRules {
  const file = join(layout.configDir, "deny.yaml");
  const extra: string[] = [];

  if (existsSync(file)) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new PolicyError("BAD_CONFIG", `无法解析 ${file}：${(e as Error).message}`);
    }
    if (doc !== null && doc !== undefined) {
      if (typeof doc !== "object" || Array.isArray(doc)) {
        throw new PolicyError("BAD_CONFIG", `${file} 顶层必须是映射，实际是 ${typeof doc}`);
      }
      const raw = (doc as { prefixes?: unknown }).prefixes;
      if (raw !== undefined) {
        if (!Array.isArray(raw)) {
          throw new PolicyError("BAD_CONFIG", `${file} 的 prefixes 必须是数组，实际是 ${typeof raw}`);
        }
        for (const p of raw) {
          if (typeof p !== "string" || p.length === 0) {
            throw new PolicyError("BAD_CONFIG", `${file} 的 prefixes 每一项必须是非空字符串`);
          }
          extra.push(p.endsWith("/") ? p : `${p}/`);
        }
      }
    }
  }

  // 内置在前，且用 Set 去重后【不】过滤内置项——合并方向是只增不减
  return { prefixes: [...new Set([...BUILTIN_PREFIXES, ...extra])] };
}

/**
 * 判定一个**仓库内相对路径**是否可写。
 *
 * 先 `normalize` 再判断，否则 `src/../.git/config` 这种绕行写法会漏网。
 * 注意这里只做语义判定，不碰文件系统——路径的物理安全由 `resolveInRepo` 负责，
 * 两者是两道独立的关卡，缺一不可。
 */
export function assertWritable(relativePath: string, rules: DenyRules): void {
  const norm = normalize(relativePath);
  for (const prefix of rules.prefixes) {
    // prefix 恒以 "/" 结尾，因此 `.gitignore` 不会被 `.git/` 误伤，
    // 而 `.git` 目录本身需要单独比对（去掉尾斜杠后全等）
    const bare = prefix.slice(0, -1);
    if (norm === bare || norm.startsWith(prefix)) {
      throw new PolicyError(
        "POLICY_DENIED",
        `${relativePath} 命中仓内敏感路径拒绝表（${bare}）。` +
          `这类路径能在沙箱之外执行宿主命令（如 .git/hooks/pre-commit、core.pager），` +
          `因此写工具一律不可触及。`,
      );
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/policy.test.ts`
Expected: PASS（4 + 10 = 14 个用例）

- [ ] **Step 5: 承重性验证**

把 `assertWritable` 里的 `norm` 改回 `relativePath`（即去掉 `normalize`），
确认 `src/../.git/config` 那一行变红，再还原。**把观察结果写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/policy.ts tests/policy.test.ts
git commit -m "feat(s0-b): AC-14 仓内敏感路径拒绝表"
```

---

### Task 2: `repoMap` —— 目录树与关键文件

**Files:**
- Create: `src/repoMap.ts`
- Test: `tests/repoMap.test.ts`

**Interfaces:**
- Consumes: `resolveInRepo`
- Produces:
  - `interface MapEntry { path: string; kind: "file" | "dir"; bytes: number | null }`
  - `interface MapResult { truncated: boolean; nextCursor: string | null; entries: MapEntry[]; keyFiles: string[] }`
  - `function repoMap(root: string, opts?: { maxEntries?: number; cursor?: string | null }): MapResult`

**延迟预算 < 2s**（规格 §5.2）。

- [ ] **Step 1: 写失败测试**

`tests/repoMap.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoMap } from "../src/repoMap.ts";

let root: string;

function file(rel: string, content = "x") {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "map-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repoMap()", () => {
  it("列出文件与目录，路径是仓库内相对路径且用 / 分隔", () => {
    file("src/index.ts");
    file("README.md");
    const r = repoMap(root);
    const paths = r.entries.map((e) => e.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src");
    expect(paths.every((p) => !p.startsWith("/"))).toBe(true);
  });

  it("跳过 .git、node_modules 与 .grande-work，不把它们的内容铺开", () => {
    file(".git/config");
    file("node_modules/pkg/index.js");
    file(".grande-work/worktrees/x/a.ts");
    file("src/a.ts");
    const paths = repoMap(root).entries.map((e) => e.path);
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".grande-work"))).toBe(false);
    expect(paths).toContain("src/a.ts");
  });

  it("顺序确定：同一棵树跑两次结果逐字节相同", () => {
    // 目录遍历顺序不是保证的（readdir 依赖文件系统），不显式排序就会出现
    // 「同样的仓库两次调用给模型看到不同顺序」——在长会话里这是隐蔽的困惑源。
    for (const n of ["z.ts", "a.ts", "m.ts", "B.ts"]) file(`src/${n}`);
    const a = repoMap(root).entries.map((e) => e.path);
    const b = repoMap(root).entries.map((e) => e.path);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it("识别关键文件：package.json、测试目录、入口", () => {
    file("package.json", '{"name":"x"}');
    file("src/index.ts");
    file("tests/a.test.ts");
    file("src/noise.ts");
    const r = repoMap(root);
    expect(r.keyFiles).toContain("package.json");
    expect(r.keyFiles).toContain("src/index.ts");
    expect(r.keyFiles).toContain("tests");
    expect(r.keyFiles).not.toContain("src/noise.ts");
  });

  it("超过 maxEntries 时截断并给出 nextCursor，用它能取到剩下的且不重不漏", () => {
    for (let i = 0; i < 10; i++) file(`src/f${String(i).padStart(2, "0")}.ts`);
    const first = repoMap(root, { maxEntries: 4 });
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.entries).toHaveLength(4);

    const second = repoMap(root, { maxEntries: 100, cursor: first.nextCursor });
    expect(second.truncated).toBe(false);
    // 不重
    const overlap = second.entries.filter((e) => first.entries.some((f) => f.path === e.path));
    expect(overlap).toEqual([]);
    // 不漏
    const all = repoMap(root, { maxEntries: 1000 });
    expect([...first.entries, ...second.entries].map((e) => e.path)).toEqual(all.entries.map((e) => e.path));
  });

  it("字段声明顺序：truncated/nextCursor 必须排在 entries 之前", () => {
    file("a.ts");
    const keys = Object.keys(repoMap(root));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("entries"));
    expect(keys.indexOf("nextCursor")).toBeLessThan(keys.indexOf("entries"));
  });

  it("文件给出字节数，目录为 null", () => {
    file("a.ts", "hello");
    const r = repoMap(root);
    expect(r.entries.find((e) => e.path === "a.ts")?.bytes).toBe(5);
    file("d/b.ts");
    expect(repoMap(root).entries.find((e) => e.path === "d")?.bytes).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/repoMap.test.ts`
Expected: FAIL —— `Cannot find module '../src/repoMap.ts'`

- [ ] **Step 3: 实现**

`src/repoMap.ts`：

```typescript
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface MapEntry {
  path: string;
  kind: "file" | "dir";
  bytes: number | null;
}

export interface MapResult {
  // 顺序即序列化顺序：ChatGPT 会静默截断超大响应，这两个字段排在 entries 之后
  // 就可能永远看不到（POC 实测曾落在第 73,896 字节）
  truncated: boolean;
  nextCursor: string | null;
  entries: MapEntry[];
  keyFiles: string[];
}

/** 不铺开的目录。`.git` 无意义且巨大，`node_modules` 会淹没一切，`.grande-work` 是派生数据 */
const SKIP_DIRS = new Set([".git", "node_modules", ".grande-work"]);

const KEY_FILE_NAMES = new Set([
  "package.json", "pnpm-lock.yaml", "tsconfig.json", "Cargo.toml",
  "go.mod", "pyproject.toml", "requirements.txt", "Makefile", "README.md",
]);
const KEY_ENTRY_PATHS = ["src/index.ts", "src/main.ts", "src/index.js", "main.py", "src/lib.rs"];
const KEY_DIR_NAMES = new Set(["tests", "test", "__tests__", "spec"]);

function walk(root: string, dir: string, out: MapEntry[]): void {
  // readdirSync 的顺序不是保证的——显式排序，否则同一棵树两次调用可能给出不同顺序
  const names = readdirSync(dir).sort();
  for (const name of names) {
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join("/");
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // 竞态删除或权限问题：跳过而不是整棵树失败
    }
    if (st.isDirectory()) {
      out.push({ path: rel, kind: "dir", bytes: null });
      if (!SKIP_DIRS.has(name)) walk(root, abs, out);
    } else if (st.isFile()) {
      out.push({ path: rel, kind: "file", bytes: st.size });
    }
  }
}

/**
 * 列出仓库结构。`root` 必须已是可信的绝对路径（由 `resolveRepoPath` 或
 * `task.worktreePath` 提供）—— 本函数不做路径安全校验，那是 `paths.ts` 的职责。
 *
 * `cursor` 是上一次返回的 `nextCursor`，即「已经给过多少条」的十进制偏移量。
 * 用偏移量而非「最后一条的路径」是因为条目已全局排序，偏移量足够且更便宜。
 */
export function repoMap(
  root: string,
  opts?: { maxEntries?: number; cursor?: string | null },
): MapResult {
  const maxEntries = opts?.maxEntries ?? 500;
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`cursor 必须是非负整数，收到：${opts?.cursor}`);
  }

  const all: MapEntry[] = [];
  walk(root, root, all);
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const slice = all.slice(offset, offset + maxEntries);
  const consumed = offset + slice.length;
  const truncated = consumed < all.length;

  const paths = new Set(all.map((e) => e.path));
  const keyFiles = [
    ...all.filter((e) => e.kind === "file" && KEY_FILE_NAMES.has(e.path.split("/").pop()!) && !e.path.includes("/")).map((e) => e.path),
    ...KEY_ENTRY_PATHS.filter((p) => paths.has(p)),
    ...all.filter((e) => e.kind === "dir" && KEY_DIR_NAMES.has(e.path)).map((e) => e.path),
  ].sort();

  return {
    truncated,
    nextCursor: truncated ? String(consumed) : null,
    entries: slice,
    keyFiles: [...new Set(keyFiles)],
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/repoMap.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: 承重性验证**

去掉 `all.sort(...)` 那一行，确认「顺序确定」那条变红；还原后确认变绿。
**把观察结果写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/repoMap.ts tests/repoMap.test.ts
git commit -m "feat(s0-b): repoMap 目录树与关键文件识别"
```

---

### Task 3: `repoSearch` —— 带时间预算的搜索

**Files:**
- Create: `src/repoSearch.ts`
- Test: `tests/repoSearch.test.ts`

**Interfaces:**
- Consumes: 无（自行遍历，复用 Task 2 的跳过目录集合需自己声明一份，**不要**从
  `repoMap.ts` 导出内部常量 —— 那会把一个内部细节变成跨模块契约）
- Produces:
  - `interface SearchMatch { path: string; line: number; text: string; before: string[]; after: string[] }`
  - `interface SearchResult { truncated: boolean; nextCursor: string | null; timedOut: boolean; matches: SearchMatch[] }`
  - `function repoSearch(root: string, pattern: string, opts?: { regex?: boolean; maxMatches?: number; budgetMs?: number; cursor?: string | null }): SearchResult`

**规格 §5.4②**：上限 50 条匹配 / 每条 3 行上下文 / **4s 预算**。
到点即返回已有结果并标 `truncated`，**而不是搜到底** —— 搜到底会撞上 ChatGPT
那个不可配置的 ~60s 工具超时。

- [ ] **Step 1: 写失败测试**

`tests/repoSearch.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoSearch } from "../src/repoSearch.ts";

let root: string;
function file(rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "srch-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repoSearch()", () => {
  it("找到字面量匹配，带行号与上下文", () => {
    file("src/a.ts", "line1\nline2\nNEEDLE here\nline4\nline5\n");
    const r = repoSearch(root, "NEEDLE");
    expect(r.matches).toHaveLength(1);
    const m = r.matches[0]!;
    expect(m.path).toBe("src/a.ts");
    expect(m.line).toBe(3);
    expect(m.text).toBe("NEEDLE here");
    expect(m.before).toEqual(["line1", "line2"]);
    expect(m.after).toEqual(["line4", "line5"]);
  });

  it("regex 模式生效，且非 regex 模式下特殊字符按字面量处理", () => {
    file("src/a.ts", "a.b\naxb\n");
    expect(repoSearch(root, "a.b", { regex: false }).matches.map((m) => m.text)).toEqual(["a.b"]);
    expect(repoSearch(root, "a.b", { regex: true }).matches.map((m) => m.text)).toEqual(["a.b", "axb"]);
  });

  it("非法正则响亮地失败，而不是静默返回空结果", () => {
    file("src/a.ts", "x\n");
    expect(() => repoSearch(root, "a(", { regex: true })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("跳过 .git、node_modules 与二进制文件", () => {
    file(".git/config", "NEEDLE\n");
    file("node_modules/p/i.js", "NEEDLE\n");
    file("bin.dat", "NEEDLE binary\n");
    file("src/ok.ts", "NEEDLE\n");
    const paths = repoSearch(root, "NEEDLE").matches.map((m) => m.path);
    expect(paths).toEqual(["src/ok.ts"]);
  });

  it("超过 maxMatches 时截断并给 nextCursor，续取不重不漏", () => {
    for (let i = 0; i < 10; i++) file(`src/f${String(i).padStart(2, "0")}.ts`, "NEEDLE\n");
    const first = repoSearch(root, "NEEDLE", { maxMatches: 4 });
    expect(first.truncated).toBe(true);
    expect(first.matches).toHaveLength(4);
    const second = repoSearch(root, "NEEDLE", { maxMatches: 100, cursor: first.nextCursor });
    expect(second.truncated).toBe(false);
    const allPaths = [...first.matches, ...second.matches].map((m) => m.path);
    expect(new Set(allPaths).size).toBe(10);
  });

  it("顺序确定：两次相同搜索结果逐项相同", () => {
    for (const n of ["z.ts", "a.ts", "m.ts"]) file(`src/${n}`, "NEEDLE\n");
    const a = repoSearch(root, "NEEDLE").matches.map((m) => m.path);
    expect(a).toEqual(repoSearch(root, "NEEDLE").matches.map((m) => m.path));
    expect(a).toEqual([...a].sort());
  });

  it("时间预算到点即返回，标记 timedOut，且【已找到的结果不丢】", () => {
    // budgetMs=0 保证第一次检查就超预算。关键断言是 timedOut 为 true 而不是抛错——
    // 撞上 ChatGPT 那个不可配置的 ~60s 超时的后果，比返回部分结果糟糕得多。
    for (let i = 0; i < 50; i++) file(`src/f${i}.ts`, "NEEDLE\n");
    const r = repoSearch(root, "NEEDLE", { budgetMs: 0 });
    expect(r.timedOut).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it("字段声明顺序：truncated/nextCursor/timedOut 必须排在 matches 之前", () => {
    file("a.ts", "NEEDLE\n");
    const keys = Object.keys(repoSearch(root, "NEEDLE"));
    for (const k of ["truncated", "nextCursor", "timedOut"]) {
      expect(keys.indexOf(k)).toBeLessThan(keys.indexOf("matches"));
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/repoSearch.test.ts`
Expected: FAIL —— `Cannot find module '../src/repoSearch.ts'`

- [ ] **Step 3: 实现**

`src/repoSearch.ts`：

```typescript
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export class SearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `SearchError [${code}]`;
    this.code = code;
  }
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface SearchResult {
  truncated: boolean;
  nextCursor: string | null;
  timedOut: boolean;
  matches: SearchMatch[];
}

/** 与 repoMap 各自声明一份：跳过哪些目录是每个模块自己的策略，不是跨模块契约 */
const SKIP_DIRS = new Set([".git", "node_modules", ".grande-work"]);
const CONTEXT_LINES = 2;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function listFiles(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) listFiles(root, abs, out);
    else if (st.isFile() && st.size <= MAX_FILE_BYTES) out.push(abs);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 搜索仓库文本。
 *
 * **时间预算是硬要求，不是优化**：ChatGPT 的工具调用 ~60s 超时不可配置，
 * 搜到底可能直接撑爆它。到点返回部分结果 + `timedOut: true`，
 * 让模型知道结果不完整，远好过整个调用失败。
 */
export function repoSearch(
  root: string,
  pattern: string,
  opts?: { regex?: boolean; maxMatches?: number; budgetMs?: number; cursor?: string | null },
): SearchResult {
  const maxMatches = opts?.maxMatches ?? 50;
  const budgetMs = opts?.budgetMs ?? 4000;
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new SearchError("INVALID_INPUT", `cursor 必须是非负整数，收到：${opts?.cursor}`);
  }
  if (pattern.length === 0) throw new SearchError("INVALID_INPUT", "pattern 不能为空");

  let re: RegExp;
  try {
    re = new RegExp(opts?.regex === true ? pattern : escapeRegExp(pattern));
  } catch (e) {
    throw new SearchError("INVALID_INPUT", `正则非法：${(e as Error).message}`);
  }

  const started = Date.now();
  const files: string[] = [];
  listFiles(root, root, files);

  const found: SearchMatch[] = [];
  let timedOut = false;

  // 需要收集 offset + maxMatches + 1 条才能既跳过已给出的、又判断还有没有更多
  const need = offset + maxMatches + 1;

  outer: for (const abs of files) {
    if (Date.now() - started > budgetMs) {
      timedOut = true;
      break;
    }
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (content.includes(" ")) continue; // 二进制

    const lines = content.split("\n");
    const rel = relative(root, abs).split(sep).join("/");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      re.lastIndex = 0;
      found.push({
        path: rel,
        line: i + 1,
        text: lines[i]!,
        before: lines.slice(Math.max(0, i - CONTEXT_LINES), i),
        after: lines.slice(i + 1, i + 1 + CONTEXT_LINES),
      });
      if (found.length >= need) break outer;
    }
  }

  const slice = found.slice(offset, offset + maxMatches);
  const consumed = offset + slice.length;
  const truncated = timedOut || consumed < found.length;

  return {
    truncated,
    nextCursor: truncated && !timedOut ? String(consumed) : null,
    timedOut,
    matches: slice,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/repoSearch.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 承重性验证**

把预算检查 `if (Date.now() - started > budgetMs)` 改成恒 `false`，确认「时间预算」
那条变红；还原后确认变绿。**把观察结果写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/repoSearch.ts tests/repoSearch.test.ts
git commit -m "feat(s0-b): repoSearch 带时间预算的仓库搜索"
```

---

### Task 4: `repoFile` —— 读（返 sha256）与改（校验 sha256）

**Files:**
- Create: `src/repoFile.ts`
- Test: `tests/repoFile.test.ts`

**Interfaces:**
- Consumes: `resolveInRepo`（`src/paths.ts`）、`assertWritable` 与 `DenyRules`（`src/policy.ts`）、
  `truncateText`（`src/envelope.ts`）
- Produces:
  - `interface ReadResult { truncated: boolean; path: string; sha256: string; bytes: number; totalLines: number; content: string }`
  - `function repoRead(root: string, relativePath: string, opts?: { maxBytes?: number; lineRange?: [number, number] }): ReadResult`
  - `type EditOp = { op: "create"; path: string; content: string } | { op: "modify"; path: string; content: string; expectedSha256: string } | { op: "move"; from: string; to: string }`
  - `interface EditResult { applied: { op: string; path: string; sha256: string | null }[] }`
  - `function repoEdit(root: string, ops: readonly EditOp[], rules: DenyRules): EditResult`
  - `class EditError extends Error { readonly code: string }`

**读改同文件的理由**：二者共享同一个 `sha256` 契约（规格 §5.6）——
读返回 sha256，改必须携带 `expectedSha256`。拆开会让任一半单独审起来缺少另一半的语境。

**为什么需要 staleness 检查**（规格 §5.6）：即使单用户无并发，模型自己也会踩 ——
读了文件 → 改了 → 跑了测试 → 又基于**最初那次读**的内容再改一次，覆盖掉第一次的修改。
这是长会话里必然出现的困惑源，症状极隐蔽（「我明明改了啊」）。

- [ ] **Step 1: 写失败测试**

`tests/repoFile.test.ts`：

```typescript
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DenyRules } from "../src/policy.ts";
import { repoEdit, repoRead } from "../src/repoFile.ts";

let root: string;
const RULES: DenyRules = { prefixes: [".git/"] };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function file(rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rf-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repoRead()", () => {
  it("返回内容、字节数、行数与 sha256，且 sha256 与内容真实对应", () => {
    file("a.ts", "hello\nworld\n");
    const r = repoRead(root, "a.ts");
    expect(r.content).toBe("hello\nworld\n");
    expect(r.bytes).toBe(12);
    expect(r.totalLines).toBe(3); // 末尾换行产生一个空行
    expect(r.sha256).toBe(sha("hello\nworld\n"));
    expect(r.truncated).toBe(false);
  });

  it("超过 maxBytes 时截断并标记，但 sha256 仍是【完整文件】的哈希", () => {
    // 这一条是设计要点：sha256 用于 staleness 校验，必须代表磁盘上的完整文件。
    // 若返回截断内容的哈希，模型拿它回来改文件会永远对不上。
    const big = "x".repeat(200);
    file("big.ts", big);
    const r = repoRead(root, "big.ts", { maxBytes: 50 });
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(50);
    expect(r.sha256).toBe(sha(big));
  });

  it("lineRange 取指定行区间（1 基、闭区间）", () => {
    file("a.ts", "l1\nl2\nl3\nl4\nl5\n");
    const r = repoRead(root, "a.ts", { lineRange: [2, 4] });
    expect(r.content).toBe("l2\nl3\nl4");
    expect(r.sha256).toBe(sha("l1\nl2\nl3\nl4\nl5\n"));
  });

  it("文件不存在时抛带码的错误", () => {
    expect(() => repoRead(root, "nope.ts")).toThrow(expect.objectContaining({ code: "FILE_NOT_FOUND" }));
  });

  it("路径逃逸被 resolveInRepo 挡住", () => {
    expect(() => repoRead(root, "../outside.ts")).toThrow(expect.objectContaining({ code: "PATH_ESCAPE" }));
  });

  it("字段声明顺序：truncated 必须排在 content 之前", () => {
    file("a.ts", "x");
    const keys = Object.keys(repoRead(root, "a.ts"));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("content"));
  });
});

describe("repoEdit()", () => {
  it("create 新建文件并返回新 sha256", () => {
    const r = repoEdit(root, [{ op: "create", path: "src/new.ts", content: "hi" }], RULES);
    expect(read("src/new.ts")).toBe("hi");
    expect(r.applied[0]!.sha256).toBe(sha("hi"));
  });

  it("create 不覆盖已存在的文件", () => {
    file("a.ts", "original");
    expect(() => repoEdit(root, [{ op: "create", path: "a.ts", content: "new" }], RULES)).toThrow(
      expect.objectContaining({ code: "FILE_EXISTS" }),
    );
    expect(read("a.ts")).toBe("original");
  });

  it("modify 在 expectedSha256 匹配时写入", () => {
    file("a.ts", "v1");
    repoEdit(root, [{ op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("v1") }], RULES);
    expect(read("a.ts")).toBe("v2");
  });

  it("modify 在 expectedSha256 不匹配时抛 STALE_FILE 且不写入", () => {
    file("a.ts", "v1");
    expect(() =>
      repoEdit(root, [{ op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("WRONG") }], RULES),
    ).toThrow(expect.objectContaining({ code: "STALE_FILE" }));
    expect(read("a.ts")).toBe("v1");
  });

  it("move 移动文件，源消失目标出现", () => {
    file("a.ts", "content");
    repoEdit(root, [{ op: "move", from: "a.ts", to: "src/b.ts" }], RULES);
    expect(existsSync(join(root, "a.ts"))).toBe(false);
    expect(read("src/b.ts")).toBe("content");
  });

  it("命中拒绝表的路径被拒，且【两个方向】都查：move 的 from 与 to", () => {
    file("a.ts", "x");
    expect(() => repoEdit(root, [{ op: "create", path: ".git/hooks/pre-commit", content: "#!/bin/sh" }], RULES))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() => repoEdit(root, [{ op: "move", from: "a.ts", to: ".git/x" }], RULES))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    file(".git/config", "x");
    expect(() => repoEdit(root, [{ op: "move", from: ".git/config", to: "leaked.txt" }], RULES))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("先全量校验再落盘：一批里有一个非法 op，则【整批都不写】", () => {
    // 这是本任务最重要的性质。S0 没有事务性 patch（留 S1），但「校验全部通过才开始写」
    // 是免费的，而且它决定了失败时仓库处于可理解的状态而不是改了一半。
    file("a.ts", "v1");
    expect(() =>
      repoEdit(
        root,
        [
          { op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("v1") }, // 合法
          { op: "create", path: ".git/evil", content: "x" },                        // 非法
        ],
        RULES,
      ),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(read("a.ts")).toBe("v1"); // 第一个合法 op 也没有被应用
  });

  it("同一批里对同一路径重复操作被拒（顺序依赖会让 sha256 契约失效）", () => {
    expect(() =>
      repoEdit(
        root,
        [
          { op: "create", path: "x.ts", content: "a" },
          { op: "create", path: "x.ts", content: "b" },
        ],
        RULES,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("空 ops 数组被拒，而不是静默成功", () => {
    expect(() => repoEdit(root, [], RULES)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("不提供删除能力：类型层面没有 delete op（本条是文档性断言）", () => {
    // 规格 §5.3：S0 没有 Checkpoint，删除不可撤销。若支持删除就必须标
    // destructiveHint: true，导致每次弹框且无法「记住」。
    const ops = ["create", "modify", "move"];
    expect(ops).not.toContain("delete");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/repoFile.test.ts`
Expected: FAIL —— `Cannot find module '../src/repoFile.ts'`

- [ ] **Step 3: 实现**

`src/repoFile.ts`：

```typescript
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { truncateText } from "./envelope.ts";
import { resolveInRepo } from "./paths.ts";
import { assertWritable, type DenyRules } from "./policy.ts";

export class EditError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `EditError [${code}]`;
    this.code = code;
  }
}

export interface ReadResult {
  truncated: boolean;
  path: string;
  sha256: string;
  bytes: number;
  totalLines: number;
  content: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

function sha256Of(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * 读一个仓库内文件。
 *
 * **`sha256` 永远是完整文件的哈希，即使 `content` 被截断。** 它的用途是
 * `repoEdit` 的 staleness 校验（规格 §5.6）；若返回截断内容的哈希，
 * 模型拿它回来改文件会永远对不上。
 */
export function repoRead(
  root: string,
  relativePath: string,
  opts?: { maxBytes?: number; lineRange?: [number, number] },
): ReadResult {
  const abs = resolveInRepo(root, relativePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new EditError("FILE_NOT_FOUND", `文件不存在：${relativePath}`);
  }
  const full = readFileSync(abs, "utf8");
  const digest = sha256Of(full);
  const lines = full.split("\n");

  let body = full;
  let truncated = false;
  if (opts?.lineRange) {
    const [from, to] = opts.lineRange;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new EditError("INVALID_INPUT", `lineRange 非法：[${from}, ${to}]`);
    }
    body = lines.slice(from - 1, to).join("\n");
    truncated = from > 1 || to < lines.length;
  }

  const capped = truncateText(body, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  return {
    truncated: truncated || capped.truncated,
    path: relativePath,
    sha256: digest,
    bytes: Buffer.byteLength(full, "utf8"),
    totalLines: lines.length,
    content: capped.text,
  };
}

export type EditOp =
  | { op: "create"; path: string; content: string }
  | { op: "modify"; path: string; content: string; expectedSha256: string }
  | { op: "move"; from: string; to: string };

export interface EditResult {
  applied: { op: string; path: string; sha256: string | null }[];
}

/** 一个 op 涉及的所有仓库内相对路径（move 有两个） */
function pathsOf(op: EditOp): string[] {
  return op.op === "move" ? [op.from, op.to] : [op.path];
}

/**
 * 批量修改仓库文件。**不支持删除**（规格 §5.3）。
 *
 * **先全量校验、再逐个落盘。** S0 没有事务性 patch（留 S1），所以落盘过程中
 * 出现 I/O 错误仍会留下改了一半的状态；但一个**非法**的 op 绝不会导致部分应用，
 * 因为所有校验都在第一次写之前完成。这两者的区别很重要：前者是已知缺口，
 * 后者会是缺陷。
 */
export function repoEdit(root: string, ops: readonly EditOp[], rules: DenyRules): EditResult {
  if (ops.length === 0) throw new EditError("INVALID_INPUT", "ops 不能为空");

  // ── 阶段一：全量校验，不碰磁盘内容 ──
  const seen = new Set<string>();
  const resolved: { op: EditOp; abs: string; absTo?: string }[] = [];

  for (const op of ops) {
    for (const p of pathsOf(op)) {
      assertWritable(p, rules); // 抛 PolicyError（code=POLICY_DENIED）
      if (seen.has(p)) {
        throw new EditError("INVALID_INPUT", `同一批中对 ${p} 有多个操作；请拆成多次调用`);
      }
      seen.add(p);
    }

    if (op.op === "move") {
      const from = resolveInRepo(root, op.from);
      const to = resolveInRepo(root, op.to);
      if (!existsSync(from)) throw new EditError("FILE_NOT_FOUND", `源文件不存在：${op.from}`);
      if (existsSync(to)) throw new EditError("FILE_EXISTS", `目标已存在：${op.to}`);
      resolved.push({ op, abs: from, absTo: to });
      continue;
    }

    const abs = resolveInRepo(root, op.path);
    if (op.op === "create") {
      if (existsSync(abs)) {
        throw new EditError("FILE_EXISTS", `文件已存在：${op.path}。修改已有文件请用 modify。`);
      }
    } else {
      if (!existsSync(abs)) throw new EditError("FILE_NOT_FOUND", `文件不存在：${op.path}`);
      const actual = sha256Of(readFileSync(abs, "utf8"));
      if (actual !== op.expectedSha256) {
        throw new EditError(
          "STALE_FILE",
          `${op.path} 自上次读取后已改变。请重新 read 取得最新 sha256 后再改 —— ` +
            `否则你会用旧内容覆盖掉中间的修改。`,
        );
      }
    }
    resolved.push({ op, abs });
  }

  // ── 阶段二：落盘 ──
  const applied: EditResult["applied"] = [];
  for (const r of resolved) {
    if (r.op.op === "move") {
      mkdirSync(dirname(r.absTo!), { recursive: true });
      renameSync(r.abs, r.absTo!);
      applied.push({ op: "move", path: r.op.to, sha256: null });
    } else {
      mkdirSync(dirname(r.abs), { recursive: true });
      writeFileSync(r.abs, r.op.content, "utf8");
      applied.push({ op: r.op.op, path: r.op.path, sha256: sha256Of(r.op.content) });
    }
  }
  return { applied };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/repoFile.test.ts`
Expected: PASS（6 + 10 = 16 个用例）

- [ ] **Step 5: 承重性验证**

把阶段一与阶段二合成一个循环（边校验边写），确认「先全量校验再落盘」那条变红；
还原后确认变绿。**把观察结果写进报告。**

- [ ] **Step 6: 全套测试 + typecheck + 提交**

```bash
pnpm test
pnpm typecheck
git add src/repoFile.ts tests/repoFile.test.ts
git commit -m "feat(s0-b): repoFile 读写与 staleness 校验"
```

---

## 本切片明确不做

| 不做 | 归属 |
|---|---|
| `grande_diff` | S0-C（需要 git） |
| 删除文件 | S1（需要 Checkpoint 与 Trash） |
| 事务性多文件 patch（失败回滚） | S1 |
| 内部异常 → 工具错误码映射 | S0-D（规格 §7.1） |
| MCP 工具注册、`readOnlyHint` 等注解 | S0-D |
| worktree 的创建 | S0-C |
