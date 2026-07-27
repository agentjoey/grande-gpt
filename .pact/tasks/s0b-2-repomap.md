# s0b-2-repomap

> 本文件是 **S0B 切片**的第 2 个任务，从
> `docs/superpowers/plans/2026-07-27-s0-b-repo-read-write.md` 切出。计划本身已通过一轮对抗性代码审查（发现并修掉了
> 可复现的安全绕过与跑不起来的测试），**请逐字使用其中给出的代码与测试，不要自行改写**。

---

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
| `src/repoSearch.ts` | 文本搜索（字面量，不支持正则），带时间预算 |
| `src/repoFile.ts` | 读（返 sha256）与改（校验 sha256），二者共享同一契约故同文件 |

四个任务，一一对应。

---

---

### Task 2: `repoMap` —— 目录树与关键文件

**Files:**
- Create: `src/repoMap.ts`
- Test: `tests/repoMap.test.ts`

**Interfaces:**
- Consumes: `resolveInRepo`
- Produces:
  - `class MapError extends Error { readonly code: string }`
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

  it("顺序确定且是全局字典序：同一棵树跑两次结果逐字节相同", () => {
    // 目录遍历顺序不是保证的（readdir 依赖文件系统），不显式排序就会出现「同样的仓库
    // 两次调用给模型看到不同顺序」——在长会话里这是隐蔽的困惑源。
    // 注意 src.ts：只在 src/ 一个目录里放文件的话，DFS 顺序碰巧就等于全局字典序，
    // 去掉 all.sort() 这条测试也不会变红，承重性验证就是空转。
    for (const n of ["z.ts", "a.ts", "m.ts", "B.ts"]) file(`src/${n}`);
    file("src.ts");
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

  it("翻页时不重复给 keyFiles：只在 cursor 缺省的首页给出", () => {
    // keyFiles 描述的是整棵树，与「这一页有哪些条目」无关；翻页时重复发送同一份
    // 数据纯粹浪费 ChatGPT 那个会静默截断的响应预算。
    file("package.json", '{"name":"x"}');
    for (let i = 0; i < 5; i++) file(`src/f${i}.ts`);
    const first = repoMap(root, { maxEntries: 2 });
    expect(first.truncated).toBe(true);
    expect(first.keyFiles).toContain("package.json");
    const second = repoMap(root, { maxEntries: 2, cursor: first.nextCursor });
    expect(second.keyFiles).toEqual([]);
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

export class MapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `MapError [${code}]`;
    this.code = code;
  }
}

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
  // readdirSync 的顺序不是保证的——显式排序，否则同一棵树两次调用可能给出不同顺序。
  // 读取失败必须分两种：根目录读不到是调用方的错，要报出来；子目录读不到
  // （权限/竞态删除）不该让整棵树失败——下面 statSync 的 catch 只覆盖单个条目。
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    if (dir === root) {
      throw new MapError("INVALID_INPUT", `无法读取仓库根 ${root}：${(e as Error).message}`);
    }
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue; // 连目录项本身都不列：与 repoSearch 的 listFiles 一致
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join("/");
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // 竞态删除或对该条目的权限问题：跳过而不是整棵树失败
    }
    if (st.isDirectory()) {
      out.push({ path: rel, kind: "dir", bytes: null });
      walk(root, abs, out);
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
 * 用偏移量而非「最后一条的路径」是因为条目已全局排序，偏移量在同一棵**未变化**
 * 的树上可复现——它不是稳定标识符：两次调用之间如果仓库内容变了（文件增删），
 * 同一个偏移量可能对应不同的条目。调用方在续取页之间不应该修改仓库。
 */
export function repoMap(
  root: string,
  opts?: { maxEntries?: number; cursor?: string | null },
): MapResult {
  const maxEntries = opts?.maxEntries ?? 500;
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new MapError("INVALID_INPUT", `cursor 必须是非负整数，收到：${opts?.cursor}`);
  }

  const all: MapEntry[] = [];
  walk(root, root, all);
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const slice = all.slice(offset, offset + maxEntries);
  const consumed = offset + slice.length;
  const truncated = consumed < all.length;

  // keyFiles 描述的是【整棵树】的关键文件，与本页无关；只在首页（无 cursor）给一次，
  // 翻页时重复发送同一份数据纯粹浪费 ChatGPT 那个会静默截断的响应预算。
  let keyFiles: string[] = [];
  if (!opts?.cursor) {
    const paths = new Set(all.map((e) => e.path));
    keyFiles = [
      ...all.filter((e) => e.kind === "file" && KEY_FILE_NAMES.has(e.path.split("/").pop()!) && !e.path.includes("/")).map((e) => e.path),
      ...KEY_ENTRY_PATHS.filter((p) => paths.has(p)),
      ...all.filter((e) => e.kind === "dir" && KEY_DIR_NAMES.has(e.path)).map((e) => e.path),
    ].sort();
    keyFiles = [...new Set(keyFiles)];
  }

  return {
    truncated,
    nextCursor: truncated ? String(consumed) : null,
    entries: slice,
    keyFiles,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/repoMap.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 承重性验证**

去掉 `all.sort(...)` 那一行，确认「顺序确定且是全局字典序」那条变红；还原后确认变绿。
**把观察结果写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/repoMap.ts tests/repoMap.test.ts
git commit -m "feat(s0-b): repoMap 目录树与关键文件识别"
```

---


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
| 正则搜索 | 后续切片，需在 Worker/子进程里跑并硬性 kill（进程内跑调用方提供的正则是无界 CPU 逃生舱：`new RegExp("(a+)+$").test("a".repeat(40)+"b")` 实测耗时 55,661 ms，把预算检查放进逐行循环挡不住单次 `re.test()` 不返回） |
| `repoMap` 的时间预算 | 未设计：`repoSearch` 有 `budgetMs` 是因为逐文件扫描天然可在文件边界打断；`repoMap` 的 `walk` 是否也需要同等的可中断预算、中断后如何续page，是独立的设计问题，不在本切片顺手加 |