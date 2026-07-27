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
  - `function assertWritableResolved(repoRoot: string, absolutePath: string, rules: DenyRules): void`

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

  it("配置格式非法时响亮地失败，而不是静默退回默认值", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes: 42\n", "utf8");
    expect(() => loadDenyRules(l)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("用户配置无法移除内置项：显式给空表也拿不掉 .git（AC-14 的底线）", () => {
    const l = loadLayout();
    ensureLayout(l);
    // 这才是真正的攻击形状：不是「忘了写 .git」，是「刻意写一张不含 .git 的表」。
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes: []\n", "utf8");
    expect(loadDenyRules(l).prefixes).toContain(".git/");
  });

  it("配置只能追加不能替换：给了别的前缀，.git 依然在表里", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes:\n  - node_modules/\n", "utf8");
    const rules = loadDenyRules(l);
    expect(rules.prefixes).toContain("node_modules/");
    expect(rules.prefixes).toContain(".git/");
  });

  it("拒绝表只从控制平面读：函数签名里根本没有仓库路径这个入口", () => {
    // 铁律一是**结构性**保证，不是运行时检查：loadDenyRules 只拿 Layout，
    // 没有任何参数能让它去看仓库。这条断言把这个形状钉住，防止以后有人
    // 「顺手」加一个 repoRoot 参数做「项目级 deny 覆盖」。
    expect(loadDenyRules.length).toBe(1);
  });

  it("拒绝以 / 开头的 prefixes 条目（响亮失败，而不是留一条永远不会命中的规则）", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes:\n  - /etc/passwd\n", "utf8");
    expect(() => loadDenyRules(l)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("拒绝包含 .. 的 prefixes 条目（拒绝表只表达仓库内相对路径，不该有向上穿越的能力）", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes:\n  - ../outside\n", "utf8");
    expect(() => loadDenyRules(l)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, normalize, relative, sep } from "node:path";
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
          // 拒绝表只应表达仓库内相对路径的收窄，没有理由指向仓库之外或向上穿越——
          // `/` 开头看着像绝对路径（对拒绝表没有意义），`..` 试图向上走出仓库。
          // 两者都不是「配置写错了会漏拒绝」，而是「配置写错了会拒绝到奇怪的地方」；
          // 响亮地拒绝配置本身，好过默默留一条永远不会命中的规则。
          if (p.startsWith("/")) {
            throw new PolicyError(
              "BAD_CONFIG",
              `${file} 的 prefixes 条目不能以 / 开头（拒绝表只表达仓库内相对路径）：${p}`,
            );
          }
          if (p.split("/").includes("..")) {
            throw new PolicyError("BAD_CONFIG", `${file} 的 prefixes 条目不能包含 ..：${p}`);
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
 * 判定一个**已解析**的仓库内相对路径是否可写。三件事缺一不可：
 *
 * 1. 先 `normalize`，否则 `src/../.git/config` 这种绕行写法会漏网；
 * 2. **大小写不敏感比对** —— macOS APFS 默认大小写不敏感，`.GIT/hooks/pre-commit`
 *    落盘就是 `.git/hooks/pre-commit`（已实测写穿）。在大小写敏感的文件系统上这会误杀
 *    一个真名叫 `.GIT` 的目录 —— 那是安全的失败方向，接受；
 * 3. **内置项恒生效**：不管调用方传进来的 `rules` 是什么，`BUILTIN_PREFIXES` 都参与比对。
 *    否则 `repoEdit(root, ops, { prefixes: [] })` 一行就关掉了 AC-14，硬门禁降级成
 *    「调用方自觉」（铁律三）。
 *
 * **必须传解析后的路径**（见 `assertWritableResolved`）：拿模型给的原始字符串判定会被
 * 仓内符号链接绕过（`vendor -> .git`，已实测写穿到 `.git/hooks/pre-commit`）。
 */
export function assertWritable(relativePath: string, rules: DenyRules): void {
  const probe = normalize(relativePath).split(sep).join("/").toLowerCase();
  for (const prefix of [...BUILTIN_PREFIXES, ...rules.prefixes]) {
    const bare = prefix.slice(0, -1);
    if (probe === bare.toLowerCase() || probe.startsWith(prefix.toLowerCase())) {
      throw new PolicyError(
        "POLICY_DENIED",
        `${relativePath} 命中仓内敏感路径拒绝表（${bare}）。` +
          `这类路径能在沙箱之外执行宿主命令（如 .git/hooks/pre-commit、core.pager），` +
          `因此写工具一律不可触及。`,
      );
    }
  }
}

/**
 * 规格 §4.6 字面要求的那道门：**在 `resolveInRepo` 之后**，用解析结果相对 canonical
 * 仓库根算出的路径再过一次拒绝表。这是唯一能挡住仓内符号链接的形式 —— `resolveInRepo`
 * 只保证「解析后仍在仓库之内」，而 `vendor -> .git` 完全满足这一条。
 * 原始字符串那一道（`assertWritable`）仍然保留：它便宜，且报错时引用的是模型自己给的
 * 路径，比引用一个它没见过的绝对路径有用。
 */
export function assertWritableResolved(repoRoot: string, absolutePath: string, rules: DenyRules): void {
  const realRoot = realpathSync(repoRoot);
  const rel = relative(realRoot, absolutePath).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../")) {
    throw new PolicyError("POLICY_DENIED", `${absolutePath} 解析后不在仓库 ${realRoot} 之内`);
  }
  assertWritable(rel, rules);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/policy.test.ts`
Expected: PASS（7 + 10 = 17 个用例）

- [ ] **Step 5: 承重性验证**

把 `assertWritable` 里 `probe` 的赋值改成直接用 `relativePath`（即去掉 `normalize`），
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
