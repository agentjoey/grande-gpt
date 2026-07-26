# S0-A 控制平面骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 S0 的地基 —— 目录布局、路径安全、仓库注册表、SQLite 状态与审计账本、响应信封、只读 CLI。不含任何 MCP、git、worktree 或沙箱逻辑。

**Architecture:** 两个物理根：代码工作区 `GPT_Workspace/`（可写、被审计）与控制平面 `~/.grande-control/`（状态、配置、审计 —— 沙箱不可见）。所有对外可见的路径解析都收敛在一个模块，所有状态变更都先落 `INTENT` 审计再执行。CLI 与将来的 Gateway 共用同一份读取逻辑。

**Tech Stack:** Node 24 · TypeScript 5 · pnpm · `node:sqlite`（内置，零依赖）· `yaml` · vitest 4

## 这是第一块真正的 S0 代码

`poc/` 与 `spike/` 都是一次性的，**不要从它们 import**。可以参考其中已被验证的设计（信封字段序、`realpathSync` 的教训），但代码要在 `src/` 重写并配自己的测试。

## Global Constraints

取自规格 `docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`，**每个任务隐含包含本节**。

- **两个根，职责分离**：代码工作区在 `GPT_Workspace/`，控制平面状态在 `~/.grande-control/`。
  理由是**被审计者不能拥有审计记录的写权限**（D3）——将来沙箱可写 worktree，
  若审计库也在同一棵树下，被测代码就能篡改自己的审计记录。
- **`repoId` 即 `GPT_Workspace` 下的目录名**（§4.2）。Gateway 解析 `GPT_Workspace/<repoId>`
  并校验它是**直接子目录**且**已注册**。自动发现只产生候选，必须显式注册后才可见。
- **原地模型**（D4）：`GPT_Workspace/<repoId>/` 就是 canonical checkout，不做 bare mirror。
- **响应信封字段固定**：`ok` / `taskId` / `truncated` / `nextCursor` / `hint` / `data` / `taskContext`；
  失败为 `ok:false` + `error{code,message,retryable,details}`。
  **`truncated`/`nextCursor`/`hint` 必须序列化在 `data` 之前** —— ChatGPT 会静默截断超大响应，
  排在几十 KB 的 `data` 之后就可能永远看不到（POC 实测：读大文件时这三个字段曾落在第 73,896 字节）。
- **审计先写 `INTENT` 再执行**（§8.1）。业务执行与审计不是单一事务，但未完成状态必须可被发现。
- **S0 数据模型不含**：`lease`、`checkpoint`、`trash`、`userId`。
- **CLI 只读**，不提供任何变更能力（§8.2）。
- Node 24 原生剥离 TypeScript 类型，脚本不加 `--experimental-strip-types`。
- 严格 TS：`strict: true`、`noUncheckedIndexedAccess: true`。

## 依赖取舍（已定，勿改）

| 选择 | 理由 |
|---|---|
| **`node:sqlite`（内置）** 而非 `better-sqlite3` | 零依赖，与项目「能力面最小」主线一致。已实测：WAL、事务、命名参数、唯一约束报错均可用。**代价**：Node 标注为 experimental，API 可能随 Node 升级变化；用 `--disable-warning=ExperimentalWarning` **精确**屏蔽那一条警告（不是全局关警告），且 Node 版本锁定 24 |
| **`yaml`** 一个依赖 | 配置是**人手编辑**的可信文件（D8），需要注释；JSON 不支持注释。`yaml` 是纯 JS、无原生代码 |

**注意 `node:sqlite` 的一个行为**：`stmt.get()` 返回 **null-prototype 对象**。vitest 的 `toEqual`
能处理，但 `toStrictEqual` 会失败。断言时用 `toEqual`，或先 `{...row}` 展开。

## 环境变量（两个，都必须显式提供）

| 变量 | 含义 | 缺失时 |
|---|---|---|
| `GRANDE_WORKSPACE` | 代码工作区根的绝对路径 | **启动失败并给出明确错误**，不猜测、不用默认值 |
| `GRANDE_CONTROL` | 控制平面根 | 默认 `~/.grande-control` |

不给 `GRANDE_WORKSPACE` 默认值是刻意的：猜错工作区意味着在错误的目录树上执行操作，
失败得响比失败得静默好。测试通过设置这两个变量指向临时目录来隔离。

---

## File Structure

```
src/
├── layout.ts      # 两个根的解析与目录创建。唯一知道目录结构的地方
├── envelope.ts    # 响应信封 + 截断工具。纯函数
├── paths.ts       # repoId → 绝对路径的安全解析。唯一允许把外部输入变成路径的地方
├── registry.ts    # 仓库注册表：读写 repos.yaml、自动发现候选
├── db.ts          # SQLite 连接、pragma、schema
├── tasks.ts       # task 表读写
├── jobs.ts        # job 表读写
├── audit.ts       # 审计账本，INTENT 先行
└── cli.ts         # grande CLI（只读），进程入口
tests/
└── <每个模块一个 .test.ts>
```

**职责边界**：`paths.ts` 是**唯一**允许把外部输入（`repoId`）变成文件系统路径的模块 ——
路径安全集中在一处才审得动。`layout.ts` 是**唯一**知道目录结构的地方，其余模块问它要路径，
不自己拼。`db.ts` 只管连接与 schema，业务表的读写各自成模块。

---

## Task 1: 脚手架、目录布局与响应信封

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`（修改根目录已有的）
- Create: `src/layout.ts`, `src/envelope.ts`
- Test: `tests/layout.test.ts`, `tests/envelope.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface Layout { workspaceRoot: string; controlRoot: string; stateDb: string; configDir: string; reposConfig: string; artifactsDir: string; worktreesRoot: string; derivedRoot: string }`
  - `function loadLayout(): Layout` —— 从环境变量解析，缺 `GRANDE_WORKSPACE` 则抛错
  - `function ensureLayout(l: Layout): void` —— 创建控制平面目录（不创建工作区）
  - `interface TaskContext { branch: string; filesChanged: number; lastJob: string | null }`
  - `interface Envelope<T> { ok: true; taskId: string | null; truncated: boolean; nextCursor: string | null; hint: string; data: T; taskContext: TaskContext | null }`
  - `interface ErrorEnvelope { ok: false; taskId: string | null; error: { code: string; message: string; retryable: boolean; details: Record<string, unknown> } }`
  - `function ok<T>(a: { taskId?: string | null; data: T; hint: string; truncated?: boolean; nextCursor?: string | null; taskContext?: TaskContext | null }): Envelope<T>`
  - `function err(a: { taskId?: string | null; code: string; message: string; retryable?: boolean; details?: Record<string, unknown> }): ErrorEnvelope`
  - `function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean }`
  - `function truncateList<T>(items: T[], max: number, offset?: number): { items: T[]; truncated: boolean; nextCursor: string | null }`

- [ ] **Step 1: 建脚手架**

`package.json`（仓库根目录）：

```json
{
  "name": "grande-gpt",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "grande": "./src/cli.ts" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "cli": "node --disable-warning=ExperimentalWarning src/cli.ts"
  },
  "dependencies": {
    "yaml": "2.8.1"
  },
  "devDependencies": {
    "@types/node": "24.10.1",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["poc", "spike"]
}
```

`vitest.config.ts`：

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // node:sqlite 是 experimental，会打一条警告。精确屏蔽这一条，
    // 而不是全局关警告——其它警告仍应可见。
    env: { NODE_OPTIONS: "--disable-warning=ExperimentalWarning" },
  },
});
```

仓库根的 `.gitignore` **不需要改** —— 它已经含有 `node_modules/`（第 2 行）与
`*.tsbuildinfo`（第 8 行）。不要重复追加。

Run: `cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt && pnpm install`
Expected: 安装成功，`pnpm ls yaml` 显示 `2.8.1`。

- [ ] **Step 2: 写 layout 的失败测试**

`tests/layout.test.ts`：

```typescript
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";

let ws: string;
let ctrl: string;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("loadLayout()", () => {
  it("从环境变量解析两个根", () => {
    const l = loadLayout();
    expect(l.workspaceRoot).toBe(ws);
    expect(l.controlRoot).toBe(ctrl);
  });

  it("缺 GRANDE_WORKSPACE 时抛出可操作的错误，而不是猜一个默认值", () => {
    delete process.env.GRANDE_WORKSPACE;
    expect(() => loadLayout()).toThrow(/GRANDE_WORKSPACE/);
  });

  it("GRANDE_CONTROL 缺省时回退到 ~/.grande-control", () => {
    delete process.env.GRANDE_CONTROL;
    expect(loadLayout().controlRoot).toBe(join(process.env.HOME ?? "", ".grande-control"));
  });

  it("拒绝相对路径的 GRANDE_WORKSPACE", () => {
    process.env.GRANDE_WORKSPACE = "relative/dir";
    expect(() => loadLayout()).toThrow(/绝对路径/);
  });

  it("解析符号链接——SBPL 与路径比较都要求 canonical 形式", () => {
    // 在 macOS 上 tmpdir() 通常是 /var/... 这样的符号链接；loadLayout 必须返回真实路径
    const l = loadLayout();
    expect(l.workspaceRoot.startsWith("/private/") || !ws.startsWith("/var/")).toBe(true);
  });

  it("控制平面的子路径全部落在 controlRoot 之下，且不在 workspaceRoot 之下", () => {
    const l = loadLayout();
    for (const p of [l.stateDb, l.configDir, l.reposConfig, l.artifactsDir]) {
      expect(p.startsWith(l.controlRoot)).toBe(true);
      expect(p.startsWith(l.workspaceRoot)).toBe(false);
    }
  });

  it("派生数据根在工作区之下（worktree 属于代码工作区）", () => {
    const l = loadLayout();
    expect(l.derivedRoot.startsWith(l.workspaceRoot)).toBe(true);
    expect(l.worktreesRoot.startsWith(l.derivedRoot)).toBe(true);
  });
});

describe("ensureLayout()", () => {
  it("创建控制平面目录", () => {
    const l = loadLayout();
    ensureLayout(l);
    expect(existsSync(l.configDir)).toBe(true);
    expect(existsSync(l.artifactsDir)).toBe(true);
  });

  it("幂等：重复调用不报错", () => {
    const l = loadLayout();
    ensureLayout(l);
    expect(() => ensureLayout(l)).not.toThrow();
  });

  it("不创建工作区根——那是用户的目录，不存在应当报错而不是被我们凭空造出来", () => {
    rmSync(ws, { recursive: true, force: true });
    expect(() => loadLayout()).toThrow(/不存在/);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm test tests/layout.test.ts`
