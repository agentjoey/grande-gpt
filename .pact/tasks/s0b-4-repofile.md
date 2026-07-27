# s0b-4-repofile

> 本文件是 **S0B 切片**的第 4 个任务，从
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

### Task 4: `repoFile` —— 读（返 sha256）与改（校验 sha256）

**Files:**
- Create: `src/repoFile.ts`
- Test: `tests/repoFile.test.ts`

**Interfaces:**
- Consumes: `resolveInRepo`（`src/paths.ts`）、`assertWritable`、`assertWritableResolved` 与
  `DenyRules`（`src/policy.ts`）、`truncateText`（`src/envelope.ts`）
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DenyRules } from "../src/policy.ts";
import { repoEdit, repoRead, type EditOp } from "../src/repoFile.ts";

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

  it("lineRange 覆盖到文件真实末尾（含末尾换行）时不误标 truncated", () => {
    // full.split("\n") 对以换行结尾的文件会多出一个幻影空行；lineRange 取到「真实
    // 最后一行」时，若拿幻影行的下标去比较，会把「已经给了整份文件」误判成截断。
    file("a.ts", "l1\nl2\nl3\n");
    const r = repoRead(root, "a.ts", { lineRange: [1, 3] });
    expect(r.content).toBe("l1\nl2\nl3");
    expect(r.truncated).toBe(false);
  });

  it("文件不存在时抛带码的错误", () => {
    expect(() => repoRead(root, "nope.ts")).toThrow(expect.objectContaining({ code: "FILE_NOT_FOUND" }));
  });

  it("路径逃逸被 resolveInRepo 挡住", () => {
    expect(() => repoRead(root, "../outside.ts")).toThrow(expect.objectContaining({ code: "PATH_ESCAPE" }));
  });

  it("拒绝读取二进制文件（含 NUL 字节）：不产出可被 repoEdit 复用的 sha256", () => {
    // 直接按 utf8 解码二进制内容会产出 U+FFFD 乱码；若照旧返回一个 sha256，
    // repoEdit 的 staleness 校验会「对上」这个乱码的哈希，modify 就能用文本内容
    // 覆盖掉二进制文件——这一步在 S0（无 Checkpoint）不可逆。
    const p = join(root, "img.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
    expect(() => repoRead(root, "img.png")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("拒绝读取超过 8MB 的文件，不整份读入内存", () => {
    const p = join(root, "huge.txt");
    writeFileSync(p, Buffer.alloc(8 * 1024 * 1024 + 1, "a"));
    expect(() => repoRead(root, "huge.txt")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
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

  it("拒绝表用【解析后】的路径判定：仓内符号链接不能绕过 AC-14", () => {
    // resolveInRepo 的契约只有「解析后仍在仓库之内」，vendor -> .git 完全满足这一条。
    // 用模型给的原始字符串判拒绝表，这一条就直接写穿到 .git/hooks/pre-commit。
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    symlinkSync(join(root, ".git"), join(root, "vendor"));
    expect(() =>
      repoEdit(root, [{ op: "create", path: "vendor/hooks/pre-commit", content: "#!/bin/sh\n" }], RULES),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("拒绝表大小写不敏感：macOS APFS 上 .GIT/ 就是 .git/", () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    expect(() =>
      repoEdit(root, [{ op: "create", path: ".GIT/hooks/pre-commit", content: "#!/bin/sh\n" }], RULES),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("内置拒绝项不可由调用方参数放宽（铁律三：硬门禁不接受调用方自觉）", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(() =>
      repoEdit(root, [{ op: "create", path: ".git/config", content: "x" }], { prefixes: [] }),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("同一批里对同一路径的不同写法也被拒（./x.ts 与 x.ts 是同一个文件）", () => {
    expect(() =>
      repoEdit(
        root,
        [
          { op: "create", path: "x.ts", content: "a" },
          { op: "create", path: "./x.ts", content: "b" },
        ],
        RULES,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(existsSync(join(root, "x.ts"))).toBe(false);
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

  it("不提供删除能力：运行时拒绝任何未知 op，包括 delete（规格 §5.3）", () => {
    // 规格 §5.3：S0 没有 Checkpoint，删除不可撤销。若支持删除就必须标
    // destructiveHint: true，导致每次弹框且无法「记住」。
    // 类型层挡不住 S0-D 那边解出来的 JSON —— 所以运行时也要挡。
    file("a.ts", "v1");
    expect(() =>
      repoEdit(root, [{ op: "delete", path: "a.ts" } as unknown as EditOp], RULES),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(read("a.ts")).toBe("v1");
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
import { assertWritable, assertWritableResolved, type DenyRules } from "./policy.ts";

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
const MAX_READ_BYTES = 8 * 1024 * 1024;

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
  // 按字节读、按字节判定，再决定要不要解成字符串。
  // 直接 readFileSync(abs,"utf8") 会把非法字节换成 U+FFFD，而 repoEdit 的 staleness
  // 校验哈希的是同一个解码结果 —— sha256 会「对得上」，modify 于是放行，二进制文件
  // 被一堆 U+FFFD 覆盖。S0 没有 Checkpoint（§5.3），这一步不可逆。
  const raw = readFileSync(abs);
  if (raw.byteLength > MAX_READ_BYTES) {
    throw new EditError("INVALID_INPUT", `${relativePath} 超过 ${MAX_READ_BYTES} 字节，拒绝整文件读入`);
  }
  if (raw.includes(0)) {
    throw new EditError("INVALID_INPUT", `${relativePath} 是二进制文件（含 NUL 字节）；S0 的读写工具只处理文本`);
  }
  const full = raw.toString("utf8");
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
    // full.split("\n") 在文件以换行结尾时会多出一个幻影空行（"a\n".split("\n") ===
    // ["a", ""]）；不扣掉它，读到真正的文件末尾也会被误判成 truncated。
    truncated = from > 1 || to < lines.length - (full.endsWith("\n") ? 1 : 0);
  }

  const capped = truncateText(body, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  return {
    truncated: truncated || capped.truncated,
    path: relativePath,
    sha256: digest,
    bytes: raw.byteLength,
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
  // `seen` 按**解析后的绝对路径**去重，不按原始字符串：`x.ts` 与 `./x.ts` 是同一个文件，
  // 按字符串去重会让同一批里的第二个 op 静默覆盖第一个（已实测）。
  const seen = new Set<string>();
  const resolved: { op: EditOp; abs: string; absTo?: string }[] = [];

  for (const op of ops) {
    if (op.op !== "create" && op.op !== "modify" && op.op !== "move") {
      throw new EditError("INVALID_INPUT", `不支持的 op：${JSON.stringify((op as { op: unknown }).op)}`);
    }

    const abses: string[] = [];
    for (const p of pathsOf(op)) {
      assertWritable(p, rules);                // 廉价前置判定，报错引用模型给的原始路径
      const a = resolveInRepo(root, p);        // 路径物理安全：穿越 / 绝对 / 符号链接逃逸
      assertWritableResolved(root, a, rules);  // 规格 §4.6：resolveInRepo **之后**再过一道
      if (seen.has(a)) {
        throw new EditError("INVALID_INPUT", `同一批中对 ${p} 有多个操作；请拆成多次调用`);
      }
      seen.add(a);
      abses.push(a);
    }

    if (op.op === "move") {
      const from = abses[0]!;
      const to = abses[1]!;
      if (!existsSync(from)) throw new EditError("FILE_NOT_FOUND", `源文件不存在：${op.from}`);
      if (existsSync(to)) throw new EditError("FILE_EXISTS", `目标已存在：${op.to}`);
      resolved.push({ op, abs: from, absTo: to });
      continue;
    }

    const abs = abses[0]!;
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
Expected: PASS（9 + 14 = 23 个用例）

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
| 正则搜索 | 后续切片，需在 Worker/子进程里跑并硬性 kill（进程内跑调用方提供的正则是无界 CPU 逃生舱：`new RegExp("(a+)+$").test("a".repeat(40)+"b")` 实测耗时 55,661 ms，把预算检查放进逐行循环挡不住单次 `re.test()` 不返回） |
| `repoMap` 的时间预算 | 未设计：`repoSearch` 有 `budgetMs` 是因为逐文件扫描天然可在文件边界打断；`repoMap` 的 `walk` 是否也需要同等的可中断预算、中断后如何续page，是独立的设计问题，不在本切片顺手加 |