# s0b-1-policy

> 本文件是 **S0B 切片**的第 1 个任务，从
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