Expected: FAIL —— 无法解析 `../src/layout.ts`

- [ ] **Step 4: 实现 layout.ts**

`src/layout.ts`：

```typescript
import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface Layout {
  /** 代码工作区根 = 可注册域。仓库以普通 checkout 形式作为其直接子目录存在 */
  workspaceRoot: string;
  /** 控制平面根：状态、配置、审计、artifact。**沙箱不可见** */
  controlRoot: string;
  stateDb: string;
  configDir: string;
  reposConfig: string;
  artifactsDir: string;
  /** 派生数据（worktree 等）。在工作区之下，因为它属于代码工作区而非控制平面 */
  derivedRoot: string;
  worktreesRoot: string;
}

/**
 * 从环境变量解析布局。
 *
 * `GRANDE_WORKSPACE` **没有默认值**是刻意的：猜错工作区意味着在错误的目录树上
 * 执行文件操作，失败得响远比失败得静默好。
 *
 * 两个根都做 `realpathSync`。原因不只是整洁：macOS 的 Seatbelt 在真实文件操作里
 * 解析符号链接、但**不**解析策略文本里的路径，未 canonical 化的路径会让 allow 规则
 * 过严、**deny 规则静默失效**（spike U2 实测）。路径比较同理——`/tmp/x` 与
 * `/private/tmp/x` 是同一个目录，字符串比较却不相等。统一在入口 canonical 化。
 */
export function loadLayout(): Layout {
  const rawWs = process.env.GRANDE_WORKSPACE;
  if (!rawWs) {
    throw new Error(
      "GRANDE_WORKSPACE 未设置。请指向代码工作区根的绝对路径，" +
        "例如 GRANDE_WORKSPACE=/Users/you/AgentWorks/GPT_Workspace",
    );
  }
  if (!isAbsolute(rawWs)) throw new Error(`GRANDE_WORKSPACE 必须是绝对路径，收到：${rawWs}`);
  if (!existsSync(rawWs)) throw new Error(`GRANDE_WORKSPACE 指向的目录不存在：${rawWs}`);

  const rawCtrl = process.env.GRANDE_CONTROL ?? join(homedir(), ".grande-control");
  if (!isAbsolute(rawCtrl)) throw new Error(`GRANDE_CONTROL 必须是绝对路径，收到：${rawCtrl}`);

  const workspaceRoot = realpathSync(rawWs);
  // controlRoot 可能还不存在（首次运行），先建再 realpath
  mkdirSync(rawCtrl, { recursive: true });
  const controlRoot = realpathSync(rawCtrl);

  const derivedRoot = join(workspaceRoot, ".grande-work");
  return {
    workspaceRoot,
    controlRoot,
    stateDb: join(controlRoot, "state", "grande.db"),
    configDir: join(controlRoot, "config"),
    reposConfig: join(controlRoot, "config", "repos.yaml"),
    artifactsDir: join(controlRoot, "artifacts"),
    derivedRoot,
    worktreesRoot: join(derivedRoot, "worktrees"),
  };
}

/** 创建控制平面目录。**不创建 workspaceRoot** —— 那是用户的目录。 */
export function ensureLayout(l: Layout): void {
  for (const d of [join(l.controlRoot, "state"), l.configDir, l.artifactsDir]) {
    mkdirSync(d, { recursive: true });
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test tests/layout.test.ts && pnpm typecheck`
Expected: 10 个用例全部 PASS。

- [ ] **Step 6: 写 envelope 的失败测试**

`tests/envelope.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { err, ok, truncateList, truncateText } from "../src/envelope.ts";

describe("ok()", () => {
  it("填充全部字段并对可选项取默认值", () => {
    expect(ok({ taskId: "task_a", data: { n: 1 }, hint: "下一步" })).toEqual({
      ok: true,
      taskId: "task_a",
      truncated: false,
      nextCursor: null,
      hint: "下一步",
      data: { n: 1 },
      taskContext: null,
    });
  });

  it("truncated / nextCursor / hint 序列化在 data 之前", () => {
    const json = JSON.stringify(ok({ data: { big: "x".repeat(100) }, hint: "h", truncated: true }));
    expect(json.indexOf('"truncated"')).toBeLessThan(json.indexOf('"data"'));
    expect(json.indexOf('"nextCursor"')).toBeLessThan(json.indexOf('"data"'));
    expect(json.indexOf('"hint"')).toBeLessThan(json.indexOf('"data"'));
  });
});

describe("err()", () => {
  it("retryable 默认 false，details 默认空对象", () => {
    expect(err({ taskId: "t", code: "STALE_FILE", message: "changed" })).toEqual({
      ok: false,
      taskId: "t",
      error: { code: "STALE_FILE", message: "changed", retryable: false, details: {} },
    });
  });
});

describe("truncateText()", () => {
  it("未超限时原样返回", () => {
    expect(truncateText("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("超限时按字节截断并标记", () => {
    const r = truncateText("abcdefghij", 4);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(4);
  });

  it("按字节而非字符截断，且不切出半个多字节字符", () => {
    const r = truncateText("中文中文", 5);
    expect(r).toEqual({ text: "中", truncated: true });
  });

  it("maxBytes 为 0 时返回空串", () => {
    expect(truncateText("中文", 0)).toEqual({ text: "", truncated: true });
  });

  it("截断点恰好落在字符边界时不多退一个字符", () => {
    expect(truncateText("中文", 3)).toEqual({ text: "中", truncated: true });
  });
});

describe("truncateList()", () => {
  it("未超限时 nextCursor 为 null", () => {
    expect(truncateList([1, 2], 5)).toEqual({ items: [1, 2], truncated: false, nextCursor: null });
  });

  it("超限时截断并给出下一页游标", () => {
    expect(truncateList([1, 2, 3, 4, 5], 2)).toEqual({ items: [1, 2], truncated: true, nextCursor: "2" });
  });

  it("带 offset 时返回下一页，而不是重复第一页", () => {
    expect(truncateList([1, 2, 3, 4, 5], 2, 2)).toEqual({ items: [3, 4], truncated: true, nextCursor: "4" });
  });

  it("翻到最后一页时 truncated 为 false、nextCursor 为 null——续读能终止", () => {
    expect(truncateList([1, 2, 3, 4, 5], 2, 4)).toEqual({ items: [5], truncated: false, nextCursor: null });
  });

  it("offset 越界时返回空页而不是报错", () => {
    expect(truncateList([1, 2], 2, 99)).toEqual({ items: [], truncated: false, nextCursor: null });
  });
});
```

- [ ] **Step 7: 运行确认失败**

Run: `pnpm test tests/envelope.test.ts`
Expected: FAIL —— 无法解析 `../src/envelope.ts`

- [ ] **Step 8: 实现 envelope.ts**

`src/envelope.ts`：

```typescript
export interface TaskContext {
  branch: string;
  filesChanged: number;
  lastJob: string | null;
}

/**
 * 字段声明顺序 = `JSON.stringify` 的输出顺序，这里是**有意为之**：
 * `truncated` / `nextCursor` / `hint` 必须排在 `data` 前面。
 *
 * 理由（POC 实测）：ChatGPT 会静默截断超大响应。读大文件时 `data` 可达数十 KB，
 * 若这三个信号字段排在其后，模型可能永远看不到它们——而它们恰恰是模型判断
 * 「要不要继续读」的唯一依据。实测中 `truncated` 一度出现在第 73,896 字节。
 */
export interface Envelope<T> {
  ok: true;
  taskId: string | null;
  truncated: boolean;
  nextCursor: string | null;
  hint: string;
  data: T;
  taskContext: TaskContext | null;
}

export interface ErrorEnvelope {
  ok: false;
  taskId: string | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export function ok<T>(a: {
  taskId?: string | null;
  data: T;
  hint: string;
  truncated?: boolean;
  nextCursor?: string | null;
  taskContext?: TaskContext | null;
}): Envelope<T> {
  return {
    ok: true,
    taskId: a.taskId ?? null,
    truncated: a.truncated ?? false,
    nextCursor: a.nextCursor ?? null,
    hint: a.hint,
    data: a.data,
    taskContext: a.taskContext ?? null,
  };
}

export function err(a: {
  taskId?: string | null;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}): ErrorEnvelope {
  return {
    ok: false,
    taskId: a.taskId ?? null,
    error: {
      code: a.code,
      message: a.message,
      retryable: a.retryable ?? false,
      details: a.details ?? {},
    },
  };
}

/**
 * 按 UTF-8 字节截断，不切出半个多字节字符。
 *
 * 回退原理：UTF-8 的 continuation byte 形如 `10xxxxxx`。若截断点落在 continuation byte 上，
 * 说明正处于某个多字节字符中间，向前回退到该字符起始处。
 * 例：「中文中文」取 5 字节 → buf[5]=0x87、buf[4]=0x96 均为 continuation，
 * 回退至 end=3（buf[3]=0xE6 是第二个「文」的首字节）→ 得到「中」。
 */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };

  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--;

  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * 分页取一批 items。`offset` 来自上一页回传的 `nextCursor`。
 *
 * 续读必须真的能翻页且能终止：POC 阶段 `cursor` 一度只是摆设（hint 让模型带 cursor
 * 再调，但工具 schema 不接受该参数，zod 静默剥掉），模型于是在同一页上死循环。
 */
export function truncateList<T>(
  items: T[],
  max: number,
  offset = 0,
): { items: T[]; truncated: boolean; nextCursor: string | null } {
  const page = items.slice(offset, offset + max);
  const truncated = offset + page.length < items.length;
  return {
    items: page,
    truncated,
    nextCursor: truncated ? String(offset + page.length) : null,
  };
}
```

