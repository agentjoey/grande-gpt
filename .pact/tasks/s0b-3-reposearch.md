# s0b-3-reposearch

> 本文件是 **S0B 切片**的第 3 个任务，从
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

### Task 3: `repoSearch` —— 带时间预算的搜索

**Files:**
- Create: `src/repoSearch.ts`
- Test: `tests/repoSearch.test.ts`

**Interfaces:**
- Consumes: 无（自行遍历，复用 Task 2 的跳过目录集合需自己声明一份，**不要**从
  `repoMap.ts` 导出内部常量 —— 那会把一个内部细节变成跨模块契约）
- Produces:
  - `interface SearchMatch { path: string; line: number; text: string; before: string[]; after: string[] }`
  - `interface SearchResult { truncated: boolean; nextCursor: string | null; timedOut: boolean; skippedOversized: number; matches: SearchMatch[] }`
  - `function repoSearch(root: string, pattern: string, opts?: { maxMatches?: number; budgetMs?: number; cursor?: string | null }): SearchResult`

**规格 §5.4②**：上限 50 条匹配 / 每条 3 行上下文（`CONTEXT_LINES = 1`：1 行前 + 命中行本身
+ 1 行后）/ **4s 预算**。到点即返回已有结果并标 `truncated`，**而不是搜到底** —— 搜到底
会撞上 ChatGPT 那个不可配置的 ~60s 工具超时。