- [ ] **Step 9: 运行确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: layout 10 + envelope 12 全部 PASS。

- [ ] **Step 10: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/layout.ts src/envelope.ts tests/layout.test.ts tests/envelope.test.ts
git commit -m "feat(s0): 目录布局与响应信封

两个物理根：代码工作区与控制平面。分开的理由是被审计者不能拥有审计
记录的写权限——将来沙箱可写 worktree，若审计库在同一棵树下，被测代码
就能篡改自己的审计记录。

GRANDE_WORKSPACE 刻意没有默认值：猜错工作区意味着在错误的目录树上
执行文件操作，失败得响远比失败得静默好。

两个根都做 realpathSync。不只是整洁——spike U2 实测过 macOS Seatbelt
在真实文件操作里解析符号链接、但不解析策略文本里的路径，未 canonical
化会让 deny 规则静默失效。

信封的字段声明顺序即序列化顺序，truncated/nextCursor/hint 排在 data
之前是有意的：ChatGPT 静默截断超大响应，这三个信号字段排在几十 KB 的
data 之后就可能永远看不到（POC 实测曾落在第 73,896 字节）。"
```

---

## Task 2: 路径安全与仓库注册表

**Files:**
- Create: `src/paths.ts`, `src/registry.ts`
- Test: `tests/paths.test.ts`, `tests/registry.test.ts`

**Interfaces:**
- Consumes: `Layout` from `../src/layout.ts`
- Produces:
  - `class PathSecurityError extends Error { readonly code: string }`
  - `function resolveRepoPath(layout: Layout, repoId: string, registered: ReadonlySet<string>): string`
  - `function resolveInRepo(repoRoot: string, relativePath: string): string`
  - `interface RepoEntry { repoId: string; path: string; registered: boolean }`
  - `function discoverRepos(layout: Layout): string[]` —— 工作区下的 git 仓库目录名（候选）
  - `function loadRegistry(layout: Layout): Map<string, RepoEntry>`
  - `function saveRegistry(layout: Layout, entries: Iterable<RepoEntry>): void`
  - `function registeredIds(layout: Layout): Set<string>`

**为什么这两个放在一个任务里**：注册表定义「什么算合法 repo」，路径安全强制它。
拆开会让任一半单独审起来缺少另一半的语境。

- [ ] **Step 1: 写路径安全的失败测试**

`tests/paths.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import { loadLayout } from "../src/layout.ts";
import { resolveInRepo, resolveRepoPath } from "../src/paths.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
const REGISTERED = new Set(["demo"]);

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  mkdirSync(join(ws, "demo"), { recursive: true });
  layout = loadLayout();
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("resolveRepoPath()", () => {
  it("已注册且存在的 repoId 解析为工作区下的直接子目录", () => {
    expect(resolveRepoPath(layout, "demo", REGISTERED)).toBe(join(layout.workspaceRoot, "demo"));
  });

  it("未注册的 repoId 被拒——自动发现只产生候选，注册才授权", () => {
    mkdirSync(join(ws, "unregistered"));
    expect(() => resolveRepoPath(layout, "unregistered", REGISTERED)).toThrow(/REPO_NOT_REGISTERED/);
  });

  it.each([
    ["..", "上级目录"],
    ["../escape", "相对穿越"],
    ["demo/nested", "非直接子目录"],
    ["/etc", "绝对路径"],
    [".", "当前目录"],
    ["", "空串"],
  ])("拒绝 %s（%s）", (bad) => {
    expect(() => resolveRepoPath(layout, bad, REGISTERED)).toThrow();
  });

  it("拒绝含分隔符的 repoId，即使它已被注册", () => {
    expect(() => resolveRepoPath(layout, "a/b", new Set(["a/b"]))).toThrow(/INVALID_INPUT/);
  });

  it("符号链接逃逸：repoId 指向工作区外的目录时必须被拒", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    symlinkSync(outside, join(ws, "escape"));
    expect(() => resolveRepoPath(layout, "escape", new Set(["escape"]))).toThrow(/PATH_ESCAPE/);
    rmSync(outside, { recursive: true, force: true });
  });

  it("目录不存在时报 REPO_NOT_FOUND，而不是返回一个不存在的路径", () => {
    expect(() => resolveRepoPath(layout, "ghost", new Set(["ghost"]))).toThrow(/REPO_NOT_FOUND/);
  });
});

describe("resolveInRepo()", () => {
  let repo: string;
  beforeEach(() => {
    repo = join(layout.workspaceRoot, "demo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "x");
  });

  it("解析仓库内的相对路径", () => {
    expect(resolveInRepo(repo, "src/a.ts")).toBe(join(repo, "src", "a.ts"));
  });

  it.each(["../outside", "../../etc/passwd", "/etc/passwd", "src/../../escape"])(
    "拒绝越界路径 %s",
    (bad) => {
      expect(() => resolveInRepo(repo, bad)).toThrow(/PATH_ESCAPE|INVALID_INPUT/);
    },
  );

  it("允许尚不存在的路径——创建新文件时目标本就不存在", () => {
    expect(resolveInRepo(repo, "src/new.ts")).toBe(join(repo, "src", "new.ts"));
  });

  it("符号链接逃逸：仓库内的链接指向仓库外时被拒", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside2-"));
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(outside, join(repo, "link"));
    expect(() => resolveInRepo(repo, "link/secret.txt")).toThrow(/PATH_ESCAPE/);
    rmSync(outside, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/paths.test.ts`
Expected: FAIL —— 无法解析 `../src/paths.ts`

- [ ] **Step 3: 实现 paths.ts**

`src/paths.ts`：

```typescript
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Layout } from "./layout.ts";

export class PathSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PathSecurityError";
    this.code = code;
  }
}

/** 判断 child 是否真的在 parent 之下（而不是只有字符串前缀相同，如 /a/bc vs /a/b） */
function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * 对一个可能尚不存在的路径求 canonical 形式：向上找到最近的存在祖先做 `realpathSync`，
 * 再把剩余部分拼回去。直接对不存在的路径 `realpathSync` 会抛 ENOENT，
 * 但创建新文件时目标本就不存在——不能因此拒绝。
 */
function realpathAllowingMissing(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return p; // 到根了仍不存在，原样返回
    tail.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  return join(realpathSync(existing), ...tail);
}

/**
 * `repoId` → 仓库根的绝对路径。
 *
 * `repoId` 就是 `GPT_Workspace` 下的目录名（规格 §4.2），**不是任意路径**。
 * 因此这里不做「路径拼接后再检查」，而是先否定一切含分隔符、含 `.`/`..`、
 * 绝对路径形式的输入——这样路径穿越在拼接之前就不可能发生。
 *
 * 之后仍要检查符号链接逃逸：`GPT_Workspace/x` 可以是一个指向工作区之外的链接，
 * 名字上完全合法。
 */
export function resolveRepoPath(layout: Layout, repoId: string, registered: ReadonlySet<string>): string {
  if (repoId.length === 0) {
    throw new PathSecurityError("INVALID_INPUT", "repoId 不能为空");
  }
  if (repoId.includes("/") || repoId.includes("\\") || isAbsolute(repoId)) {
    throw new PathSecurityError(
      "INVALID_INPUT",
      `repoId 必须是 ${layout.workspaceRoot} 下的目录名，不能包含路径分隔符：${repoId}`,
    );
  }
  if (repoId === "." || repoId === "..") {
    throw new PathSecurityError("INVALID_INPUT", `repoId 不能是 ${repoId}`);
  }
  if (!registered.has(repoId)) {
    throw new PathSecurityError(
      "REPO_NOT_REGISTERED",
      `仓库 ${repoId} 未注册。工作区下的仓库会被自动发现为候选，但必须显式注册后才可访问。`,
    );
  }

  const candidate = join(layout.workspaceRoot, repoId);
  if (!existsSync(candidate)) {
    throw new PathSecurityError("REPO_NOT_FOUND", `仓库目录不存在：${candidate}`);
  }

  const real = realpathSync(candidate);
  if (!isUnder(layout.workspaceRoot, real)) {
    throw new PathSecurityError(
      "PATH_ESCAPE",
      `仓库 ${repoId} 解析后落在工作区之外：${real}（工作区：${layout.workspaceRoot}）`,
    );
  }
  return real;
}

/**
 * 仓库内的相对路径 → 绝对路径。允许目标尚不存在（创建新文件）。
 * 解析后必须仍在仓库之内，符号链接也不能把它带出去。
 */
export function resolveInRepo(repoRoot: string, relativePath: string): string {
  if (relativePath.length === 0) {
    throw new PathSecurityError("INVALID_INPUT", "路径不能为空");
  }
  if (isAbsolute(relativePath)) {
    throw new PathSecurityError("INVALID_INPUT", `必须是仓库内的相对路径：${relativePath}`);
  }

  const real = realpathAllowingMissing(resolve(repoRoot, relativePath));
  const realRoot = realpathSync(repoRoot);
  if (!isUnder(realRoot, real)) {
    throw new PathSecurityError(
      "PATH_ESCAPE",
      `路径解析后落在仓库之外：${relativePath} → ${real}（仓库：${realRoot}）`,
    );
  }
  return real;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/paths.test.ts && pnpm typecheck`
Expected: 全部 PASS（含 6 个 `it.each` 与 4 个越界路径用例）。

- [ ] **Step 5: 写注册表的失败测试**

`tests/registry.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { discoverRepos, loadRegistry, registeredIds, saveRegistry } from "../src/registry.ts";

let ws: string;
let ctrl: string;
let layout: Layout;

function makeRepo(name: string, isGit = true): void {
  mkdirSync(join(ws, name), { recursive: true });
  if (isGit) mkdirSync(join(ws, name, ".git"), { recursive: true });
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("discoverRepos()", () => {
  it("发现工作区下的 git 仓库", () => {
    makeRepo("alpha");
    makeRepo("beta");
    expect(discoverRepos(layout).sort()).toEqual(["alpha", "beta"]);
  });

  it("跳过非 git 目录", () => {
    makeRepo("alpha");
    makeRepo("notarepo", false);
    expect(discoverRepos(layout)).toEqual(["alpha"]);
  });

  it("跳过派生数据目录 .grande-work——它不是仓库", () => {
    makeRepo("alpha");
    mkdirSync(join(ws, ".grande-work", "worktrees"), { recursive: true });
    mkdirSync(join(ws, ".grande-work", ".git"), { recursive: true });
    expect(discoverRepos(layout)).toEqual(["alpha"]);
  });

  it("跳过其它点开头的目录", () => {
    makeRepo("alpha");
    makeRepo(".hidden");
    expect(discoverRepos(layout)).toEqual(["alpha"]);
  });
});

describe("loadRegistry() / saveRegistry()", () => {
  it("配置不存在时返回空注册表，而不是报错", () => {
    expect(loadRegistry(layout).size).toBe(0);
  });

  it("写入后能读回", () => {
    makeRepo("alpha");
    saveRegistry(layout, [{ repoId: "alpha", path: join(ws, "alpha"), registered: true }]);
    const reg = loadRegistry(layout);
    expect(reg.get("alpha")?.registered).toBe(true);
  });

  it("写出的是带注释的 YAML，便于人手编辑（配置是可信输入，D8）", () => {
    saveRegistry(layout, [{ repoId: "alpha", path: join(ws, "alpha"), registered: true }]);
    const text = readFileSync(layout.reposConfig, "utf8");
    expect(text).toContain("repos:");
    expect(text).toContain("#");
  });

  it("registeredIds 只返回 registered 为 true 的", () => {
    saveRegistry(layout, [
      { repoId: "yes", path: join(ws, "yes"), registered: true },
      { repoId: "no", path: join(ws, "no"), registered: false },
    ]);
    expect([...registeredIds(layout)]).toEqual(["yes"]);
  });

  it("配置文件损坏时抛出可操作的错误，而不是静默当成空注册表", () => {
    writeFileSync(layout.reposConfig, "repos: [ this is : not valid yaml", "utf8");
    expect(() => loadRegistry(layout)).toThrow(/repos\.yaml/);
  });

  it("拒绝含路径分隔符的 repoId——它必须是目录名", () => {
    writeFileSync(layout.reposConfig, "repos:\n  - repoId: a/b\n    registered: true\n", "utf8");
    expect(() => loadRegistry(layout)).toThrow(/a\/b/);
  });
});
```

- [ ] **Step 6: 运行确认失败**

Run: `pnpm test tests/registry.test.ts`
Expected: FAIL —— 无法解析 `../src/registry.ts`

- [ ] **Step 7: 实现 registry.ts**

`src/registry.ts`：

```typescript
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Layout } from "./layout.ts";

export interface RepoEntry {
  repoId: string;
  /** 仅供人阅读；权威路径由 resolveRepoPath 从 repoId 推导，不采信此字段 */
  path: string;
  registered: boolean;
}

/** 派生数据目录，不是仓库 */
const DERIVED_DIR = ".grande-work";

/**
 * 扫描工作区下的 git 仓库，返回**候选** repoId。
 *
 * 注意这只是发现，不是授权：规格 §4.2 要求「自动发现为候选，但必须显式注册后
 * ChatGPT 才可见」。把新项目放进工作区不等于自动授权。
 */
export function discoverRepos(layout: Layout): string[] {
  return readdirSync(layout.workspaceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith(".") && name !== DERIVED_DIR)
    .filter((name) => existsSync(join(layout.workspaceRoot, name, ".git")))
    .sort();
}

interface RegistryFile {
  repos?: Array<{ repoId?: unknown; path?: unknown; registered?: unknown }>;
}

export function loadRegistry(layout: Layout): Map<string, RepoEntry> {
  const out = new Map<string, RepoEntry>();
  if (!existsSync(layout.reposConfig)) return out;

  let doc: RegistryFile;
  try {
    doc = (parse(readFileSync(layout.reposConfig, "utf8")) ?? {}) as RegistryFile;
  } catch (e) {
    // 静默当成空注册表会让「配置写坏了」表现为「所有仓库都消失了」——
    // 那是最难排查的一类故障。宁可响亮地失败。
    throw new Error(
      `无法解析 ${layout.reposConfig}：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  for (const raw of doc.repos ?? []) {
    const repoId = raw.repoId;
    if (typeof repoId !== "string" || repoId.length === 0) {
      throw new Error(`${layout.reposConfig} 中存在缺少 repoId 的条目`);
    }
    if (repoId.includes("/") || repoId.includes("\\")) {
      throw new Error(
        `${layout.reposConfig} 中的 repoId 不能包含路径分隔符：${repoId}。` +
          `repoId 必须是工作区下的目录名。`,
      );
    }
    out.set(repoId, {
      repoId,
      path: typeof raw.path === "string" ? raw.path : join(layout.workspaceRoot, repoId),
      registered: raw.registered === true,
    });
  }
  return out;
}

export function saveRegistry(layout: Layout, entries: Iterable<RepoEntry>): void {
  const body = stringify({ repos: [...entries] });
  const header = [
    "# GrandeGPT 仓库注册表（可信配置，人手编辑）",
    "#",
    "# repoId 即 GPT_Workspace 下的目录名。工作区里的 git 仓库会被自动发现为候选，",
    "# 但只有 registered: true 的才对 ChatGPT 可见——放个新项目进工作区不等于授权。",
    "#",
    "# path 仅供阅读；权威路径由 repoId 推导，程序不采信这里写的值。",
    "",
  ].join("\n");
  writeFileSync(layout.reposConfig, header + body, "utf8");
}

export function registeredIds(layout: Layout): Set<string> {
  const out = new Set<string>();
  for (const [id, e] of loadRegistry(layout)) if (e.registered) out.add(id);
  return out;
}
```

- [ ] **Step 8: 运行确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 9: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add src/paths.ts src/registry.ts tests/paths.test.ts tests/registry.test.ts
git commit -m "feat(s0): 路径安全与仓库注册表

repoId 是目录名而非路径，因此不做「拼接后再检查」，而是先否定一切含
分隔符、含 . / .. 、绝对路径形式的输入——路径穿越在拼接之前就不可能。

但名字合法不等于位置安全：GPT_Workspace/x 可以是指向工作区外的符号
链接。因此解析后仍要 realpath 并确认落在工作区内。同一道检查也用在
仓库内的相对路径上。

realpathAllowingMissing 处理「目标尚不存在」——创建新文件时目标本就
不存在，不能因此拒绝；做法是向上找到最近的存在祖先做 realpath 再拼回。

注册表区分「发现」与「授权」：工作区里的 git 仓库自动成为候选，但只有
registered: true 的才可访问。放个新项目进工作区不等于授权。

配置解析失败时响亮报错而不是静默当成空注册表——后者会让「配置写坏了」
表现为「所有仓库都消失了」，是最难排查的一类故障。"
```

---

## Task 3: SQLite 状态层与 task / job 读写

**Files:**
- Create: `src/db.ts`, `src/tasks.ts`, `src/jobs.ts`
- Test: `tests/db.test.ts`, `tests/tasks.test.ts`, `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `Layout` from `../src/layout.ts`
- Produces:
  - `function openDb(layout: Layout): DatabaseSync` —— 建 schema、设 pragma
  - `type TaskState = "CREATING" | "READY" | "RUNNING" | "CLOSED"`
  - `interface TaskRow { taskId: string; repoId: string; branch: string; baseCommit: string; worktreePath: string; state: TaskState; createdAt: number; updatedAt: number; stateVersion: number }`
  - `function createTask(db, t: Omit<TaskRow, "createdAt" | "updatedAt" | "stateVersion">): TaskRow`
  - `function getTask(db, taskId: string): TaskRow | undefined`
  - `function listActiveTasks(db): TaskRow[]`
  - `function updateTaskState(db, taskId: string, state: TaskState, expectedVersion: number): TaskRow`
  - `type JobState = "running" | "passed" | "failed" | "timeout" | "killed" | "cancelled"`
  - `interface JobRow { jobId: string; taskId: string; profile: string; argv: string[]; state: JobState; pgid: number | null; exitCode: number | null; startedAt: number; endedAt: number | null; artifactPath: string | null; summary: Record<string, unknown> | null }`
  - `function createJob(db, j: { jobId: string; taskId: string; profile: string; argv: string[]; pgid: number | null }): JobRow`
  - `function getJob(db, jobId: string): JobRow | undefined`
  - `function listJobs(db, taskId?: string): JobRow[]`
  - `function finishJob(db, jobId: string, r: { state: JobState; exitCode: number | null; artifactPath: string | null; summary: Record<string, unknown> | null }): JobRow`
  - `function reconcileRunningJobs(db, isAlive: (pgid: number) => boolean): number`

- [ ] **Step 1: 写 db 的失败测试**

`tests/db.test.ts`：

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";

let ws: string;
let ctrl: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("openDb()", () => {
  it("建出三张表", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toContain("task");
    expect(names).toContain("job");
    expect(names).toContain("audit");
    db.close();
  });

  it("开启 WAL 与外键约束", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    expect(String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase()).toBe("wal");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    db.close();
  });

  it("幂等：重复打开不会因为表已存在而报错", () => {
    const l = loadLayout();
    ensureLayout(l);
    openDb(l).close();
    expect(() => openDb(l).close()).not.toThrow();
  });

  it("job.taskId 的外键真的生效——插入孤儿 job 应被拒", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    expect(() =>
      db
        .prepare("INSERT INTO job (jobId,taskId,profile,argv,state,startedAt) VALUES (?,?,?,?,?,?)")
        .run("j1", "no-such-task", "unit", "[]", "running", Date.now()),
    ).toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/db.test.ts`
Expected: FAIL —— 无法解析 `../src/db.ts`

- [ ] **Step 3: 实现 db.ts**

`src/db.ts`：

```typescript
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Layout } from "./layout.ts";

/**
 * 打开状态库并保证 schema 就位。
 *
 * 用 Node 内置的 `node:sqlite` 而非 better-sqlite3：零依赖，与项目「能力面最小」
 * 的主线一致。代价是 Node 把它标为 experimental，API 可能随版本变化——因此
 * Node 版本锁定 24，且用 `--disable-warning=ExperimentalWarning` **精确**屏蔽
 * 那一条警告（不是全局关警告，其它警告仍应可见）。
 *
 * `stmt.get()` 返回 **null-prototype 对象**，断言时用 `toEqual` 而非 `toStrictEqual`。
 */
export function openDb(layout: Layout): DatabaseSync {
  mkdirSync(dirname(layout.stateDb), { recursive: true });
  const db = new DatabaseSync(layout.stateDb);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS task (
      taskId       TEXT PRIMARY KEY,
      repoId       TEXT NOT NULL,
      branch       TEXT NOT NULL,
      baseCommit   TEXT NOT NULL,
      worktreePath TEXT NOT NULL,
      state        TEXT NOT NULL,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL,
      stateVersion INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job (
      jobId        TEXT PRIMARY KEY,
      taskId       TEXT NOT NULL REFERENCES task(taskId),
      profile      TEXT NOT NULL,
      argv         TEXT NOT NULL,
      state        TEXT NOT NULL,
      pgid         INTEGER,
      exitCode     INTEGER,
      startedAt    INTEGER NOT NULL,
      endedAt      INTEGER,
      artifactPath TEXT,
      summary      TEXT
    );

    CREATE TABLE IF NOT EXISTS audit (
      opId         TEXT PRIMARY KEY,
      taskId       TEXT,
      tool         TEXT NOT NULL,
      inputDigest  TEXT NOT NULL,
      decision     TEXT NOT NULL,
      state        TEXT NOT NULL,
      pathsTouched TEXT NOT NULL,
      at           INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_taskId  ON job(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_task  ON audit(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_state ON audit(state);
  `);

  return db;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/db.test.ts && pnpm typecheck`
Expected: 4 个用例全部 PASS。

- [ ] **Step 5: 写 tasks / jobs 的失败测试**

`tests/tasks.test.ts`：

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask, getTask, listActiveTasks, updateTaskState } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let db: DatabaseSync;

const base = { repoId: "demo", branch: "grande/x-1", baseCommit: "abc123", worktreePath: "/w/1", state: "READY" as const };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  const l = loadLayout();
  ensureLayout(l);
  db = openDb(l);
});

afterEach(() => {
  db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("task 读写", () => {
  it("创建后可读回，stateVersion 从 1 起", () => {
    const t = createTask(db, { taskId: "task_1", ...base });
    expect(t.stateVersion).toBe(1);
    expect(getTask(db, "task_1")?.branch).toBe("grande/x-1");
  });

  it("未知 taskId 返回 undefined", () => {
    expect(getTask(db, "nope")).toBeUndefined();
  });

  it("重复 taskId 被主键约束拒绝", () => {
    createTask(db, { taskId: "task_1", ...base });
    expect(() => createTask(db, { taskId: "task_1", ...base })).toThrow();
  });

  it("状态变更递增 stateVersion", () => {
    createTask(db, { taskId: "task_1", ...base });
    expect(updateTaskState(db, "task_1", "RUNNING", 1).stateVersion).toBe(2);
  });

  it("版本不匹配时拒绝更新——防止旧客户端覆盖新状态", () => {
    createTask(db, { taskId: "task_1", ...base });
    updateTaskState(db, "task_1", "RUNNING", 1);
    expect(() => updateTaskState(db, "task_1", "CLOSED", 1)).toThrow(/STALE_STATE/);
    expect(getTask(db, "task_1")?.state).toBe("RUNNING");
  });

  it("listActiveTasks 排除 CLOSED", () => {
    createTask(db, { taskId: "task_1", ...base });
    createTask(db, { taskId: "task_2", ...base });
    updateTaskState(db, "task_2", "CLOSED", 1);
    expect(listActiveTasks(db).map((t) => t.taskId)).toEqual(["task_1"]);
  });
});
```

`tests/jobs.test.ts`：

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createJob, finishJob, getJob, listJobs, reconcileRunningJobs } from "../src/jobs.ts";
import { createTask } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let db: DatabaseSync;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  const l = loadLayout();
  ensureLayout(l);
  db = openDb(l);
  createTask(db, {
    taskId: "task_1", repoId: "demo", branch: "b", baseCommit: "c",
    worktreePath: "/w", state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("job 读写", () => {
  it("创建后状态为 running，argv 往返保持数组", () => {
    const j = createJob(db, { jobId: "job_1", taskId: "task_1", profile: "unit", argv: ["npm", "test"], pgid: 4242 });
    expect(j.state).toBe("running");
    expect(getJob(db, "job_1")?.argv).toEqual(["npm", "test"]);
  });

  it("finishJob 写入终态与 summary", () => {
    createJob(db, { jobId: "job_1", taskId: "task_1", profile: "unit", argv: [], pgid: 1 });
    const done = finishJob(db, "job_1", {
      state: "failed", exitCode: 1, artifactPath: "/a/1", summary: { failedTests: ["x"] },
    });
    expect(done.state).toBe("failed");
    expect(done.endedAt).not.toBeNull();
    expect(getJob(db, "job_1")?.summary).toEqual({ failedTests: ["x"] });
  });

  it("listJobs 可按 taskId 过滤，且按开始时间倒序", () => {
    createJob(db, { jobId: "job_1", taskId: "task_1", profile: "unit", argv: [], pgid: null });
    createJob(db, { jobId: "job_2", taskId: "task_1", profile: "lint", argv: [], pgid: null });
    expect(listJobs(db, "task_1").map((j) => j.jobId)).toEqual(["job_2", "job_1"]);
    expect(listJobs(db).length).toBe(2);
  });
});

describe("reconcileRunningJobs()", () => {
  it("进程组已消失的 running job 被标记为 killed", () => {
    createJob(db, { jobId: "job_dead", taskId: "task_1", profile: "unit", argv: [], pgid: 99999 });
    expect(reconcileRunningJobs(db, () => false)).toBe(1);
    expect(getJob(db, "job_dead")?.state).toBe("killed");
  });

  it("进程组仍存活的 running job 保持不动——重启后可重新接管监控", () => {
    createJob(db, { jobId: "job_alive", taskId: "task_1", profile: "unit", argv: [], pgid: 4242 });
    expect(reconcileRunningJobs(db, () => true)).toBe(0);
    expect(getJob(db, "job_alive")?.state).toBe("running");
  });

  it("没有 pgid 的 running job 无法探活，直接标记 killed 而不是永远挂着", () => {
    createJob(db, { jobId: "job_nopgid", taskId: "task_1", profile: "unit", argv: [], pgid: null });
    expect(reconcileRunningJobs(db, () => true)).toBe(1);
    expect(getJob(db, "job_nopgid")?.state).toBe("killed");
  });

  it("已到终态的 job 不受影响", () => {
    createJob(db, { jobId: "job_done", taskId: "task_1", profile: "unit", argv: [], pgid: 1 });
    finishJob(db, "job_done", { state: "passed", exitCode: 0, artifactPath: null, summary: null });
    reconcileRunningJobs(db, () => false);
    expect(getJob(db, "job_done")?.state).toBe("passed");
  });
});
```

- [ ] **Step 6: 运行确认失败**

Run: `pnpm test tests/tasks.test.ts tests/jobs.test.ts`
Expected: FAIL —— 无法解析 `../src/tasks.ts`

- [ ] **Step 7: 实现 tasks.ts 与 jobs.ts**

`src/tasks.ts`：

```typescript
import type { DatabaseSync } from "node:sqlite";

export type TaskState = "CREATING" | "READY" | "RUNNING" | "CLOSED";

export interface TaskRow {
  taskId: string;
  repoId: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  stateVersion: number;
}

function toRow(r: Record<string, unknown>): TaskRow {
  return {
    taskId: r.taskId as string,
    repoId: r.repoId as string,
    branch: r.branch as string,
    baseCommit: r.baseCommit as string,
    worktreePath: r.worktreePath as string,
    state: r.state as TaskState,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    stateVersion: r.stateVersion as number,
  };
}

export function createTask(
  db: DatabaseSync,
  t: Omit<TaskRow, "createdAt" | "updatedAt" | "stateVersion">,
): TaskRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO task (taskId,repoId,branch,baseCommit,worktreePath,state,createdAt,updatedAt,stateVersion)
     VALUES (?,?,?,?,?,?,?,?,1)`,
  ).run(t.taskId, t.repoId, t.branch, t.baseCommit, t.worktreePath, t.state, now, now);
  return { ...t, createdAt: now, updatedAt: now, stateVersion: 1 };
}

export function getTask(db: DatabaseSync, taskId: string): TaskRow | undefined {
  const r = db.prepare("SELECT * FROM task WHERE taskId = ?").get(taskId);
  return r ? toRow(r as Record<string, unknown>) : undefined;
}

export function listActiveTasks(db: DatabaseSync): TaskRow[] {
  return db
    .prepare("SELECT * FROM task WHERE state != 'CLOSED' ORDER BY createdAt DESC")
    .all()
    .map((r) => toRow(r as Record<string, unknown>));
}

/**
 * 乐观并发：只有携带当前 `stateVersion` 才能改状态。
 *
 * 规格 §7 的 `stateVersion` 是为了防止旧客户端覆盖新状态——ChatGPT 的对话可能
 * 分叉、重试、跨会话恢复，同一个 task 会被多个持有旧快照的调用方触及。
 */
export function updateTaskState(
  db: DatabaseSync,
  taskId: string,
  state: TaskState,
  expectedVersion: number,
): TaskRow {
  const now = Date.now();
  const res = db
    .prepare(
      `UPDATE task SET state = ?, updatedAt = ?, stateVersion = stateVersion + 1
       WHERE taskId = ? AND stateVersion = ?`,
    )
    .run(state, now, taskId, expectedVersion);

  if (res.changes === 0) {
    const cur = getTask(db, taskId);
    if (!cur) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    throw new Error(
      `STALE_STATE: 任务 ${taskId} 的 stateVersion 已是 ${cur.stateVersion}，` +
        `而本次更新携带的是 ${expectedVersion}。请重新读取状态后再试。`,
    );
  }
  const updated = getTask(db, taskId);
  if (!updated) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
  return updated;
}
```

`src/jobs.ts`：

```typescript
import type { DatabaseSync } from "node:sqlite";

export type JobState = "running" | "passed" | "failed" | "timeout" | "killed" | "cancelled";

export interface JobRow {
  jobId: string;
  taskId: string;
  profile: string;
  argv: string[];
  state: JobState;
  pgid: number | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  artifactPath: string | null;
  summary: Record<string, unknown> | null;
}

const TERMINAL: ReadonlySet<JobState> = new Set(["passed", "failed", "timeout", "killed", "cancelled"]);

function toRow(r: Record<string, unknown>): JobRow {
  return {
    jobId: r.jobId as string,
    taskId: r.taskId as string,
    profile: r.profile as string,
    argv: JSON.parse((r.argv as string) || "[]") as string[],
    state: r.state as JobState,
    pgid: (r.pgid as number | null) ?? null,
    exitCode: (r.exitCode as number | null) ?? null,
    startedAt: r.startedAt as number,
    endedAt: (r.endedAt as number | null) ?? null,
    artifactPath: (r.artifactPath as string | null) ?? null,
    summary: r.summary ? (JSON.parse(r.summary as string) as Record<string, unknown>) : null,
  };
}

export function createJob(
  db: DatabaseSync,
  j: { jobId: string; taskId: string; profile: string; argv: string[]; pgid: number | null },
): JobRow {
  const now = Date.now();
  db.prepare(
    "INSERT INTO job (jobId,taskId,profile,argv,state,pgid,startedAt) VALUES (?,?,?,?,'running',?,?)",
  ).run(j.jobId, j.taskId, j.profile, JSON.stringify(j.argv), j.pgid, now);
  return {
    ...j, state: "running", exitCode: null, startedAt: now,
    endedAt: null, artifactPath: null, summary: null,
  };
}

export function getJob(db: DatabaseSync, jobId: string): JobRow | undefined {
  const r = db.prepare("SELECT * FROM job WHERE jobId = ?").get(jobId);
  return r ? toRow(r as Record<string, unknown>) : undefined;
}

export function listJobs(db: DatabaseSync, taskId?: string): JobRow[] {
  const rows = taskId
    ? db.prepare("SELECT * FROM job WHERE taskId = ? ORDER BY startedAt DESC").all(taskId)
    : db.prepare("SELECT * FROM job ORDER BY startedAt DESC").all();
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

export function finishJob(
  db: DatabaseSync,
  jobId: string,
  r: {
    state: JobState;
    exitCode: number | null;
    artifactPath: string | null;
    summary: Record<string, unknown> | null;
  },
): JobRow {
  db.prepare(
    "UPDATE job SET state=?, exitCode=?, endedAt=?, artifactPath=?, summary=? WHERE jobId=?",
  ).run(
    r.state, r.exitCode, Date.now(), r.artifactPath,
    r.summary ? JSON.stringify(r.summary) : null, jobId,
  );
  const updated = getJob(db, jobId);
  if (!updated) throw new Error(`JOB_NOT_FOUND: ${jobId}`);
  return updated;
}

/**
 * 重启后对账：把「记录里还在 running、但进程组已经不在」的 job 收敛掉。
 *
 * 规格 AC-11 要求 Gateway 重启后不留下永远停在 running 的 job——那种记录会让
 * CLI 与将来的报告都误以为有任务在跑。没有 pgid 的 running job 无法探活，
 * 同样收敛（它多半是记录写了但进程没起来）。
 *
 * @param isAlive 由调用方注入的探活函数，便于测试；生产实现是 `process.kill(-pgid, 0)`
 * @returns 被收敛的条数
 */
export function reconcileRunningJobs(db: DatabaseSync, isAlive: (pgid: number) => boolean): number {
  let n = 0;
  for (const j of listJobs(db)) {
    if (TERMINAL.has(j.state)) continue;
    if (j.pgid !== null && isAlive(j.pgid)) continue;
    finishJob(db, j.jobId, {
      state: "killed", exitCode: null, artifactPath: j.artifactPath,
      summary: { reconciled: true, reason: j.pgid === null ? "无 pgid，无法探活" : "进程组已消失" },
    });
    n++;
  }
  return n;
}
```

- [ ] **Step 8: 运行确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 9: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add src/db.ts src/tasks.ts src/jobs.ts tests/db.test.ts tests/tasks.test.ts tests/jobs.test.ts
git commit -m "feat(s0): SQLite 状态层与 task/job 读写

用 Node 内置 node:sqlite 而非 better-sqlite3——零依赖，与「能力面最小」
的主线一致。代价是 Node 标它为 experimental，因此锁定 Node 24 并用
--disable-warning=ExperimentalWarning 精确屏蔽那一条警告。

task 的 stateVersion 做乐观并发：ChatGPT 的对话可能分叉、重试、跨会话
恢复，同一个 task 会被多个持有旧快照的调用方触及，不带版本的盲写会让
后到的旧请求覆盖新状态。

reconcileRunningJobs 对应验收标准 AC-11：重启后不能留下永远停在
running 的 job，否则 CLI 和报告都会误以为有任务在跑。探活函数由调用方
注入，测试才能覆盖「进程还在」与「进程没了」两条路径。"
```

---

## Task 4: 审计账本

**Files:**
- Create: `src/audit.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync`
- Produces:
  - `type AuditDecision = "ALLOWED" | "DENIED"`
  - `type AuditState = "INTENT" | "EXECUTING" | "SUCCEEDED" | "FAILED"`
  - `interface AuditRow { opId: string; taskId: string | null; tool: string; inputDigest: string; decision: AuditDecision; state: AuditState; pathsTouched: string[]; at: number; updatedAt: number }`
  - `interface AuditHandle { opId: string; allowed(): void; denied(reason: string): void; executing(): void; succeeded(pathsTouched?: string[]): void; failed(reason: string, pathsTouched?: string[]): void }`
  - `function beginAudit(db, a: { taskId: string | null; tool: string; input: unknown }): AuditHandle`
  - `function getAudit(db, opId: string): AuditRow | undefined`
  - `function listAudit(db, taskId?: string, limit?: number): AuditRow[]`
  - `function listUnfinishedAudit(db): AuditRow[]`

**设计要点**：`beginAudit` 在返回前就把 `INTENT` 落库。调用方拿到的是一个句柄，
只能推进状态、不能回头改已写的意图 —— **想执行就必然先留下痕迹**。

- [ ] **Step 1: 写失败测试**

`tests/audit.test.ts`：

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginAudit, getAudit, listAudit, listUnfinishedAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";

let ws: string;
let ctrl: string;
let db: DatabaseSync;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  const l = loadLayout();
  ensureLayout(l);
  db = openDb(l);
});

afterEach(() => {
  db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("beginAudit()", () => {
  it("返回前就已落库为 INTENT——想执行就必然先留下痕迹", () => {
    const h = beginAudit(db, { taskId: "task_1", tool: "grande_repo_edit", input: { path: "a.ts" } });
    expect(getAudit(db, h.opId)?.state).toBe("INTENT");
  });

  it("opId 唯一", () => {
    const a = beginAudit(db, { taskId: null, tool: "t", input: {} });
    const b = beginAudit(db, { taskId: null, tool: "t", input: {} });
    expect(a.opId).not.toBe(b.opId);
  });

  it("记录输入摘要而非输入本身——输入可能含大体积内容或敏感值", () => {
    const h = beginAudit(db, { taskId: null, tool: "t", input: { secret: "hunter2" } });
    const row = getAudit(db, h.opId);
    expect(row?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  it("相同输入产生相同摘要，不同输入产生不同摘要", () => {
    const a = beginAudit(db, { taskId: null, tool: "t", input: { x: 1 } });
    const b = beginAudit(db, { taskId: null, tool: "t", input: { x: 1 } });
    const c = beginAudit(db, { taskId: null, tool: "t", input: { x: 2 } });
    expect(getAudit(db, a.opId)?.inputDigest).toBe(getAudit(db, b.opId)?.inputDigest);
    expect(getAudit(db, a.opId)?.inputDigest).not.toBe(getAudit(db, c.opId)?.inputDigest);
  });
});

describe("状态推进", () => {
  it("完整成功路径：INTENT → ALLOWED → EXECUTING → SUCCEEDED", () => {
    const h = beginAudit(db, { taskId: "task_1", tool: "grande_run", input: {} });
    h.allowed();
    h.executing();
    h.succeeded(["/w/a.ts"]);
    const row = getAudit(db, h.opId);
    expect(row?.decision).toBe("ALLOWED");
    expect(row?.state).toBe("SUCCEEDED");
    expect(row?.pathsTouched).toEqual(["/w/a.ts"]);
  });

  it("被 Policy 拒绝时记 DENIED 且停在 FAILED，不进入 EXECUTING", () => {
    const h = beginAudit(db, { taskId: null, tool: "grande_repo_edit", input: {} });
    h.denied("路径不在允许写入范围内");
    const row = getAudit(db, h.opId);
    expect(row?.decision).toBe("DENIED");
    expect(row?.state).toBe("FAILED");
  });

  it("失败路径记录原因", () => {
    const h = beginAudit(db, { taskId: null, tool: "t", input: {} });
    h.allowed();
    h.executing();
    h.failed("STALE_FILE");
    expect(getAudit(db, h.opId)?.state).toBe("FAILED");
  });

  it("updatedAt 随状态推进而变化，at 保持首次写入时刻", async () => {
    const h = beginAudit(db, { taskId: null, tool: "t", input: {} });
    const first = getAudit(db, h.opId)!;
    await new Promise((r) => setTimeout(r, 5));
    h.allowed();
    const second = getAudit(db, h.opId)!;
    expect(second.at).toBe(first.at);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });
});

describe("查询", () => {
  it("listAudit 可按 taskId 过滤，按时间倒序", () => {
    beginAudit(db, { taskId: "task_1", tool: "a", input: {} });
    beginAudit(db, { taskId: "task_2", tool: "b", input: {} });
    beginAudit(db, { taskId: "task_1", tool: "c", input: {} });
    expect(listAudit(db, "task_1").map((r) => r.tool)).toEqual(["c", "a"]);
    expect(listAudit(db).length).toBe(3);
  });

  it("listUnfinishedAudit 找出停在 INTENT/EXECUTING 的记录——它们是崩溃的痕迹", () => {
    const done = beginAudit(db, { taskId: null, tool: "done", input: {} });
    done.allowed(); done.executing(); done.succeeded();
    beginAudit(db, { taskId: null, tool: "stuck-intent", input: {} });
    const midway = beginAudit(db, { taskId: null, tool: "stuck-exec", input: {} });
    midway.allowed(); midway.executing();

    expect(listUnfinishedAudit(db).map((r) => r.tool).sort()).toEqual(["stuck-exec", "stuck-intent"]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/audit.test.ts`
Expected: FAIL —— 无法解析 `../src/audit.ts`

- [ ] **Step 3: 实现 audit.ts**

`src/audit.ts`：

```typescript
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AuditDecision = "ALLOWED" | "DENIED";
export type AuditState = "INTENT" | "EXECUTING" | "SUCCEEDED" | "FAILED";

export interface AuditRow {
  opId: string;
  taskId: string | null;
  tool: string;
  inputDigest: string;
  decision: AuditDecision;
  state: AuditState;
  pathsTouched: string[];
  /** 首次写入 INTENT 的时刻，不再变化 */
  at: number;
  updatedAt: number;
}

export interface AuditHandle {
  opId: string;
  allowed(): void;
  denied(reason: string): void;
  executing(): void;
  succeeded(pathsTouched?: string[]): void;
  failed(reason: string, pathsTouched?: string[]): void;
}

function toRow(r: Record<string, unknown>): AuditRow {
  return {
    opId: r.opId as string,
    taskId: (r.taskId as string | null) ?? null,
    tool: r.tool as string,
    inputDigest: r.inputDigest as string,
    decision: r.decision as AuditDecision,
    state: r.state as AuditState,
    pathsTouched: JSON.parse((r.pathsTouched as string) || "[]") as string[],
    at: r.at as number,
    updatedAt: r.updatedAt as number,
  };
}

/** 稳定摘要：键序不影响结果，相同输入必得相同摘要 */
function digest(input: unknown): string {
  const stable = JSON.stringify(input, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  return createHash("sha256").update(stable ?? "null", "utf8").digest("hex");
}

/**
 * 开一条审计记录。**返回之前 `INTENT` 已经落库** —— 调用方想执行就必然先留下痕迹，
 * 这是规格 §8.1「先写 INTENT 再执行」的落点。
 *
 * 只记录输入的 **sha256 摘要**而非输入本身：工具入参可能含几十 KB 的文件内容，
 * 也可能含不该进审计库的值。摘要足以证明「同一个请求」而不承载内容。
 *
 * 业务执行与审计不是单一事务，因此崩溃会留下停在 INTENT/EXECUTING 的记录 ——
 * 那不是缺陷，正是设计意图：`listUnfinishedAudit` 能把它们找出来。
 */
export function beginAudit(
  db: DatabaseSync,
  a: { taskId: string | null; tool: string; input: unknown },
): AuditHandle {
  const opId = `op_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO audit (opId,taskId,tool,inputDigest,decision,state,pathsTouched,at,updatedAt)
     VALUES (?,?,?,?,'ALLOWED','INTENT','[]',?,?)`,
  ).run(opId, a.taskId, a.tool, digest(a.input), now, now);

  const setState = (state: AuditState, decision?: AuditDecision, paths?: string[]): void => {
    if (decision !== undefined && paths !== undefined) {
      db.prepare("UPDATE audit SET state=?, decision=?, pathsTouched=?, updatedAt=? WHERE opId=?")
        .run(state, decision, JSON.stringify(paths), Date.now(), opId);
    } else if (decision !== undefined) {
      db.prepare("UPDATE audit SET state=?, decision=?, updatedAt=? WHERE opId=?")
        .run(state, decision, Date.now(), opId);
    } else if (paths !== undefined) {
      db.prepare("UPDATE audit SET state=?, pathsTouched=?, updatedAt=? WHERE opId=?")
        .run(state, JSON.stringify(paths), Date.now(), opId);
    } else {
      db.prepare("UPDATE audit SET state=?, updatedAt=? WHERE opId=?").run(state, Date.now(), opId);
    }
  };

  return {
    opId,
    allowed: () => setState("INTENT", "ALLOWED"),
    // 被 Policy 拒绝的操作从不进入 EXECUTING：它没有执行过，直接终结为 FAILED
    denied: () => setState("FAILED", "DENIED"),
    executing: () => setState("EXECUTING"),
    succeeded: (paths = []) => setState("SUCCEEDED", undefined, paths),
    failed: (_reason, paths = []) => setState("FAILED", undefined, paths),
  };
}

export function getAudit(db: DatabaseSync, opId: string): AuditRow | undefined {
  const r = db.prepare("SELECT * FROM audit WHERE opId = ?").get(opId);
  return r ? toRow(r as Record<string, unknown>) : undefined;
}

export function listAudit(db: DatabaseSync, taskId?: string, limit = 100): AuditRow[] {
  const rows = taskId
    ? db.prepare("SELECT * FROM audit WHERE taskId = ? ORDER BY at DESC LIMIT ?").all(taskId, limit)
    : db.prepare("SELECT * FROM audit ORDER BY at DESC LIMIT ?").all(limit);
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

/** 停在 INTENT / EXECUTING 的记录：崩溃或中断的痕迹，S4 的恢复器会消费它们 */
export function listUnfinishedAudit(db: DatabaseSync): AuditRow[] {
  return db
    .prepare("SELECT * FROM audit WHERE state IN ('INTENT','EXECUTING') ORDER BY at DESC")
    .all()
    .map((r) => toRow(r as Record<string, unknown>));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add src/audit.ts tests/audit.test.ts
git commit -m "feat(s0): 审计账本，INTENT 先行

beginAudit 在返回之前就把 INTENT 落库，调用方拿到的是一个只能向前推进
状态的句柄——想执行就必然先留下痕迹。这是规格 §8.1「先写 INTENT 再
执行」的落点。

只记录输入的 sha256 摘要而非输入本身：工具入参可能含几十 KB 文件内容，
也可能含不该进审计库的值。摘要足以证明「是同一个请求」而不承载内容。
摘要对键序稳定，否则同一请求会因序列化顺序不同而产生不同摘要。

业务执行与审计不是单一事务，崩溃会留下停在 INTENT/EXECUTING 的记录。
那不是缺陷而是设计意图：listUnfinishedAudit 把它们找出来，S4 的恢复器
消费。被 Policy 拒绝的操作从不进入 EXECUTING——它没有执行过。"
```

---

## Task 5: 只读 CLI

**Files:**
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: 前四个任务的全部导出
- Produces:
  - `function runCli(argv: string[], out: (line: string) => void): number` —— 返回退出码，便于测试
  - `src/cli.ts` 作为进程入口时调用它并 `process.exit`

**规格约束（§8.2）**：CLI **只读**，不提供任何变更能力；与 Gateway 共享同一份读取逻辑。

- [ ] **Step 1: 写失败测试**

`tests/cli.test.ts`：

```typescript
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { beginAudit } from "../src/audit.ts";
import { createTask } from "../src/tasks.ts";
import { saveRegistry } from "../src/registry.ts";
import { runCli } from "../src/cli.ts";

let ws: string;
let ctrl: string;
let lines: string[];
const out = (l: string): void => void lines.push(l);
const text = (): string => lines.join("\n");

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  lines = [];
  const l = loadLayout();
  ensureLayout(l);
  mkdirSync(join(ws, "demo", ".git"), { recursive: true });
  saveRegistry(l, [{ repoId: "demo", path: join(ws, "demo"), registered: true }]);
  const db = openDb(l);
  createTask(db, {
    taskId: "task_abc", repoId: "demo", branch: "grande/fix-abc",
    baseCommit: "c0ffee", worktreePath: join(ws, ".grande-work", "worktrees", "demo", "task_abc"),
    state: "READY",
  });
  createJob(db, { jobId: "job_1", taskId: "task_abc", profile: "unit", argv: ["npm", "test"], pgid: 111 });
  finishJob(db, "job_1", { state: "failed", exitCode: 1, artifactPath: null, summary: { failedTests: ["x"] } });
  const h = beginAudit(db, { taskId: "task_abc", tool: "grande_repo_edit", input: { path: "a.ts" } });
  h.allowed(); h.executing(); h.succeeded(["a.ts"]);
  db.close();
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("grande status", () => {
  it("列出活跃 task 的分支与最近 job", () => {
    expect(runCli(["status"], out)).toBe(0);
    expect(text()).toContain("task_abc");
    expect(text()).toContain("grande/fix-abc");
    expect(text()).toContain("failed");
  });

  it("没有活跃任务时给出明确提示，而不是空白输出", () => {
    rmSync(join(ctrl, "state"), { recursive: true, force: true });
    lines = [];
    expect(runCli(["status"], out)).toBe(0);
    expect(text()).toMatch(/没有活跃任务|no active/i);
  });
});

describe("grande jobs", () => {
  it("列出 job 的 profile、状态与退出码", () => {
    expect(runCli(["jobs"], out)).toBe(0);
    expect(text()).toContain("job_1");
    expect(text()).toContain("unit");
  });

  it("--task 过滤", () => {
    expect(runCli(["jobs", "--task", "task_abc"], out)).toBe(0);
    expect(text()).toContain("job_1");
  });

  it("--task 指向不存在的任务时给出提示且退出码非零", () => {
    expect(runCli(["jobs", "--task", "nope"], out)).not.toBe(0);
  });
});

describe("grande audit", () => {
  it("列出审计流水：opId、工具、决策、状态", () => {
    expect(runCli(["audit"], out)).toBe(0);
    expect(text()).toContain("grande_repo_edit");
    expect(text()).toContain("ALLOWED");
    expect(text()).toContain("SUCCEEDED");
  });
});

describe("grande doctor", () => {
  it("检查 sandbox-exec、工作区、控制平面与注册表，逐项给出结论", () => {
    expect(runCli(["doctor"], out)).toBe(0);
    const t = text();
    expect(t).toContain("sandbox-exec");
    expect(t).toContain("GRANDE_WORKSPACE");
    expect(t).toContain("demo");
  });

  it("注册了但目录不存在时报出问题并以非零码退出", () => {
    rmSync(join(ws, "demo"), { recursive: true, force: true });
    lines = [];
    expect(runCli(["doctor"], out)).not.toBe(0);
    expect(text()).toMatch(/demo/);
  });
});

describe("命令行本身", () => {
  it("未知命令给出用法且退出码非零", () => {
    expect(runCli(["nonsense"], out)).not.toBe(0);
    expect(text()).toContain("status");
  });

  it("无参数时打印用法", () => {
    expect(runCli([], out)).not.toBe(0);
    expect(text()).toContain("doctor");
  });

  it("CLI 不提供任何变更能力——用法里没有任何写操作命令", () => {
    runCli([], out);
    for (const verb of ["create", "delete", "remove", "run", "edit", "register"]) {
      expect(text().toLowerCase()).not.toContain(`grande ${verb}`);
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/cli.test.ts`
Expected: FAIL —— 无法解析 `../src/cli.ts`

- [ ] **Step 3: 实现 cli.ts**

`src/cli.ts`：

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listAudit, listUnfinishedAudit } from "./audit.ts";
import { openDb } from "./db.ts";
import { listJobs } from "./jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "./layout.ts";
import { getTask, listActiveTasks } from "./tasks.ts";
import { discoverRepos, loadRegistry } from "./registry.ts";

const USAGE = `grande —— GrandeGPT 控制平面的只读查看器

  grande status                 活跃任务：分支、worktree、状态、最近 job
  grande jobs [--task <id>]     job 列表：profile、状态、耗时、退出码
  grande audit [--task <id>]    审计流水：opId、工具、决策、触及路径
  grande doctor                 环境自检

本工具只读，不提供任何变更能力（规格 §8.2）。`;

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function withDb<T>(fn: (db: ReturnType<typeof openDb>, layout: Layout) => T): T {
  const layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);
  try {
    return fn(db, layout);
  } finally {
    db.close();
  }
}

function cmdStatus(out: (l: string) => void): number {
  return withDb((db) => {
    const tasks = listActiveTasks(db);
    if (tasks.length === 0) {
      out("没有活跃任务。");
      return 0;
    }
    for (const t of tasks) {
      const last = listJobs(db, t.taskId)[0];
      out(`${t.taskId}  [${t.state}]  repo=${t.repoId}`);
      out(`  分支      ${t.branch}`);
      out(`  worktree  ${t.worktreePath}`);
      out(`  最近 job  ${last ? `${last.jobId} ${last.profile} → ${last.state}` : "（无）"}`);
      out("");
    }
    return 0;
  });
}

function cmdJobs(out: (l: string) => void, taskId?: string): number {
  return withDb((db) => {
    if (taskId !== undefined && !getTask(db, taskId)) {
      out(`任务不存在：${taskId}`);
      const active = listActiveTasks(db);
      if (active.length > 0) out(`活跃任务：${active.map((t) => t.taskId).join(", ")}`);
      return 1;
    }
    const jobs = listJobs(db, taskId);
    if (jobs.length === 0) {
      out("没有 job 记录。");
      return 0;
    }
    for (const j of jobs) {
      const dur = j.endedAt === null ? "运行中" : `${((j.endedAt - j.startedAt) / 1000).toFixed(1)}s`;
      out(`${j.jobId}  ${j.profile.padEnd(10)} ${j.state.padEnd(9)} exit=${j.exitCode ?? "-"}  ${dur}  ${fmtTime(j.startedAt)}`);
    }
    return 0;
  });
}

function cmdAudit(out: (l: string) => void, taskId?: string): number {
  return withDb((db) => {
    const rows = listAudit(db, taskId);
    if (rows.length === 0) {
      out("没有审计记录。");
      return 0;
    }
    for (const r of rows) {
      out(`${fmtTime(r.at)}  ${r.tool.padEnd(20)} ${r.decision.padEnd(8)} ${r.state.padEnd(10)} ${r.opId}`);
      if (r.pathsTouched.length > 0) out(`    触及：${r.pathsTouched.join(", ")}`);
    }
    const stuck = listUnfinishedAudit(db);
    if (stuck.length > 0) {
      out("");
      out(`⚠️  ${stuck.length} 条记录停在 INTENT/EXECUTING —— 崩溃或中断的痕迹：`);
      for (const r of stuck) out(`    ${r.opId}  ${r.tool}  ${r.state}`);
    }
    return 0;
  });
}

function cmdDoctor(out: (l: string) => void): number {
  let bad = 0;
  const ok = (label: string, detail: string): void => out(`  ✓ ${label} — ${detail}`);
  const fail = (label: string, detail: string): void => {
    out(`  ✗ ${label} — ${detail}`);
    bad++;
  };

  out("环境自检：");
  if (existsSync("/usr/bin/sandbox-exec")) ok("sandbox-exec", "/usr/bin/sandbox-exec 存在");
  else fail("sandbox-exec", "缺失 —— Seatbelt 沙箱不可用，run_profile 无法工作");

  let layout: Layout;
  try {
    layout = loadLayout();
  } catch (e) {
    fail("GRANDE_WORKSPACE", e instanceof Error ? e.message : String(e));
    return 1;
  }
  ok("GRANDE_WORKSPACE", layout.workspaceRoot);
  ok("控制平面", layout.controlRoot);

  ensureLayout(layout);
  const registry = loadRegistry(layout);
  const registered = [...registry.values()].filter((r) => r.registered);
  if (registered.length === 0) {
    const candidates = discoverRepos(layout);
    fail(
      "已注册仓库",
      candidates.length > 0
        ? `无。工作区下发现候选：${candidates.join(", ")} —— 需在 ${layout.reposConfig} 中标记 registered: true`
        : `无，且工作区下没有发现任何 git 仓库`,
    );
  } else {
    for (const r of registered) {
      const dir = join(layout.workspaceRoot, r.repoId);
      if (!existsSync(dir)) fail(`仓库 ${r.repoId}`, `已注册但目录不存在：${dir}`);
      else if (!existsSync(join(dir, ".git"))) fail(`仓库 ${r.repoId}`, `目录存在但不是 git 仓库：${dir}`);
      else ok(`仓库 ${r.repoId}`, dir);
    }
  }

  const stuck = withDb((db) => listUnfinishedAudit(db).length);
  if (stuck > 0) fail("审计完整性", `${stuck} 条记录停在 INTENT/EXECUTING，可能是上次崩溃留下的`);
  else ok("审计完整性", "无未完成记录");

  return bad === 0 ? 0 : 1;
}

/** @returns 进程退出码 */
export function runCli(argv: string[], out: (line: string) => void): number {
  const [cmd, ...rest] = argv;
  const taskIdx = rest.indexOf("--task");
  const taskId = taskIdx >= 0 ? rest[taskIdx + 1] : undefined;

  switch (cmd) {
    case "status":
      return cmdStatus(out);
    case "jobs":
      return cmdJobs(out, taskId);
    case "audit":
      return cmdAudit(out, taskId);
    case "doctor":
      return cmdDoctor(out);
    default:
      if (cmd !== undefined) out(`未知命令：${cmd}`);
      out(USAGE);
      return 1;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.exit(runCli(process.argv.slice(2), (l) => console.log(l)));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS。

`grande logs` 在 §8.2 中列出，但它读的是 artifact 文件，而 artifact 由 S0-C 的 runner 产生 ——
**本任务不实现它**，留给 S0-C 与 runner 一起做。不要为它写空壳。

- [ ] **Step 5: 手工冒烟**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
GRANDE_WORKSPACE=/Users/xtation/AgentWorks/GPT_Workspace pnpm cli doctor
```

Expected: 逐项输出自检结果。首次运行时「已注册仓库」应报 ✗ 并提示
`grande-gpt` 是候选、需在 `~/.grande-control/config/repos.yaml` 中标记
`registered: true` —— 这正是「发现 ≠ 授权」的体现。

- [ ] **Step 6: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add src/cli.ts tests/cli.test.ts
git commit -m "feat(s0): 只读 CLI

规格 §8.2 要求 CLI 只读、不提供任何变更能力，并与 Gateway 共享同一份
读取逻辑——因此这里没有自己的查询实现，全部复用 tasks/jobs/audit 模块。
有一条测试专门断言用法里不出现任何写操作命令。

doctor 值得单列：S0 的失败大多来自环境（sandbox-exec 缺失、仓库注册了
但目录不在、上次崩溃留下未完成的审计记录），一条命令给出可执行诊断，
比让人去猜快得多。它把「发现 ≠ 授权」也暴露出来：工作区下的候选仓库
若未注册，doctor 会直接告诉你要去改哪个文件。

runCli 返回退出码而不是直接 process.exit，输出经注入的 out 回调——
两者都是为了可测。

grande logs 在 §8.2 中列出但本任务不实现：它读的是 artifact 文件，
而 artifact 由 S0-C 的 runner 产生。不写空壳。"
```

---

## S0-A 完成后的状态

**产出**：一个可运行的 `grande doctor`、一个建好 schema 的状态库、一套经测试的路径安全与
审计原语。**没有** MCP、没有 git、没有 worktree、没有沙箱。

**S0-B 和 S0-C 可以并行开始**，两者都只依赖本计划的导出：

| 下游 | 依赖本计划的 |
|---|---|
| S0-B 仓库读写 | `resolveRepoPath` / `resolveInRepo` / `registeredIds` / `envelope` / `beginAudit` |
| S0-C worktree + runner | `Layout.worktreesRoot` / `createJob` / `finishJob` / `reconcileRunningJobs` / `Layout.artifactsDir` |
| S0-D MCP 接入 | 以上全部，外加 `spike/oauth/server.ts` 已验证的认证层 |