**S0 只做字面量搜索，不支持调用方提供的正则**（范围收窄，详见下方实现的 JSDoc 与本文档
末尾「本切片明确不做」表）：`new RegExp("(a+)+$").test("a".repeat(40)+"b")` 在实测环境里
耗时 55,661 ms —— 一个 40 字节的输入就能把 ChatGPT 那个不可配置的 ~60s 工具超时撑爆，而
Node 的 `RegExp` 没有内置超时。把预算检查放进逐行循环挡不住这个：检查只在两次 `re.test()`
之间才有机会运行，单次 `re.test()` 本身就可能不返回。这是无界 CPU 消耗，违反铁律二
「没有通用逃生舱」。

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
    expect(m.before).toEqual(["line2"]);
    expect(m.after).toEqual(["line4"]);
  });

  it("pattern 恒按字面量处理，特殊字符不被当成正则元字符；调用方传 regex 选项直接拒绝", () => {
    // S0 不支持调用方提供的正则：进程内跑调用方给的正则是无界 CPU 逃生舱
    // （见 repoSearch 顶部 JSDoc 的实测数据），违反铁律二。
    file("src/a.ts", "a.b\naxb\n");
    expect(repoSearch(root, "a.b").matches.map((m) => m.text)).toEqual(["a.b"]);
    expect(() =>
      repoSearch(root, "a.b", { regex: true } as unknown as Parameters<typeof repoSearch>[2]),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("跳过 .git、node_modules 与二进制文件", () => {
    file(".git/config", "NEEDLE\n");
    file("node_modules/p/i.js", "NEEDLE\n");
    file("bin.dat", "NEEDLE\0binary\n");
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

  it("顺序确定且是全局字典序（跨目录也成立）", () => {
    // 只在一个目录里放文件的话，DFS 顺序碰巧等于全局字典序，这条断言就抓不到东西。
    // src/ 与 src.ts 才是分水岭："." (0x2E) < "/" (0x2F)。
    for (const n of ["z.ts", "a.ts", "m.ts"]) file(`src/${n}`, "NEEDLE\n");
    file("src.ts", "NEEDLE\n");
    const a = repoSearch(root, "NEEDLE").matches.map((m) => m.path);
    expect(a).toEqual(repoSearch(root, "NEEDLE").matches.map((m) => m.path));
    expect(a).toEqual([...a].sort());
  });

  it("时间预算到点即返回，标记 timedOut，且【已找到的结果不丢】、仍可续取", () => {
    // budgetMs=0 保证第一次检查就超预算。关键断言是 timedOut 为 true 而不是抛错——
    // 撞上 ChatGPT 那个不可配置的 ~60s 超时的后果，比返回部分结果糟糕得多。
    for (let i = 0; i < 50; i++) file(`src/f${String(i).padStart(2, "0")}.ts`, "NEEDLE\n");
    const r = repoSearch(root, "NEEDLE", { budgetMs: 0 });
    expect(r.timedOut).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.matches).toHaveLength(1); // 已找到的不丢
    expect(r.matches[0]!.path).toBe("src/f00.ts");
    expect(r.nextCursor).toBe("1"); // 可续取

    const rest = repoSearch(root, "NEEDLE", { cursor: r.nextCursor, maxMatches: 100 });
    expect(rest.matches.map((m) => m.path)).not.toContain("src/f00.ts");
  });

  it("超过大小上限的文件被跳过，但计数体现在 skippedOversized 里而不是静默消失", () => {
    file("src/ok.ts", "NEEDLE\n");
    file("src/huge.ts", `NEEDLE\n${"x".repeat(2 * 1024 * 1024)}`);
    const r = repoSearch(root, "NEEDLE");
    expect(r.matches.map((m) => m.path)).toEqual(["src/ok.ts"]);
    expect(r.skippedOversized).toBe(1);
  });

  it("字段声明顺序：truncated/nextCursor/timedOut/skippedOversized 必须排在 matches 之前", () => {
    file("a.ts", "NEEDLE\n");
    const keys = Object.keys(repoSearch(root, "NEEDLE"));
    for (const k of ["truncated", "nextCursor", "timedOut", "skippedOversized"]) {
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
  skippedOversized: number;
  matches: SearchMatch[];
}

/** 与 repoMap 各自声明一份：跳过哪些目录是每个模块自己的策略，不是跨模块契约 */
const SKIP_DIRS = new Set([".git", "node_modules", ".grande-work"]);
// 规格 §5.4②：每条 3 行上下文 = 1 行前 + 命中行本身 + 1 行后。
const CONTEXT_LINES = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function listFiles(root: string, dir: string, out: string[], stats: { skippedOversized: number }): void {
  // 根目录读不到是调用方的错，要报出来；子目录读不到（权限/竞态删除）不该让
  // 整棵搜索失败——与 repoMap 的 walk 同一套区分方式。
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    if (dir === root) {
      throw new SearchError("INVALID_INPUT", `无法读取仓库根 ${root}：${(e as Error).message}`);
    }
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listFiles(root, abs, out, stats);
    } else if (st.isFile()) {
      if (st.size <= MAX_FILE_BYTES) out.push(abs);
      else stats.skippedOversized++; // 静默跳过会让模型误以为「搜过了没有」；在结果里报出计数
    }
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
 *
 * **只支持字面量匹配，不支持调用方提供的正则**（S0 范围收窄，见 CLAUDE.md 铁律二
 * 「没有通用逃生舱」）：正则的灾难性回溯是无界 CPU 消耗，且 Node 的 `RegExp` 没有
 * 内置超时——`new RegExp("(a+)+$").test("a".repeat(40)+"b")` 在这台机器上实测耗时
 * 55,661 ms，一个 40 字节的输入就能把 ChatGPT 那个不可配置的 ~60s 工具超时撑爆。
 * 把预算检查放进逐行循环挡不住这个：预算检查是在两次 `re.test()` 之间才有机会
 * 运行，而单次 `re.test()` 本身就可能不返回。要重新开放正则匹配，必须先把匹配
 * 移进 Worker/子进程并对它做硬性 kill（`terminate()`/`SIGKILL`），留给后续切片。
 */
export function repoSearch(
  root: string,
  pattern: string,
  opts?: { maxMatches?: number; budgetMs?: number; cursor?: string | null },
): SearchResult {
  if (opts && "regex" in opts) {
    throw new SearchError(
      "INVALID_INPUT",
      "S0 只支持字面量搜索，不支持调用方提供的正则：进程内运行调用方给的正则是一个" +
        "无界 CPU 逃生舱（灾难性回溯可以让单次匹配耗时数万毫秒，且 Node 的 RegExp 没有" +
        "超时机制），违反铁律二「没有通用逃生舱」。",
    );
  }
  const maxMatches = opts?.maxMatches ?? 50;
  const budgetMs = opts?.budgetMs ?? 4000;
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new SearchError("INVALID_INPUT", `cursor 必须是非负整数，收到：${opts?.cursor}`);
  }
  if (pattern.length === 0) throw new SearchError("INVALID_INPUT", "pattern 不能为空");

  // pattern 恒按字面量处理：escapeRegExp 把每个正则特殊字符都转义掉，理论上不应该
  // 再编译失败。仍然保留这层 try/catch（而不是假设它绝对安全）——万一某个未预见的
  // 输入让编译失败，也要转成带 .code 的 SearchError，而不是让裸 SyntaxError 逃出
  // 本模块（I1 的同一条要求：每条失败都带结构化 .code）。
  let re: RegExp;
  try {
    re = new RegExp(escapeRegExp(pattern));
  } catch (e) {
    throw new SearchError("INVALID_INPUT", `pattern 无法用于匹配：${(e as Error).message}`);
  }

  const started = Date.now();
  const files: string[] = [];
  const stats = { skippedOversized: 0 };
  listFiles(root, root, files, stats);
  // 与 repoMap 一致：全局排序。listFiles 只在每个目录内排序，得到的是 DFS 顺序 ——
  // `src/a.ts` 与 `src.ts` 就会排反（"." < "/"）。cursor 是偏移量，续取的正确性
  // 依赖两次调用的顺序完全一致，不排就只是「碰巧一致」。
  files.sort();

  const found: SearchMatch[] = [];
  let timedOut = false;

  // 需要收集 offset + maxMatches + 1 条才能既跳过已给出的、又判断还有没有更多
  const need = offset + maxMatches + 1;

  outer: for (const abs of files) {
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // 二进制判定：NUL 字节。写成 \0 转义而不是源码里嵌一个真的 NUL —— 那个字节
    // 在任何渲染器/编辑器/剪贴板里都是不可见的，抄错了没人看得出来。
    if (content.includes("\0")) continue;

    const lines = content.split("\n");
    const rel = relative(root, abs).split(sep).join("/");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      found.push({
        path: rel,
        line: i + 1,
        text: lines[i]!,
        before: lines.slice(Math.max(0, i - CONTEXT_LINES), i),
        after: lines.slice(i + 1, i + 1 + CONTEXT_LINES),
      });
      if (found.length >= need) break outer;
    }

    // 预算检查放在**处理完一个文件之后**，两个理由：
    // ① 保证每次调用至少推进一个文件，否则 budgetMs=0 的行为取决于 Date.now() 的
    //    毫秒边界 —— 实测 100 次里有 8 次「还没超预算」，是一条会随机变红的测试；
    // ② 到点时已找到的结果留在 found 里，这才是「已找到的结果不丢」。
    if (Date.now() - started >= budgetMs) {
      timedOut = true;
      break;
    }
  }

  const slice = found.slice(offset, offset + maxMatches);
  const consumed = offset + slice.length;
  const truncated = timedOut || consumed < found.length;

  return {
    truncated,
    nextCursor: truncated ? String(consumed) : null,
    timedOut,
    skippedOversized: stats.skippedOversized,
    matches: slice,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/repoSearch.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 承重性验证**

把循环末尾的预算检查 `if (Date.now() - started >= budgetMs)` 改成恒 `false`，确认
「时间预算到点即返回」那条变红；还原后确认变绿。**把观察结果写进报告。**

- [ ] **Step 6: 提交**

```bash
git add src/repoSearch.ts tests/repoSearch.test.ts
git commit -m "feat(s0-b): repoSearch 带时间预算的仓库搜索"
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