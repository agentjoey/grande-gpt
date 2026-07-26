# GrandeGPT POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个返回硬编码假数据的 MCP 服务端，在真实 ChatGPT 对话中验证 P-1～P-5 五项交互假设，从而决定是否启动 S0。

**Architecture:** 单进程 TypeScript 服务：Hono 处理 HTTP → `WebStandardStreamableHTTPServerTransport`（无状态模式）→ `McpServer` 注册九个工具 → 工具读写内存中的假仓库与假 job 状态机 → 每次调用把请求参数**与响应摘要**写一条 JSONL 观测日志。cloudflared 专用隧道 `grande-poc` 把 `gg.agentjoey.ai` 指向本地端口。全部产出是一份观察记录，代码一次性、不进入 S0 代码库。

> **执行期修订（2026-07-26）**：本计划原稿写的是 `m2m.agentjoey.ai`，但该域名实际映射到
> `ssh://localhost:22`（Human Owner 的 SSH 接入），复用会切断 SSH。经授权改为新建专用隧道
> `grande-poc` + 新域名 `gg.agentjoey.ai`，完全不触碰 home-mac 隧道上的现有服务。
>
> 原稿还有两处已在执行中修正，记此备查：① 观测日志原本只记调用参数不记响应，导致
> P-1/P-3/P-5 都缺关键信号（详见 §「执行期发现的计划缺陷」）；② 信封声明了 `nextCursor`
> 却没有任何工具接受 `cursor` 入参，"续读"从一开始就是摆设。

**Tech Stack:** Node 24 · TypeScript 5 · pnpm · `@modelcontextprotocol/sdk@1.29.0` · Hono 4 + `@hono/node-server` · vitest 4 · cloudflared

## Global Constraints

以下取自规格 `docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`，**每个任务的要求都隐含包含本节**。

- **POC 代码是一次性的，不进入 S0 代码库。** 全部放在 `poc/`，产出是观察记录 + 对规格的修订。
- **不实现任何真实逻辑**：无 Gateway、无 Seatbelt、无 worktree、无 git、无 SQLite。**假仓库与 job 的全部业务状态只存在于内存中**，进程退出即消失。
  - 唯一允许的磁盘写入是**观测日志** `observe.jsonl`（Task 5 的 `observe.ts`）—— 它是本 POC 的交付物本身，属于仪表而非业务逻辑。除此之外不得有任何文件写入。
- **九个工具名固定**：`grande_task_open`、`grande_task_status`、`grande_repo_map`、`grande_repo_search`、`grande_repo_read`、`grande_repo_edit`、`grande_diff`、`grande_run`、`grande_run_result`。
- **`repoId` 由 URL 端点决定，绝不作为工具参数**（规格 D5）。
- **注解必须如实标注**：六个只读工具 `readOnlyHint: true`；`grande_task_open` / `grande_repo_edit` / `grande_run` 为 `readOnlyHint: false, destructiveHint: false`；**所有工具 `openWorldHint: false`**。
- **除 `grande_run` 外，所有工具必须同步秒回**（规格 §5.4，ChatGPT 侧约 60s 超时）。
- **响应信封字段固定**：`ok` / `taskId` / `data` / `truncated` / `nextCursor` / `hint` / `taskContext`；失败为 `ok:false` + `error{code,message,retryable,details}`。
- **合规红线**：POC 全程由真人在 ChatGPT 对话中手动操作。**禁止任何脚本化或无人值守驱动 ChatGPT**（规格 §2.3）。
- **传输采用无状态模式**（`sessionIdGenerator: undefined`）。社区报告 ChatGPT 每次工具调用新建 MCP session，无状态模式天然免疫该问题。
- **POC 不实现 OAuth**（见「残留风险」），改用不可猜测的路径前缀作为访问控制。

## 残留风险（本 POC 刻意不覆盖）

**POC 不验证 OAuth 2.1 + PKCE 能否与 ChatGPT 正常握手。** 理由：POC 的目的是 P-1～P-5 的交互可行性，而认证是有完整官方文档的已知可解工程问题。ChatGPT developer mode 支持 "No Authentication"，POC 用它换取 1–2 天的工期。

**代价**：S0 第一周必须单独验证 OAuth 握手，且该项失败会阻塞 S0。这一条须写入 POC 观察记录的「未覆盖项」。

---

## File Structure

```
poc/
├── package.json                 # 依赖与脚本
├── tsconfig.json
├── vitest.config.ts
├── PROTOCOL.md                  # 真人在 ChatGPT 中执行的测试脚本（Task 7 产出）
├── src/
│   ├── envelope.ts              # 响应信封 + 截断工具
│   ├── fixtures.ts              # 假仓库数据 + 场景状态
│   ├── jobs.ts                  # 假 job 状态机
│   ├── tools.ts                 # 九个工具注册
│   ├── observe.ts               # JSONL 观测日志
│   └── server.ts                # HTTP + MCP 传输接线，进程入口
├── scripts/
│   └── report.ts                # 读 JSONL → P-1～P-5 观测报告
└── tests/
    ├── envelope.test.ts
    ├── fixtures.test.ts
    ├── jobs.test.ts
    ├── tools.test.ts
    ├── server.test.ts
    └── report.test.ts
```

**职责边界**：`fixtures.ts` 只管「假仓库现在是什么样」，`jobs.ts` 只管「一个 job 从开始到结束的状态迁移」，`tools.ts` 只做参数校验 + 调用前两者 + 套信封。`observe.ts` 被 `server.ts` 调用，不被工具直接调用——保证日志记录与业务逻辑解耦。

---

## Task 1: 脚手架与响应信封

**Files:**
- Create: `poc/package.json`
- Create: `poc/tsconfig.json`
- Create: `poc/vitest.config.ts`
- Create: `poc/src/envelope.ts`
- Test: `poc/tests/envelope.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `interface TaskContext { branch: string; filesChanged: number; lastJob: string | null }`
  - `interface Envelope<T> { ok: true; taskId: string | null; data: T; truncated: boolean; nextCursor: string | null; hint: string; taskContext: TaskContext | null }`
  - `interface ErrorEnvelope { ok: false; taskId: string | null; error: { code: string; message: string; retryable: boolean; details: Record<string, unknown> } }`
  - `function ok<T>(args: { taskId?: string | null; data: T; hint: string; truncated?: boolean; nextCursor?: string | null; taskContext?: TaskContext | null }): Envelope<T>`
  - `function err(args: { taskId?: string | null; code: string; message: string; retryable?: boolean; details?: Record<string, unknown> }): ErrorEnvelope`
  - `function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean }`
  - `function truncateList<T>(items: T[], max: number): { items: T[]; truncated: boolean; nextCursor: string | null }`

- [ ] **Step 1: 创建 pnpm 项目与配置**

```bash
mkdir -p poc/src poc/tests poc/scripts
cd poc
```

`poc/package.json`：

```json
{
  "name": "grande-gpt-poc",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "report": "node scripts/report.ts"
  },
  "dependencies": {
    "@hono/node-server": "1.19.7",
    "@modelcontextprotocol/sdk": "1.29.0",
    "hono": "4.12.32",
    "zod": "3.25.76"
  },
  "devDependencies": {
    "@types/node": "24.10.1",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
}
```

`poc/tsconfig.json`：

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
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]
}
```

`poc/vitest.config.ts`：

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

`poc/.gitignore` —— **现在就建，避免 `observe.jsonl` 与 secret 被误提交**：

```
node_modules/
observe.jsonl
.env
```

- [ ] **Step 2: 安装依赖并确认版本**

Run: `cd poc && pnpm install`
Expected: 安装成功。随后运行 `pnpm ls @modelcontextprotocol/sdk`，输出应包含 `1.29.0`。

若 zod 版本冲突（SDK 对 zod 有 peer 约束），以 SDK 要求为准并在此处记录实际版本。

- [ ] **Step 3: 写失败的测试**

`poc/tests/envelope.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { err, ok, truncateList, truncateText } from "../src/envelope.ts";

describe("ok()", () => {
  it("填充全部信封字段并对可选项取默认值", () => {
    const e = ok({ taskId: "task_a1", data: { n: 1 }, hint: "下一步" });
    expect(e).toEqual({
      ok: true,
      taskId: "task_a1",
      data: { n: 1 },
      truncated: false,
      nextCursor: null,
      hint: "下一步",
      taskContext: null,
    });
  });

  it("taskId 缺省时为 null", () => {
    expect(ok({ data: 1, hint: "h" }).taskId).toBeNull();
  });
});

describe("err()", () => {
  it("构造错误信封，retryable 默认 false", () => {
    const e = err({ taskId: "task_a1", code: "STALE_FILE", message: "changed" });
    expect(e).toEqual({
      ok: false,
      taskId: "task_a1",
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

  it("按字节而非字符截断，不产生半个多字节字符", () => {
    const r = truncateText("中文中文", 5);
    expect(r.truncated).toBe(true);
    expect(() => JSON.parse(JSON.stringify(r.text))).not.toThrow();
    expect(r.text).toBe("中");
  });
});

describe("truncateList()", () => {
  it("未超限时 nextCursor 为 null", () => {
    expect(truncateList([1, 2], 5)).toEqual({ items: [1, 2], truncated: false, nextCursor: null });
  });

  it("超限时截断并给出下一页游标", () => {
    const r = truncateList([1, 2, 3, 4, 5], 2);
    expect(r.items).toEqual([1, 2]);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBe("2");
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `cd poc && pnpm test`
Expected: FAIL —— `Failed to resolve import "../src/envelope.ts"`

- [ ] **Step 5: 实现 envelope.ts**

`poc/src/envelope.ts`：

```typescript
export interface TaskContext {
  branch: string;
  filesChanged: number;
  lastJob: string | null;
}

export interface Envelope<T> {
  ok: true;
  taskId: string | null;
  data: T;
  truncated: boolean;
  nextCursor: string | null;
  hint: string;
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

export function ok<T>(args: {
  taskId?: string | null;
  data: T;
  hint: string;
  truncated?: boolean;
  nextCursor?: string | null;
  taskContext?: TaskContext | null;
}): Envelope<T> {
  return {
    ok: true,
    taskId: args.taskId ?? null,
    data: args.data,
    truncated: args.truncated ?? false,
    nextCursor: args.nextCursor ?? null,
    hint: args.hint,
    taskContext: args.taskContext ?? null,
  };
}

export function err(args: {
  taskId?: string | null;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}): ErrorEnvelope {
  return {
    ok: false,
    taskId: args.taskId ?? null,
    error: {
      code: args.code,
      message: args.message,
      retryable: args.retryable ?? false,
      details: args.details ?? {},
    },
  };
}

/**
 * 按 UTF-8 字节数截断，且不切断多字节字符。
 * ChatGPT 侧按 token 截断且不告知；我们主动截断并显式标记（规格 §5.4）。
 *
 * 回退原理：UTF-8 的 continuation byte 形如 `10xxxxxx`。若截断点落在
 * continuation byte 上，说明正处于某个多字节字符中间，向前回退到该字符起始处。
 * 例：「中文中文」取 5 字节 → buf[5]=0x87 与 buf[4]=0x96 均为 continuation，
 * 回退至 end=3（buf[3]=0xE6 是「文」的首字节）→ 得到「中」。
 */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };

  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--;

  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function truncateList<T>(
  items: T[],
  max: number,
): { items: T[]; truncated: boolean; nextCursor: string | null } {
  if (items.length <= max) return { items, truncated: false, nextCursor: null };
  return { items: items.slice(0, max), truncated: true, nextCursor: String(max) };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd poc && pnpm test && pnpm typecheck`
Expected: 全部 PASS，typecheck 无错误。

- [ ] **Step 7: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add poc/package.json poc/pnpm-lock.yaml poc/tsconfig.json poc/vitest.config.ts poc/.gitignore poc/src/envelope.ts poc/tests/envelope.test.ts
git commit -m "feat(poc): 脚手架与响应信封

固定信封字段 ok/taskId/data/truncated/nextCursor/hint/taskContext。
截断按 UTF-8 字节且不切断多字节字符——ChatGPT 侧会静默截断，
我们必须主动截断并显式标记（规格 §5.4）。"
```

---

## Task 2: 假仓库与场景状态

**Files:**
- Create: `poc/src/fixtures.ts`
- Test: `poc/tests/fixtures.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface SearchHit { path: string; line: number; text: string }`
  - `class FakeRepo`，方法：
    - `readFile(path: string): { content: string; sha256: string } | undefined`
    - `writeFile(path: string, content: string): void`
    - `listPaths(): string[]`
    - `search(query: string): SearchHit[]`
    - `isFixed(): boolean`
    - `changedPaths(): string[]`
    - `diff(): string[]` —— 返回 diff 的行数组
    - `reset(): void`
  - `function getRepo(repoId: string): FakeRepo | undefined`
  - `function sha256(text: string): string`
  - `const REPO_IDS: readonly string[]`

**场景设计说明（这些 fixture 是测量仪器，不是随便造的数据）：**

| fixture | 服务于 |
|---|---|
| `src/parser.ts` 含 bug（未处理空输入） | 主循环：跑测试失败 → 编辑 → 再跑通过 |
| `src/generated-constants.ts` 含 200 处 `export const` | P-5 搜索结果溢出（上限 50 条）触发 `truncated` |
| `src/big-config.ts` 约 100 KB | P-5 单文件读取溢出（上限 64 KB）触发 `truncated` |

- [ ] **Step 1: 写失败的测试**

`poc/tests/fixtures.test.ts`：

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { getRepo, REPO_IDS, sha256 } from "../src/fixtures.ts";

describe("getRepo()", () => {
  it("已注册的 repoId 返回实例", () => {
    expect(getRepo("demo-app")).toBeDefined();
  });

  it("未注册的 repoId 返回 undefined", () => {
    expect(getRepo("no-such-repo")).toBeUndefined();
  });

  it("REPO_IDS 至少含 demo-app", () => {
    expect(REPO_IDS).toContain("demo-app");
  });

  it("同一 repoId 返回同一实例（状态需跨调用保持）", () => {
    expect(getRepo("demo-app")).toBe(getRepo("demo-app"));
  });
});

describe("FakeRepo", () => {
  beforeEach(() => {
    getRepo("demo-app")!.reset();
  });

  it("readFile 返回内容与 sha256", () => {
    const f = getRepo("demo-app")!.readFile("src/parser.ts");
    expect(f).toBeDefined();
    expect(f!.content).toContain("export function parse");
    expect(f!.sha256).toBe(sha256(f!.content));
  });

  it("readFile 对不存在的路径返回 undefined", () => {
    expect(getRepo("demo-app")!.readFile("src/nope.ts")).toBeUndefined();
  });

  it("初始状态未修复", () => {
    expect(getRepo("demo-app")!.isFixed()).toBe(false);
  });

  it("写入含空输入判断的 parser 后视为已修复", () => {
    const repo = getRepo("demo-app")!;
    repo.writeFile("src/parser.ts", "export function parse(s: string) {\n  if (s.length === 0) return [];\n  return s.split(',');\n}\n");
    expect(repo.isFixed()).toBe(true);
  });

  it("writeFile 后 sha256 变化", () => {
    const repo = getRepo("demo-app")!;
    const before = repo.readFile("src/parser.ts")!.sha256;
    repo.writeFile("src/parser.ts", "changed");
    expect(repo.readFile("src/parser.ts")!.sha256).not.toBe(before);
  });

  it("changedPaths 只列出被写过的文件", () => {
    const repo = getRepo("demo-app")!;
    expect(repo.changedPaths()).toEqual([]);
    repo.writeFile("src/parser.ts", "x");
    expect(repo.changedPaths()).toEqual(["src/parser.ts"]);
  });

  it("reset 清空修改", () => {
    const repo = getRepo("demo-app")!;
    repo.writeFile("src/parser.ts", "x");
    repo.reset();
    expect(repo.changedPaths()).toEqual([]);
    expect(repo.isFixed()).toBe(false);
  });

  it("listPaths 含全部 fixture 文件", () => {
    const paths = getRepo("demo-app")!.listPaths();
    expect(paths).toContain("src/parser.ts");
    expect(paths).toContain("tests/parser.test.ts");
    expect(paths).toContain("src/big-config.ts");
    expect(paths).toContain("src/generated-constants.ts");
  });

  it("big-config.ts 超过 64 KB —— 用于触发 P-5 读取截断", () => {
    const f = getRepo("demo-app")!.readFile("src/big-config.ts")!;
    expect(Buffer.byteLength(f.content, "utf8")).toBeGreaterThan(64 * 1024);
  });

  it("搜索 'export const' 命中超过 50 处 —— 用于触发 P-5 搜索截断", () => {
    expect(getRepo("demo-app")!.search("export const").length).toBeGreaterThan(50);
  });

  it("search 返回路径、行号与行文本", () => {
    const hits = getRepo("demo-app")!.search("export function parse");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ path: "src/parser.ts" });
    expect(hits[0]!.line).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("parse");
  });

  it("diff 在无修改时为空、有修改时含文件名", () => {
    const repo = getRepo("demo-app")!;
    expect(repo.diff()).toEqual([]);
    repo.writeFile("src/parser.ts", "x");
    expect(repo.diff().join("\n")).toContain("src/parser.ts");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd poc && pnpm test tests/fixtures.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/fixtures.ts"`

- [ ] **Step 3: 实现 fixtures.ts**

`poc/src/fixtures.ts`：

```typescript
import { createHash } from "node:crypto";

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const PARSER_BUGGY = `export function parse(input: string): string[] {
  return input.split(",").map((s) => s.trim());
}
`;

const PARSER_TEST = `import { describe, expect, it } from "vitest";
import { parse } from "../src/parser.ts";

describe("parser", () => {
  it("splits on comma", () => {
    expect(parse("a,b")).toEqual(["a", "b"]);
  });

  it("handles empty input", () => {
    expect(parse("")).toEqual([]);
  });
});
`;

const README = `# demo-app

一个用于 GrandeGPT POC 的最小示例项目。

\`src/parser.ts\` 有一个已知缺陷：空字符串输入时返回 \`[""]\` 而非 \`[]\`。
\`tests/parser.test.ts\` 中的 "handles empty input" 用例会因此失败。
`;

const PACKAGE_JSON = `{
  "name": "demo-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "vitest run", "lint": "eslint .", "typecheck": "tsc --noEmit" }
}
`;

/** 200 行 export const —— 使 "export const" 搜索命中数超过 50 条上限（P-5） */
function makeGeneratedConstants(): string {
  const lines: string[] = ["// 自动生成，请勿手工编辑", ""];
  for (let i = 1; i <= 200; i++) {
    lines.push(`export const SETTING_${String(i).padStart(3, "0")} = ${i};`);
  }
  return lines.join("\n") + "\n";
}

/** 约 100 KB —— 使单文件读取超过 64 KB 上限（P-5） */
function makeBigConfig(): string {
  const lines: string[] = ["// 大体积配置文件，用于验证读取截断", "export const CONFIG = {"];
  for (let i = 1; i <= 1400; i++) {
    lines.push(`  key_${String(i).padStart(4, "0")}: "value-${i}-padding-padding-padding-padding-padding",`);
  }
  lines.push("};", "");
  return lines.join("\n");
}

const BASE_FILES: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "README.md": README,
  "src/parser.ts": PARSER_BUGGY,
  "src/generated-constants.ts": makeGeneratedConstants(),
  "src/big-config.ts": makeBigConfig(),
  "tests/parser.test.ts": PARSER_TEST,
};

export class FakeRepo {
  readonly repoId: string;
  #files: Map<string, string>;
  #changed: Set<string>;

  constructor(repoId: string) {
    this.repoId = repoId;
    this.#files = new Map(Object.entries(BASE_FILES));
    this.#changed = new Set();
  }

  reset(): void {
    this.#files = new Map(Object.entries(BASE_FILES));
    this.#changed = new Set();
  }

  listPaths(): string[] {
    return [...this.#files.keys()].sort();
  }

  readFile(path: string): { content: string; sha256: string } | undefined {
    const content = this.#files.get(path);
    if (content === undefined) return undefined;
    return { content, sha256: sha256(content) };
  }

  writeFile(path: string, content: string): void {
    this.#files.set(path, content);
    this.#changed.add(path);
  }

  changedPaths(): string[] {
    return [...this.#changed].sort();
  }

  /** 判定「缺陷是否已修复」——修复的标志是 parser 里出现了空输入判断 */
  isFixed(): boolean {
    const parser = this.#files.get("src/parser.ts") ?? "";
    return /length\s*===\s*0|!input\b|input\s*===\s*""/.test(parser);
  }

  search(query: string): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const path of this.listPaths()) {
      const lines = (this.#files.get(path) ?? "").split("\n");
      lines.forEach((text, idx) => {
        if (text.includes(query)) hits.push({ path, line: idx + 1, text });
      });
    }
    return hits;
  }

  diff(): string[] {
    const out: string[] = [];
    for (const path of this.changedPaths()) {
      const base = BASE_FILES[path] ?? "";
      const now = this.#files.get(path) ?? "";
      out.push(`--- a/${path}`, `+++ b/${path}`);
      for (const line of base.split("\n")) if (line) out.push(`-${line}`);
      for (const line of now.split("\n")) if (line) out.push(`+${line}`);
    }
    return out;
  }
}

export const REPO_IDS = ["demo-app"] as const;

const repos = new Map<string, FakeRepo>();

export function getRepo(repoId: string): FakeRepo | undefined {
  if (!(REPO_IDS as readonly string[]).includes(repoId)) return undefined;
  let repo = repos.get(repoId);
  if (!repo) {
    repo = new FakeRepo(repoId);
    repos.set(repoId, repo);
  }
  return repo;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd poc && pnpm test tests/fixtures.test.ts && pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add poc/src/fixtures.ts poc/tests/fixtures.test.ts
git commit -m "feat(poc): 假仓库与场景状态

fixture 是测量仪器而非随意数据：parser.ts 的缺陷驱动
失败→编辑→通过的主循环；generated-constants.ts 的 200 处
命中触发搜索截断；big-config.ts 的 100KB 触发读取截断——
后两者专为验证 P-5 而设。"
```

---

## Task 3: 假 job 状态机

**Files:**
- Create: `poc/src/jobs.ts`
- Test: `poc/tests/jobs.test.ts`

**Interfaces:**
- Consumes: `getRepo` from `../src/fixtures.ts`
- Produces:
  - `type JobState = "running" | "passed" | "failed"`
  - `interface JobStatus { jobId: string; taskId: string; profile: string; state: JobState; exitCode: number | null; durationMs: number; failedTests: string[]; tail: string[]; artifactId: string }`
  - `function startJob(args: { taskId: string; repoId: string; profile: string }): { jobId: string }`
  - `function getJobStatus(jobId: string): JobStatus | undefined`
  - `function lastJobStateForTask(taskId: string): string | null`
  - `function resetJobs(): void`
  - `const JOB_DURATION_MS: number` —— 由环境变量 `POC_JOB_DURATION_MS` 控制，默认 `20000`

**为什么 job 必须真的耗时**：P-1 检验「模型是否自主轮询」。若 job 立即完成，模型一次调用就拿到结果，P-1 无从观察。默认 20 秒足以强制多次轮询，又不至于浪费测试时间。

- [ ] **Step 1: 写失败的测试**

`poc/tests/jobs.test.ts`：

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRepo } from "../src/fixtures.ts";
import { getJobStatus, JOB_DURATION_MS, lastJobStateForTask, resetJobs, startJob } from "../src/jobs.ts";

describe("job 状态机", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetJobs();
    getRepo("demo-app")!.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startJob 立即返回 jobId", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    expect(jobId).toMatch(/^job_/);
  });

  it("未到时长时状态为 running", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    vi.advanceTimersByTime(JOB_DURATION_MS - 1000);
    expect(getJobStatus(jobId)!.state).toBe("running");
  });

  it("running 时 exitCode 为 null", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    expect(getJobStatus(jobId)!.exitCode).toBeNull();
  });

  it("未修复时到时长后为 failed 并给出失败用例名", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    const s = getJobStatus(jobId)!;
    expect(s.state).toBe("failed");
    expect(s.exitCode).toBe(1);
    expect(s.failedTests).toEqual(["parser > handles empty input"]);
    expect(s.tail.join("\n")).toContain("handles empty input");
  });

  it("已修复时到时长后为 passed", () => {
    getRepo("demo-app")!.writeFile(
      "src/parser.ts",
      "export function parse(input: string) {\n  if (input.length === 0) return [];\n  return input.split(',');\n}\n",
    );
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    const s = getJobStatus(jobId)!;
    expect(s.state).toBe("passed");
    expect(s.exitCode).toBe(0);
    expect(s.failedTests).toEqual([]);
  });

  it("结果在 job 启动时刻定格，之后改文件不影响已启动的 job", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    getRepo("demo-app")!.writeFile("src/parser.ts", "if (input.length === 0) return [];");
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    expect(getJobStatus(jobId)!.state).toBe("failed");
  });

  it("未知 jobId 返回 undefined", () => {
    expect(getJobStatus("job_nope")).toBeUndefined();
  });

  it("lastJobStateForTask 返回该 task 最近一个 job 的状态", () => {
    expect(lastJobStateForTask("task_1")).toBeNull();
    startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    expect(lastJobStateForTask("task_1")).toBe("running");
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    expect(lastJobStateForTask("task_1")).toBe("failed");
  });

  it("artifactId 稳定且与 jobId 关联", () => {
    const { jobId } = startJob({ taskId: "task_1", repoId: "demo-app", profile: "unit" });
    const a = getJobStatus(jobId)!.artifactId;
    expect(a).toBe(getJobStatus(jobId)!.artifactId);
    expect(a).toContain(jobId.replace("job_", ""));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd poc && pnpm test tests/jobs.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/jobs.ts"`

- [ ] **Step 3: 实现 jobs.ts**

`poc/src/jobs.ts`：

```typescript
import { randomUUID } from "node:crypto";
import { getRepo } from "./fixtures.ts";

export type JobState = "running" | "passed" | "failed";

export interface JobStatus {
  jobId: string;
  taskId: string;
  profile: string;
  state: JobState;
  exitCode: number | null;
  durationMs: number;
  failedTests: string[];
  tail: string[];
  artifactId: string;
}

/** 必须让 job 真的耗时，否则 P-1「模型是否自主轮询」无从观察 */
export const JOB_DURATION_MS = Number(process.env.POC_JOB_DURATION_MS ?? 20_000);

interface JobRecord {
  jobId: string;
  taskId: string;
  profile: string;
  startedAt: number;
  /** 结果在启动时刻定格，模拟真实执行——启动后改文件不影响本次结果 */
  willPass: boolean;
}

const jobs = new Map<string, JobRecord>();
const jobsByTask = new Map<string, string[]>();

export function resetJobs(): void {
  jobs.clear();
  jobsByTask.clear();
}

export function startJob(args: { taskId: string; repoId: string; profile: string }): { jobId: string } {
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const repo = getRepo(args.repoId);
  jobs.set(jobId, {
    jobId,
    taskId: args.taskId,
    profile: args.profile,
    startedAt: Date.now(),
    willPass: repo?.isFixed() ?? false,
  });
  const list = jobsByTask.get(args.taskId) ?? [];
  list.push(jobId);
  jobsByTask.set(args.taskId, list);
  return { jobId };
}

const FAIL_TAIL = [
  "$ vitest run",
  "",
  " ❯ tests/parser.test.ts (2 tests | 1 failed)",
  "   ✓ parser > splits on comma",
  "   × parser > handles empty input",
  "",
  "  AssertionError: expected [ '' ] to deeply equal []",
  "   ❯ tests/parser.test.ts:12:26",
  "",
  " Test Files  1 failed (1)",
  "      Tests  1 failed | 1 passed (2)",
];

const PASS_TAIL = [
  "$ vitest run",
  "",
  " ✓ tests/parser.test.ts (2 tests)",
  "",
  " Test Files  1 passed (1)",
  "      Tests  2 passed (2)",
];

export function getJobStatus(jobId: string): JobStatus | undefined {
  const rec = jobs.get(jobId);
  if (!rec) return undefined;

  const elapsed = Date.now() - rec.startedAt;
  const done = elapsed >= JOB_DURATION_MS;
  const state: JobState = !done ? "running" : rec.willPass ? "passed" : "failed";

  return {
    jobId: rec.jobId,
    taskId: rec.taskId,
    profile: rec.profile,
    state,
    exitCode: !done ? null : rec.willPass ? 0 : 1,
    durationMs: done ? JOB_DURATION_MS : elapsed,
    failedTests: state === "failed" ? ["parser > handles empty input"] : [],
    tail: !done ? [] : rec.willPass ? PASS_TAIL : FAIL_TAIL,
    artifactId: `art_${rec.jobId.replace("job_", "")}`,
  };
}

export function lastJobStateForTask(taskId: string): string | null {
  const list = jobsByTask.get(taskId);
  if (!list || list.length === 0) return null;
  const lastId = list[list.length - 1] as string;
  return getJobStatus(lastId)?.state ?? null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd poc && pnpm test tests/jobs.test.ts && pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add poc/src/jobs.ts poc/tests/jobs.test.ts
git commit -m "feat(poc): 假 job 状态机

job 必须真的耗时（默认 20s，POC_JOB_DURATION_MS 可调），
否则 P-1「模型是否自主轮询」无从观察。结果在启动时刻定格，
模拟真实执行语义。"
```

---

## Task 4: 九个工具

**Files:**
- Create: `poc/src/tools.ts`
- Test: `poc/tests/tools.test.ts`

**Interfaces:**
- Consumes:
  - `ok`, `err`, `truncateText`, `truncateList`, `TaskContext` from `../src/envelope.ts`
  - `getRepo`, `sha256` from `../src/fixtures.ts`
  - `startJob`, `getJobStatus`, `lastJobStateForTask`, `JOB_DURATION_MS` from `../src/jobs.ts`
- Produces:
  - `function registerTools(server: McpServer, repoId: string): void`
  - `function resetTasks(): void`
  - `const LIMITS = { readBytes: 65536, searchHits: 50, diffLines: 400, tailLines: 40 }`
  - `const HINT_LANG: "zh" | "en"` —— 由 `POC_HINT_LANG` 控制，默认 `"zh"`

**关于 `HINT_LANG`**：规格 §12.2 把 hint 文案语言列为待决策。**若 P-1 失败，第一件要试的事就是把 hint 换成英文** —— 模型对英文指令的遵循度可能更高。做成环境变量，重测只需改一个变量。

- [ ] **Step 1: 写失败的测试**

`poc/tests/tools.test.ts`：

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRepo } from "../src/fixtures.ts";
import { JOB_DURATION_MS, resetJobs } from "../src/jobs.ts";
import { LIMITS, registerTools, resetTasks } from "../src/tools.ts";

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "poc", version: "0.0.0" });
  registerTools(server, "demo-app");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** 工具返回的信封放在 structuredContent；取出以便断言 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return (r as { structuredContent?: unknown }).structuredContent as Record<string, unknown>;
}

let client: Client;

beforeEach(async () => {
  resetTasks();
  resetJobs();
  getRepo("demo-app")!.reset();
  client = await connect();
});

afterEach(async () => {
  await client.close();
});

describe("工具注册", () => {
  it("恰好注册九个工具，名称与规格一致", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "grande_diff",
      "grande_repo_edit",
      "grande_repo_map",
      "grande_repo_read",
      "grande_repo_search",
      "grande_run",
      "grande_run_result",
      "grande_task_open",
      "grande_task_status",
    ]);
  });

  it("六个只读工具标注 readOnlyHint=true", async () => {
    const { tools } = await client.listTools();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
    expect(readOnly).toEqual([
      "grande_diff",
      "grande_repo_map",
      "grande_repo_read",
      "grande_repo_search",
      "grande_run_result",
      "grande_task_status",
    ]);
  });

  it("三个写工具 readOnlyHint=false 且 destructiveHint=false", async () => {
    const { tools } = await client.listTools();
    for (const name of ["grande_task_open", "grande_repo_edit", "grande_run"]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations?.readOnlyHint, name).toBe(false);
      expect(t.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it("所有工具 openWorldHint=false", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(t.annotations?.openWorldHint, t.name).toBe(false);
  });

  it("没有任何工具接受 repoId 参数（repoId 由端点决定）", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props), t.name).not.toContain("repoId");
    }
  });
});

describe("grande_task_open", () => {
  it("返回 taskId 与分支名", async () => {
    const e = await call(client, "grande_task_open", { goal: "修复空输入" });
    expect(e.ok).toBe(true);
    expect(e.taskId).toMatch(/^task_/);
    expect((e.taskContext as { branch: string }).branch).toMatch(/^grande\//);
  });

  it("hint 引导模型下一步去读代码", async () => {
    const e = await call(client, "grande_task_open", { goal: "修复空输入" });
    expect(String(e.hint).length).toBeGreaterThan(0);
    expect(String(e.hint)).toMatch(/grande_repo_map|grande_repo_search/);
  });
});

describe("grande_repo_read", () => {
  it("返回内容与 sha256", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_read", { taskId: t.taskId, path: "src/parser.ts" });
    const data = e.data as { path: string; content: string; sha256: string };
    expect(data.content).toContain("export function parse");
    expect(data.sha256).toHaveLength(64);
  });

  it("超过 64KB 的文件被截断且显式标记（P-5 用例）", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_read", { taskId: t.taskId, path: "src/big-config.ts" });
    expect(e.truncated).toBe(true);
    const data = e.data as { content: string };
    expect(Buffer.byteLength(data.content, "utf8")).toBeLessThanOrEqual(LIMITS.readBytes);
    expect(String(e.hint)).toContain("lineRange");
  });

  it("路径不存在返回 INVALID_INPUT", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_read", { taskId: t.taskId, path: "src/nope.ts" });
    expect(e.ok).toBe(false);
    expect((e.error as { code: string }).code).toBe("INVALID_INPUT");
  });

  it("taskId 不存在时错误里列出活跃任务", async () => {
    await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_read", { taskId: "task_nope", path: "src/parser.ts" });
    expect((e.error as { code: string }).code).toBe("TASK_NOT_FOUND");
    const details = (e.error as { details: { activeTasks: unknown[] } }).details;
    expect(details.activeTasks.length).toBeGreaterThan(0);
  });
});

describe("grande_repo_search", () => {
  it("命中超过 50 条时截断并给出游标（P-5 用例）", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_search", { taskId: t.taskId, query: "export const" });
    expect(e.truncated).toBe(true);
    expect(e.nextCursor).not.toBeNull();
    expect((e.data as { hits: unknown[] }).hits).toHaveLength(LIMITS.searchHits);
  });
});

describe("grande_repo_edit", () => {
  it("携带正确 expectedSha256 时写入成功", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const read = await call(client, "grande_repo_read", { taskId: t.taskId, path: "src/parser.ts" });
    const sha = (read.data as { sha256: string }).sha256;
    const e = await call(client, "grande_repo_edit", {
      taskId: t.taskId,
      edits: [{ op: "modify", path: "src/parser.ts", expectedSha256: sha, content: "fixed" }],
    });
    expect(e.ok).toBe(true);
    expect((e.taskContext as { filesChanged: number }).filesChanged).toBe(1);
  });

  it("expectedSha256 不匹配时返回 STALE_FILE 且不写入任何文件", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_edit", {
      taskId: t.taskId,
      edits: [{ op: "modify", path: "src/parser.ts", expectedSha256: "0".repeat(64), content: "x" }],
    });
    expect((e.error as { code: string }).code).toBe("STALE_FILE");
    expect(getRepo("demo-app")!.changedPaths()).toEqual([]);
  });

  it("多文件编辑中任一文件 sha 不匹配则整批不生效", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const read = await call(client, "grande_repo_read", { taskId: t.taskId, path: "src/parser.ts" });
    const sha = (read.data as { sha256: string }).sha256;
    const e = await call(client, "grande_repo_edit", {
      taskId: t.taskId,
      edits: [
        { op: "modify", path: "src/parser.ts", expectedSha256: sha, content: "a" },
        { op: "modify", path: "README.md", expectedSha256: "0".repeat(64), content: "b" },
      ],
    });
    expect((e.error as { code: string }).code).toBe("STALE_FILE");
    expect(getRepo("demo-app")!.changedPaths()).toEqual([]);
  });

  it("create 操作不需要 expectedSha256", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_edit", {
      taskId: t.taskId,
      edits: [{ op: "create", path: "src/new.ts", content: "export const x = 1;" }],
    });
    expect(e.ok).toBe(true);
  });

  it("不接受 delete 操作（S0 前不支持删除）", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_edit", {
      taskId: t.taskId,
      edits: [{ op: "delete", path: "src/parser.ts" }],
    });
    expect(e.ok).toBe(false);
  });
});

describe("grande_run 与 grande_run_result", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("grande_run 立即返回 jobId 与 pollAfterSeconds", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_run", { taskId: t.taskId, profile: "unit" });
    const data = e.data as { jobId: string; state: string; pollAfterSeconds: number };
    expect(data.jobId).toMatch(/^job_/);
    expect(data.state).toBe("running");
    expect(data.pollAfterSeconds).toBeGreaterThan(0);
  });

  it("running 时 hint 明确要求继续轮询并点名工具与 jobId", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const run = await call(client, "grande_run", { taskId: t.taskId, profile: "unit" });
    const jobId = (run.data as { jobId: string }).jobId;
    const e = await call(client, "grande_run_result", { taskId: t.taskId, jobId });
    expect(String(e.hint)).toContain("grande_run_result");
    expect(String(e.hint)).toContain(jobId);
  });

  it("完成后返回失败用例名与尾部日志", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const run = await call(client, "grande_run", { taskId: t.taskId, profile: "unit" });
    const jobId = (run.data as { jobId: string }).jobId;
    vi.advanceTimersByTime(JOB_DURATION_MS + 1);
    const e = await call(client, "grande_run_result", { taskId: t.taskId, jobId });
    const data = e.data as { state: string; failedTests: string[]; tail: string[]; artifactId: string };
    expect(data.state).toBe("failed");
    expect(data.failedTests).toEqual(["parser > handles empty input"]);
    expect(data.tail.length).toBeLessThanOrEqual(LIMITS.tailLines);
    expect(data.artifactId).toMatch(/^art_/);
  });

  it("未注册的 profile 返回 PROFILE_NOT_FOUND", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_run", { taskId: t.taskId, profile: "deploy" });
    expect((e.error as { code: string }).code).toBe("PROFILE_NOT_FOUND");
  });
});

describe("grande_task_status", () => {
  it("返回分支、变更文件与最近 job 状态——用于跨会话恢复", async () => {
    const t = await call(client, "grande_task_open", { goal: "修复空输入" });
    const e = await call(client, "grande_task_status", { taskId: t.taskId });
    const data = e.data as { branch: string; goal: string; changedPaths: string[]; lastJob: string | null };
    expect(data.goal).toBe("修复空输入");
    expect(data.branch).toMatch(/^grande\//);
    expect(data.changedPaths).toEqual([]);
    expect(data.lastJob).toBeNull();
  });

  it("无 taskId 时列出全部活跃任务", async () => {
    await call(client, "grande_task_open", { goal: "g1" });
    const e = await call(client, "grande_task_status", {});
    expect((e.data as { activeTasks: unknown[] }).activeTasks.length).toBe(1);
  });
});

describe("grande_repo_map 与 grande_diff", () => {
  it("repo_map 返回文件列表", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_map", { taskId: t.taskId });
    expect((e.data as { paths: string[] }).paths).toContain("src/parser.ts");
  });

  it("diff 在无修改时为空", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_diff", { taskId: t.taskId });
    expect((e.data as { lines: string[] }).lines).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd poc && pnpm test tests/tools.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/tools.ts"`

- [ ] **Step 3: 实现 tools.ts**

`poc/src/tools.ts`：

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { err, ok, truncateList, truncateText, type TaskContext } from "./envelope.ts";
import { getRepo } from "./fixtures.ts";
import { getJobStatus, JOB_DURATION_MS, lastJobStateForTask, startJob } from "./jobs.ts";

export const LIMITS = {
  readBytes: 65_536,
  searchHits: 50,
  diffLines: 400,
  tailLines: 40,
} as const;

/** 规格 §12.2 待决策项。P-1 若失败，第一件要试的事就是切到 "en" 重测。 */
export const HINT_LANG: "zh" | "en" = process.env.POC_HINT_LANG === "en" ? "en" : "zh";

const PROFILES = ["unit", "lint", "typecheck"] as const;

interface Task {
  taskId: string;
  repoId: string;
  goal: string;
  branch: string;
}

const tasks = new Map<string, Task>();

export function resetTasks(): void {
  tasks.clear();
}

function slugify(goal: string): string {
  const ascii = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return ascii.length > 0 ? ascii.slice(0, 24) : "task";
}

function contextFor(task: Task): TaskContext {
  const repo = getRepo(task.repoId);
  return {
    branch: task.branch,
    filesChanged: repo?.changedPaths().length ?? 0,
    lastJob: lastJobStateForTask(task.taskId),
  };
}

function t(zh: string, en: string): string {
  return HINT_LANG === "en" ? en : zh;
}

/** 工具结果统一形态：structuredContent 承载信封，content 给人类可读摘要 */
function reply(envelope: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as Record<string, unknown>,
  };
}

function requireTask(taskId: string | undefined) {
  if (taskId === undefined) {
    return err({
      code: "INVALID_INPUT",
      message: t("缺少 taskId。", "Missing taskId."),
      details: { activeTasks: [...tasks.values()].map((x) => ({ taskId: x.taskId, goal: x.goal })) },
    });
  }
  const task = tasks.get(taskId);
  if (!task) {
    return err({
      code: "TASK_NOT_FOUND",
      message: t(
        `任务 ${taskId} 不存在。请从下面的活跃任务中选一个。`,
        `Task ${taskId} not found. Pick one of the active tasks below.`,
      ),
      retryable: true,
      details: {
        activeTasks: [...tasks.values()].map((x) => ({
          taskId: x.taskId,
          goal: x.goal,
          branch: x.branch,
          filesChanged: getRepo(x.repoId)?.changedPaths().length ?? 0,
        })),
      },
    });
  }
  return task;
}

function isTask(v: Task | ReturnType<typeof err>): v is Task {
  return (v as { ok?: false }).ok !== false;
}

export function registerTools(server: McpServer, repoId: string): void {
  const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "grande_task_open",
    {
      title: "Open a development task",
      description: t(
        "在当前仓库上开启一个开发任务，创建隔离分支与工作区。任何读写代码的操作都必须先调用它拿到 taskId。",
        "Open a development task on the current repository, creating an isolated branch and worktree. Call this first to obtain a taskId; every other tool requires it.",
      ),
      inputSchema: { goal: z.string().describe("这次任务要达成的目标，一句话") },
      annotations: RW,
    },
    async ({ goal }) => {
      const taskId = `task_${randomUUID().slice(0, 8)}`;
      const task: Task = { taskId, repoId, goal, branch: `grande/${slugify(goal)}-${taskId.slice(5)}` };
      tasks.set(taskId, task);
      return reply(
        ok({
          taskId,
          data: { taskId, repoId, branch: task.branch, goal },
          taskContext: contextFor(task),
          hint: t(
            `任务已创建。先用 grande_repo_map 或 grande_repo_search 了解代码结构，再用 grande_repo_read 读具体文件。后续每次调用都要带 taskId=${taskId}。`,
            `Task created. Use grande_repo_map or grande_repo_search to explore, then grande_repo_read for specific files. Pass taskId=${taskId} on every later call.`,
          ),
        }),
      );
    },
  );

  server.registerTool(
    "grande_task_status",
    {
      title: "Get task status",
      description: t(
        "查询任务的分支、已修改文件与最近一次测试结果。新会话中恢复上下文时先调用它。不传 taskId 则列出全部活跃任务。",
        "Get a task's branch, changed files and latest test result. Call this first when resuming in a new conversation. Omit taskId to list all active tasks.",
      ),
      inputSchema: { taskId: z.string().optional() },
      annotations: RO,
    },
    async ({ taskId }) => {
      if (taskId === undefined) {
        return reply(
          ok({
            data: {
              activeTasks: [...tasks.values()].map((x) => ({
                taskId: x.taskId,
                goal: x.goal,
                branch: x.branch,
                filesChanged: getRepo(x.repoId)?.changedPaths().length ?? 0,
                lastJob: lastJobStateForTask(x.taskId),
              })),
            },
            hint: t("选一个 taskId 继续。", "Pick a taskId to continue."),
          }),
        );
      }
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const repo = getRepo(task.repoId)!;
      return reply(
        ok({
          taskId,
          data: {
            taskId,
            goal: task.goal,
            branch: task.branch,
            changedPaths: repo.changedPaths(),
            lastJob: lastJobStateForTask(taskId),
          },
          taskContext: contextFor(task),
          hint: t("可以继续读代码、修改或运行测试。", "You can continue reading, editing, or running tests."),
        }),
      );
    },
  );

  server.registerTool(
    "grande_repo_map",
    {
      title: "List repository files",
      description: t("列出仓库中的文件路径，用于快速了解结构。", "List file paths in the repository to understand its structure."),
      inputSchema: { taskId: z.string() },
      annotations: RO,
    },
    async ({ taskId }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const paths = getRepo(task.repoId)!.listPaths();
      return reply(
        ok({
          taskId,
          data: { paths },
          taskContext: contextFor(task),
          hint: t("用 grande_repo_read 读取感兴趣的文件。", "Use grande_repo_read to open a file."),
        }),
      );
    },
  );

  server.registerTool(
    "grande_repo_search",
    {
      title: "Search repository",
      description: t(
        "在仓库中按文本搜索，返回路径、行号与该行内容。结果最多 50 条，超出会标记 truncated。",
        "Search the repository by text; returns path, line number and line content. Capped at 50 hits; excess is flagged via truncated.",
      ),
      inputSchema: { taskId: z.string(), query: z.string() },
      annotations: RO,
    },
    async ({ taskId, query }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const all = getRepo(task.repoId)!.search(query);
      const { items, truncated, nextCursor } = truncateList(all, LIMITS.searchHits);
      return reply(
        ok({
          taskId,
          data: { hits: items, totalHits: all.length },
          truncated,
          nextCursor,
          taskContext: contextFor(task),
          hint: truncated
            ? t(
                `共 ${all.length} 处命中，只返回了前 ${LIMITS.searchHits} 条。需要更多请带 cursor=${nextCursor} 再次调用，或换一个更精确的 query。`,
                `${all.length} hits total, first ${LIMITS.searchHits} returned. Call again with cursor=${nextCursor} for more, or narrow the query.`,
              )
            : t("用 grande_repo_read 打开命中的文件。", "Use grande_repo_read to open a matched file."),
        }),
      );
    },
  );

  server.registerTool(
    "grande_repo_read",
    {
      title: "Read a file",
      description: t(
        "读取一个文件的内容，同时返回 sha256。修改该文件时必须把这个 sha256 作为 expectedSha256 传回，否则会被拒绝。",
        "Read a file's content along with its sha256. You MUST pass that sha256 back as expectedSha256 when modifying the file, or the edit is rejected.",
      ),
      inputSchema: {
        taskId: z.string(),
        path: z.string(),
        lineRange: z.string().optional().describe("形如 '100-200'，用于读取大文件的某一段"),
      },
      annotations: RO,
    },
    async ({ taskId, path, lineRange }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const file = getRepo(task.repoId)!.readFile(path);
      if (!file) {
        return reply(
          err({
            taskId,
            code: "INVALID_INPUT",
            message: t(`文件不存在：${path}`, `No such file: ${path}`),
            details: { path },
          }),
        );
      }

      let content = file.content;
      if (lineRange) {
        const [from, to] = lineRange.split("-").map((n) => Number(n));
        const lines = content.split("\n");
        content = lines.slice(Math.max(0, (from ?? 1) - 1), to ?? lines.length).join("\n");
      }

      const cut = truncateText(content, LIMITS.readBytes);
      return reply(
        ok({
          taskId,
          data: { path, content: cut.text, sha256: file.sha256, totalBytes: Buffer.byteLength(file.content, "utf8") },
          truncated: cut.truncated,
          taskContext: contextFor(task),
          hint: cut.truncated
            ? t(
                `文件过大已截断。需要后续内容请再次调用并带上 lineRange，例如 lineRange="500-1000"。修改此文件时用 expectedSha256=${file.sha256}。`,
                `File truncated. Call again with lineRange, e.g. lineRange="500-1000". Use expectedSha256=${file.sha256} when modifying it.`,
              )
            : t(
                `修改此文件时必须传 expectedSha256=${file.sha256}。`,
                `Pass expectedSha256=${file.sha256} when modifying this file.`,
              ),
        }),
      );
    },
  );

  server.registerTool(
    "grande_repo_edit",
    {
      title: "Edit files",
      description: t(
        "一次调用中修改或新建多个文件，全部成功或全部不生效。修改已有文件必须带 expectedSha256（来自 grande_repo_read）。不支持删除文件。",
        "Create or modify multiple files in one call; all succeed or none apply. Modifying an existing file requires expectedSha256 from grande_repo_read. Deleting files is not supported.",
      ),
      inputSchema: {
        taskId: z.string(),
        edits: z
          .array(
            z.object({
              op: z.enum(["create", "modify"]),
              path: z.string(),
              content: z.string(),
              expectedSha256: z.string().optional().describe("modify 时必填，取自 grande_repo_read"),
            }),
          )
          .min(1),
      },
      annotations: RW,
    },
    async ({ taskId, edits }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const repo = getRepo(task.repoId)!;

      // 事务语义：先全量校验，任一失败则整批不生效
      for (const e of edits) {
        if (e.op === "modify") {
          const cur = repo.readFile(e.path);
          if (!cur) {
            return reply(
              err({ taskId, code: "INVALID_INPUT", message: t(`文件不存在：${e.path}`, `No such file: ${e.path}`), details: { path: e.path } }),
            );
          }
          if (e.expectedSha256 !== cur.sha256) {
            return reply(
              err({
                taskId,
                code: "STALE_FILE",
                message: t(
                  `${e.path} 在你读取之后发生了变化，本次修改未生效（其他文件也未改动）。请重新 grande_repo_read 后再试。`,
                  `${e.path} changed after you read it; nothing was written. Re-read it with grande_repo_read and retry.`,
                ),
                retryable: true,
                details: { path: e.path, actualSha256: cur.sha256, providedSha256: e.expectedSha256 ?? null },
              }),
            );
          }
        }
      }

      for (const e of edits) repo.writeFile(e.path, e.content);

      return reply(
        ok({
          taskId,
          data: { written: edits.map((e) => e.path) },
          taskContext: contextFor(task),
          hint: t(
            "修改已应用。运行 grande_run(profile='unit') 验证。",
            "Edits applied. Run grande_run(profile='unit') to verify.",
          ),
        }),
      );
    },
  );

  server.registerTool(
    "grande_diff",
    {
      title: "Show changes",
      description: t("查看当前任务相对基线的全部改动。", "Show all changes in this task relative to its base."),
      inputSchema: { taskId: z.string() },
      annotations: RO,
    },
    async ({ taskId }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const all = getRepo(task.repoId)!.diff();
      const { items, truncated, nextCursor } = truncateList(all, LIMITS.diffLines);
      return reply(
        ok({
          taskId,
          data: { lines: items, totalLines: all.length },
          truncated,
          nextCursor,
          taskContext: contextFor(task),
          hint: truncated
            ? t(`diff 过长，只返回前 ${LIMITS.diffLines} 行。`, `Diff truncated to the first ${LIMITS.diffLines} lines.`)
            : t("确认改动无误后可运行测试。", "Run the tests once the changes look right."),
        }),
      );
    },
  );

  server.registerTool(
    "grande_run",
    {
      title: "Run a test/lint/build profile",
      description: t(
        `运行注册的命令 profile（可选：${PROFILES.join(" / ")}）。这是异步操作：本调用立即返回 jobId，你必须随后自行调用 grande_run_result 轮询直到得到最终结果，不要停下来等用户。`,
        `Run a registered command profile (one of: ${PROFILES.join(" / ")}). This is asynchronous: it returns a jobId immediately, and you MUST then poll grande_run_result yourself until you get a final result. Do not stop and wait for the user.`,
      ),
      inputSchema: { taskId: z.string(), profile: z.string() },
      annotations: RW,
    },
    async ({ taskId, profile }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      if (!(PROFILES as readonly string[]).includes(profile)) {
        return reply(
          err({
            taskId,
            code: "PROFILE_NOT_FOUND",
            message: t(`未注册的 profile：${profile}`, `Unregistered profile: ${profile}`),
            details: { available: PROFILES },
          }),
        );
      }
      const { jobId } = startJob({ taskId, repoId: task.repoId, profile });
      const pollAfterSeconds = Math.max(5, Math.round(JOB_DURATION_MS / 1000 / 2));
      return reply(
        ok({
          taskId,
          data: { jobId, state: "running", profile, pollAfterSeconds },
          taskContext: contextFor(task),
          hint: t(
            `${profile} 已启动，jobId=${jobId}。请在约 ${pollAfterSeconds} 秒后调用 grande_run_result(taskId="${taskId}", jobId="${jobId}") 查询；若仍在运行就继续轮询，直到 state 变为 passed 或 failed。这一步不需要用户介入。`,
            `${profile} started, jobId=${jobId}. Call grande_run_result(taskId="${taskId}", jobId="${jobId}") in about ${pollAfterSeconds} seconds; if it is still running, keep polling until state becomes passed or failed. No user input is needed for this.`,
          ),
        }),
      );
    },
  );

  server.registerTool(
    "grande_run_result",
    {
      title: "Poll a job result",
      description: t(
        "查询 grande_run 启动的 job。若 state 仍为 running，请稍候再次调用本工具，不要询问用户。",
        "Poll a job started by grande_run. If state is still running, call this tool again after a short wait — do not ask the user.",
      ),
      inputSchema: { taskId: z.string(), jobId: z.string() },
      annotations: RO,
    },
    async ({ taskId, jobId }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const status = getJobStatus(jobId);
      if (!status) {
        return reply(err({ taskId, code: "INVALID_INPUT", message: t(`未知 jobId：${jobId}`, `Unknown jobId: ${jobId}`), details: { jobId } }));
      }

      const running = status.state === "running";
      const pollAfterSeconds = Math.max(5, Math.round((JOB_DURATION_MS - status.durationMs) / 1000));

      return reply(
        ok({
          taskId,
          data: {
            jobId: status.jobId,
            state: status.state,
            exitCode: status.exitCode,
            durationMs: status.durationMs,
            failedTests: status.failedTests,
            tail: status.tail.slice(-LIMITS.tailLines),
            artifactId: status.artifactId,
            ...(running ? { pollAfterSeconds } : {}),
          },
          truncated: status.tail.length > LIMITS.tailLines,
          taskContext: contextFor(task),
          hint: running
            ? t(
                `job ${jobId} 仍在运行。请等待约 ${pollAfterSeconds} 秒后再次调用 grande_run_result(taskId="${taskId}", jobId="${jobId}")。不要询问用户，自行继续轮询。`,
                `Job ${jobId} is still running. Wait about ${pollAfterSeconds} seconds and call grande_run_result(taskId="${taskId}", jobId="${jobId}") again. Do not ask the user; keep polling yourself.`,
              )
            : status.state === "failed"
              ? t(
                  `${status.failedTests.length} 个用例失败。用 grande_repo_read 读相关文件，修改后再次运行。`,
                  `${status.failedTests.length} test(s) failed. Read the relevant file with grande_repo_read, fix it, then run again.`,
                )
              : t("测试全部通过。", "All tests passed."),
        }),
      );
    },
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd poc && pnpm test tests/tools.test.ts && pnpm typecheck`
Expected: 全部 PASS。

> SDK 1.29 已实测确认：**不声明 `outputSchema` 也会原样回传 `structuredContent`**，
> `annotations` 亦原样回传。无需为此额外配置。

若 `grande_run` 那组用例因 `vi.useFakeTimers()` 而卡住（`InMemoryTransport` 的消息投递若依赖
`setTimeout`，假定时器会让它永不触发），改为不用假定时器：把 `JOB_DURATION_MS` 通过
`POC_JOB_DURATION_MS=50` 设为 50 毫秒，用 `await new Promise((r) => setTimeout(r, 80))` 等待真实
时间流逝。**两种写法都可接受，以测试稳定通过为准。**

- [ ] **Step 5: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add poc/src/tools.ts poc/tests/tools.test.ts
git commit -m "feat(poc): 九个工具与注解

工具描述与 hint 都显式写明「自行轮询、不要询问用户」——
P-1 检验的正是模型是否遵循这一指令。hint 语言由
POC_HINT_LANG 控制，P-1 失败时可切英文重测。

repo_edit 为事务语义：任一文件 sha 不匹配则整批不生效。"
```

---

## Task 5: 观测日志与 MCP 服务端

**Files:**
- Create: `poc/src/observe.ts`
- Create: `poc/src/server.ts`
- Test: `poc/tests/server.test.ts`

**Interfaces:**
- Consumes: `registerTools` from `../src/tools.ts`；`REPO_IDS` from `../src/fixtures.ts`
- Produces:
  - `interface ObserveEvent { ts: number; iso: string; kind: "tool_call"; repoId: string; tool: string; args: Record<string, unknown>; durationMs: number; remoteUa: string }`
  - `function logEvent(e: ObserveEvent): void`
  - `function observeLogPath(): string`
  - `function createApp(): Hono` —— 供测试直接调用，不启动端口
  - `const POC_SECRET: string` —— 来自 `POC_SECRET` 环境变量

**访问控制**：POC 不实现 OAuth，改用不可猜测的路径段。端点形如 `/{POC_SECRET}/mcp/{repoId}`。`POC_SECRET` 缺失时进程拒绝启动。

- [ ] **Step 1: 写失败的测试**

`poc/tests/server.test.ts`：

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.ts";

const SECRET = "test-secret";

beforeEach(() => {
  process.env.POC_SECRET = SECRET;
});

describe("路由与访问控制", () => {
  it("健康检查无需 secret", async () => {
    const res = await createApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ok");
  });

  it("secret 错误时 MCP 端点返回 404", async () => {
    const res = await createApp().request("/wrong-secret/mcp/demo-app", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("未注册的 repoId 返回 404", async () => {
    const res = await createApp().request(`/${SECRET}/mcp/no-such-repo`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("正确 secret + 已注册 repo 的 initialize 请求返回 200", async () => {
    const res = await createApp().request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("tools/list 返回九个工具", async () => {
    const app = createApp();
    await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
    const res = await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    expect(text).toContain("grande_task_open");
    expect(text).toContain("grande_run_result");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd poc && pnpm test tests/server.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/server.ts"`

- [ ] **Step 3: 实现 observe.ts**

`poc/src/observe.ts`：

```typescript
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ObserveEvent {
  ts: number;
  iso: string;
  kind: "tool_call";
  repoId: string;
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  remoteUa: string;
}

export function observeLogPath(): string {
  return resolve(process.env.POC_LOG ?? "./observe.jsonl");
}

export function logEvent(e: ObserveEvent): void {
  const path = observeLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(e) + "\n", "utf8");
}
```

- [ ] **Step 4: 实现 server.ts**

`poc/src/server.ts`：

> **注意导入路径**：必须用 `server/webStandardStreamableHttp.js` 的
> `WebStandardStreamableHTTPServerTransport`（`handleRequest(request: Request): Promise<Response>`）。
> `server/streamableHttp.js` 的 `StreamableHTTPServerTransport` 是 Node 风格
> （`handleRequest(req: IncomingMessage, res: ServerResponse, body?)`），**与 Hono 不兼容**。
> 本写法取自 SDK 自带示例 `examples/server/honoWebStandardStreamableHttp`。

```typescript
import { serve } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { REPO_IDS } from "./fixtures.ts";
import { logEvent } from "./observe.ts";
import { registerTools } from "./tools.ts";

function secret(): string {
  const s = process.env.POC_SECRET;
  if (!s || s.length < 8) {
    throw new Error("POC_SECRET 未设置或过短（至少 8 字符）。这是 POC 唯一的访问控制手段。");
  }
  return s;
}

/**
 * 每个请求新建 server + transport，不设 sessionIdGenerator（无状态模式）。
 * 社区报告 ChatGPT 每次工具调用都新建 MCP session，无状态模式天然免疫该问题。
 * 业务状态（task / job / repo）保存在模块级单例中，与 MCP session 无关。
 */
async function handleMcp(repoId: string, request: Request): Promise<Response> {
  const server = new McpServer({ name: `grande-gpt-poc:${repoId}`, version: "0.0.0" });
  registerTools(server, repoId);

  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);

  return transport.handleRequest(request);
}

export function createApp(): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );

  app.get("/healthz", (c) => c.text("ok"));

  app.all("/:secret/mcp/:repoId", async (c) => {
    if (c.req.param("secret") !== secret()) return c.notFound();

    const repoId = c.req.param("repoId");
    if (!(REPO_IDS as readonly string[]).includes(repoId)) return c.notFound();

    const started = Date.now();
    const cloned = c.req.raw.clone();
    const response = await handleMcp(repoId, c.req.raw);

    // 观测日志：只记录 tools/call，其余 JSON-RPC 方法噪音太大
    void cloned
      .json()
      .then((body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }) => {
        if (body?.method !== "tools/call") return;
        logEvent({
          ts: started,
          iso: new Date(started).toISOString(),
          kind: "tool_call",
          repoId,
          tool: body.params?.name ?? "unknown",
          args: body.params?.arguments ?? {},
          durationMs: Date.now() - started,
          remoteUa: c.req.header("user-agent") ?? "",
        });
      })
      .catch(() => undefined);

    return response;
  });

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  secret(); // 启动前校验，缺失则直接抛错退出
  serve({ fetch: createApp().fetch, port });
  console.log(`POC listening on http://127.0.0.1:${port}`);
  console.log(`MCP endpoint: /<POC_SECRET>/mcp/${REPO_IDS.join(" | ")}`);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd poc && pnpm test tests/server.test.ts && pnpm typecheck`
Expected: 全部 PASS。

> DNS rebinding 保护在 `WebStandardStreamableHTTPServerTransport` 中默认关闭
> （需显式传 `enableDnsRebindingProtection` + `allowedHosts` 才启用）。POC 走隧道、
> Host 为 `m2m.agentjoey.ai`，保持默认关闭即可，无需配置 `allowedHosts`。

- [ ] **Step 6: 手工冒烟**

```bash
cd poc && POC_SECRET=local-dev-secret PORT=8787 pnpm dev
```

另开一个终端：

```bash
curl -s http://127.0.0.1:8787/healthz
```

Expected: `ok`

```bash
curl -s -X POST http://127.0.0.1:8787/local-dev-secret/mcp/demo-app \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Expected: 含 `"result"` 与 `serverInfo` 的 JSON（或 SSE 帧）。

- [ ] **Step 7: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add poc/src/observe.ts poc/src/server.ts poc/tests/server.test.ts
git commit -m "feat(poc): 观测日志与 MCP 服务端

无状态传输（sessionIdGenerator: undefined）——社区报告 ChatGPT
每次工具调用新建 session，无状态模式天然免疫。

访问控制用不可猜测路径段而非 OAuth：POC 只返回假数据，
且目标是验交互而非验认证。OAuth 留到 S0 第一周单独验证，
该项已记为残留风险。"
```

---

## Task 6: 观测报告生成器

**Files:**
- Create: `poc/scripts/report.ts`
- Test: `poc/tests/report.test.ts`

**Interfaces:**
- Consumes: `ObserveEvent` from `../src/observe.ts`
- Produces:
  - `function analyze(events: ObserveEvent[]): Analysis`
  - `interface RunEpisode { jobId: string; runAt: number; polls: number[]; gapsMs: number[]; maxGapMs: number; resolved: boolean; autoPolled: boolean }`
  - `interface Analysis { totalToolCalls: number; byTool: Record<string, number>; episodes: RunEpisode[]; taskIdLossEvents: number; longestChainWithoutGap: number; truncationFollowUps: number }`
  - `function renderMarkdown(a: Analysis): string`

**P-1 的判定依据**：`grande_run` 之后到该 jobId 解析出终态之间的 `grande_run_result` 调用，若相邻间隔全部 ≤ 60 秒，则视为**模型自主轮询**；出现 > 60 秒的间隔，说明大概率是人类手动催促。这只是证据的一半，另一半是执行协议时人类的记录（PROTOCOL.md 要求记下自己何时打字）。

- [ ] **Step 1: 写失败的测试**

`poc/tests/report.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import type { ObserveEvent } from "../src/observe.ts";
import { analyze, renderMarkdown } from "../scripts/report.ts";

function ev(tool: string, ts: number, args: Record<string, unknown> = {}): ObserveEvent {
  return { ts, iso: new Date(ts).toISOString(), kind: "tool_call", repoId: "demo-app", tool, args, durationMs: 5, remoteUa: "test" };
}

const T0 = 1_800_000_000_000;

describe("analyze()", () => {
  it("统计工具调用总数与分布", () => {
    const a = analyze([ev("grande_repo_read", T0), ev("grande_repo_read", T0 + 1000), ev("grande_diff", T0 + 2000)]);
    expect(a.totalToolCalls).toBe(3);
    expect(a.byTool.grande_repo_read).toBe(2);
  });

  it("间隔均 ≤60s 的轮询序列判定为自主轮询", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }),
      ev("grande_run_result", T0 + 10_000, { taskId: "task_1", jobId: "job_a" }),
      ev("grande_run_result", T0 + 22_000, { taskId: "task_1", jobId: "job_a" }),
    ]);
    expect(a.episodes).toHaveLength(1);
    expect(a.episodes[0]!.polls).toHaveLength(2);
    expect(a.episodes[0]!.autoPolled).toBe(true);
    expect(a.episodes[0]!.maxGapMs).toBeLessThanOrEqual(60_000);
  });

  it("出现超过 60s 的间隔则判定为非自主（疑似人工催促）", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }),
      ev("grande_run_result", T0 + 95_000, { taskId: "task_1", jobId: "job_a" }),
    ]);
    expect(a.episodes[0]!.autoPolled).toBe(false);
  });

  it("run 之后没有任何轮询则记为未解析且非自主", () => {
    const a = analyze([ev("grande_run", T0, { taskId: "task_1", profile: "unit" })]);
    expect(a.episodes[0]!.polls).toHaveLength(0);
    expect(a.episodes[0]!.autoPolled).toBe(false);
    expect(a.episodes[0]!.resolved).toBe(false);
  });

  it("统计 TASK_NOT_FOUND 触发次数（taskId 丢失信号）", () => {
    const a = analyze([
      ev("grande_repo_read", T0, { taskId: "task_1", path: "a" }),
      ev("grande_repo_read", T0 + 1000, { path: "a" }),
      ev("grande_repo_read", T0 + 2000, { taskId: "task_wrong", path: "a" }),
    ]);
    expect(a.taskIdLossEvents).toBe(1);
  });

  it("统计带 cursor 或 lineRange 的续读次数（P-5 信号）", () => {
    const a = analyze([
      ev("grande_repo_read", T0, { taskId: "task_1", path: "big" }),
      ev("grande_repo_read", T0 + 1000, { taskId: "task_1", path: "big", lineRange: "100-200" }),
      ev("grande_repo_search", T0 + 2000, { taskId: "task_1", query: "q", cursor: "50" }),
    ]);
    expect(a.truncationFollowUps).toBe(2);
  });

  it("统计相邻间隔均 ≤60s 的最长连续调用链", () => {
    const a = analyze([
      ev("grande_repo_read", T0),
      ev("grande_repo_read", T0 + 5_000),
      ev("grande_repo_read", T0 + 10_000),
      ev("grande_repo_read", T0 + 200_000),
    ]);
    expect(a.longestChainWithoutGap).toBe(3);
  });
});

describe("renderMarkdown()", () => {
  it("输出含 P-1～P-5 五个小节", () => {
    const md = renderMarkdown(analyze([ev("grande_run", T0, { taskId: "t", profile: "unit" })]));
    for (const p of ["P-1", "P-2", "P-3", "P-4", "P-5"]) expect(md).toContain(p);
  });

  it("P-1 结论明确给出 PASS 或 FAIL", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }),
        ev("grande_run_result", T0 + 10_000, { taskId: "t", jobId: "job_a" }),
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*(PASS|FAIL)\*\*/s);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd poc && pnpm test tests/report.test.ts`
Expected: FAIL —— `Failed to resolve import "../scripts/report.ts"`

- [ ] **Step 3: 实现 report.ts**

`poc/scripts/report.ts`：

```typescript
import { readFileSync } from "node:fs";
import type { ObserveEvent } from "../src/observe.ts";
import { observeLogPath } from "../src/observe.ts";

/** 超过这个间隔就认为中间夹了人类操作，而非模型自主连续调用 */
const HUMAN_GAP_MS = 60_000;

export interface RunEpisode {
  jobId: string;
  runAt: number;
  polls: number[];
  gapsMs: number[];
  maxGapMs: number;
  resolved: boolean;
  autoPolled: boolean;
}

export interface Analysis {
  totalToolCalls: number;
  byTool: Record<string, number>;
  episodes: RunEpisode[];
  taskIdLossEvents: number;
  longestChainWithoutGap: number;
  truncationFollowUps: number;
}

export function analyze(events: ObserveEvent[]): Analysis {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  const byTool: Record<string, number> = {};
  for (const e of sorted) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;

  // task_open 的 taskId 出现在返回值而非入参，因此以「后续调用中最早出现的 taskId」
  // 作为基线；此后任何使用其他 taskId 的调用都计为一次 taskId 丢失。
  const baseline = sorted.find((e) => typeof e.args.taskId === "string")?.args.taskId as string | undefined;

  let taskIdLossEvents = 0;
  let truncationFollowUps = 0;
  for (const e of sorted) {
    const tid = e.args.taskId;
    if (baseline !== undefined && typeof tid === "string" && tid !== baseline) taskIdLossEvents++;
    if (e.args.cursor !== undefined || e.args.lineRange !== undefined) truncationFollowUps++;
  }

  const episodes: RunEpisode[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i] as ObserveEvent;
    if (e.tool !== "grande_run") continue;

    // 收集本次 run 之后、下一次 run 之前的全部轮询
    const pollEvents: ObserveEvent[] = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const p = sorted[j] as ObserveEvent;
      if (p.tool === "grande_run") break;
      if (p.tool === "grande_run_result") pollEvents.push(p);
    }

    const polls = pollEvents.map((p) => p.ts);
    const marks = [e.ts, ...polls];
    const gapsMs = marks.slice(1).map((ts, k) => ts - (marks[k] as number));
    const maxGapMs = gapsMs.length > 0 ? Math.max(...gapsMs) : Number.POSITIVE_INFINITY;

    episodes.push({
      jobId: String(pollEvents[0]?.args.jobId ?? "?"),
      runAt: e.ts,
      polls,
      gapsMs,
      maxGapMs,
      resolved: polls.length > 0,
      autoPolled: polls.length > 0 && maxGapMs <= HUMAN_GAP_MS,
    });
  }

  let longestChainWithoutGap = sorted.length > 0 ? 1 : 0;
  let current = sorted.length > 0 ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] as ObserveEvent).ts - (sorted[i - 1] as ObserveEvent).ts;
    current = gap <= HUMAN_GAP_MS ? current + 1 : 1;
    longestChainWithoutGap = Math.max(longestChainWithoutGap, current);
  }

  return { totalToolCalls: sorted.length, byTool, episodes, taskIdLossEvents, longestChainWithoutGap, truncationFollowUps };
}

function verdict(pass: boolean): string {
  return pass ? "**PASS**" : "**FAIL**";
}

export function renderMarkdown(a: Analysis): string {
  const autoPolled = a.episodes.filter((e) => e.autoPolled).length;
  const p1Pass = a.episodes.length > 0 && autoPolled === a.episodes.length;

  const lines: string[] = [
    "# GrandeGPT POC 观测报告（自动生成部分）",
    "",
    `工具调用总数：**${a.totalToolCalls}**　·　最长无人工间隔调用链：**${a.longestChainWithoutGap}**`,
    "",
    "## 工具调用分布",
    "",
    "| 工具 | 次数 |",
    "|---|---|",
    ...Object.entries(a.byTool)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `| \`${k}\` | ${v} |`),
    "",
    `## P-1 模型是否自主轮询 —— ${verdict(p1Pass)}`,
    "",
    `共 ${a.episodes.length} 次 \`grande_run\`，其中 ${autoPolled} 次由模型自主轮询至终态。`,
    "",
    "| # | 轮询次数 | 各次间隔(s) | 最大间隔(s) | 判定 |",
    "|---|---|---|---|---|",
    ...a.episodes.map(
      (e, i) =>
        `| ${i + 1} | ${e.polls.length} | ${e.gapsMs.map((g) => (g / 1000).toFixed(1)).join(", ") || "—"} | ${
          Number.isFinite(e.maxGapMs) ? (e.maxGapMs / 1000).toFixed(1) : "∞"
        } | ${e.autoPolled ? "自主" : "非自主"} |`,
    ),
    "",
    `> 判定规则：\`grande_run\` 到终态之间相邻间隔均 ≤ ${HUMAN_GAP_MS / 1000}s 视为自主轮询。`,
    "> **这只是证据的一半**，另一半是执行者在 PROTOCOL.md 中记录的「我何时打了字」。两者需一致。",
    "",
    "## P-2 额度消耗",
    "",
    "自动统计无法得知消耗了多少条额度（ChatGPT 不暴露该信息）。",
    "**须由执行者手工填写**：任务开始前后各查看一次额度提示，记录差值。",
    "",
    `## P-3 taskId 保持 —— ${verdict(a.taskIdLossEvents === 0)}`,
    "",
    `检测到 ${a.taskIdLossEvents} 次使用了非基线 taskId 的调用。`,
    "",
    "## P-4 确认框次数",
    "",
    "自动统计无法观测 ChatGPT 端的确认框。**须由执行者手工填写**：记录弹框次数与「记住」后是否不再弹。",
    "",
    `## P-5 截断续读 —— ${verdict(a.truncationFollowUps > 0)}`,
    "",
    `检测到 ${a.truncationFollowUps} 次带 \`cursor\` 或 \`lineRange\` 的续读调用。`,
    "",
  ];
  return lines.join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const raw = readFileSync(observeLogPath(), "utf8");
  const events = raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ObserveEvent);
  process.stdout.write(renderMarkdown(analyze(events)));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd poc && pnpm test tests/report.test.ts && pnpm typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: 全量测试与提交**

Run: `cd poc && pnpm test && pnpm typecheck`
Expected: 六个测试文件全部 PASS。

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add poc/scripts/report.ts poc/tests/report.test.ts
git commit -m "feat(poc): 观测报告生成器

P-1 的判定依据是 run→终态之间相邻间隔均 ≤60s。
报告里明确写出「这只是证据的一半」——另一半是执行者
记录的打字时刻，两者必须一致才算数。

P-2 与 P-4 无法自动观测，报告留出手工填写位。"
```

---

## Task 7: 隧道接入与测试协议

**Files:**
- Create: `poc/PROTOCOL.md`
- Modify: `poc/package.json`（新增 `tunnel` 脚本）

**Interfaces:**
- Consumes: `createApp` from `../src/server.ts`
- Produces: 可在 ChatGPT 中连接的公网端点；一份人类可逐步执行的测试脚本

- [ ] **Step 1: 生成 POC_SECRET 并配置隧道**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt/poc
node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))"
```

把输出记为 `POC_SECRET`（不要提交到 git）。

在 `poc/package.json` 的 `scripts` 中加入：

```json
    "tunnel": "cloudflared tunnel --url http://127.0.0.1:8787"
```

若 `m2m.agentjoey.ai` 已配置为具名隧道，改用具名形式（以你现有的 cloudflared 配置为准）：

```json
    "tunnel": "cloudflared tunnel run m2m"
```

- [ ] **Step 2: 启动服务与隧道并验证公网可达**

终端 A：

```bash
cd poc && POC_SECRET=<你的secret> PORT=8787 POC_LOG=./observe.jsonl pnpm dev
```

终端 B：

```bash
cd poc && pnpm tunnel
```

终端 C：

```bash
curl -s https://m2m.agentjoey.ai/healthz
```

Expected: `ok`

若返回非 `ok`，先解决隧道再继续 —— 后续所有步骤都依赖它。

- [ ] **Step 3: 在 ChatGPT 中添加连接器**

1. 在 ChatGPT 网页版进入 **Settings → Security and login**，启用 developer mode
2. 进入 **Settings → Plugins**（或 `chatgpt.com/plugins`），点 **+** 新建 developer-mode app
3. URL 填 `https://m2m.agentjoey.ai/<POC_SECRET>/mcp/demo-app`
4. 认证方式选 **No Authentication**
5. 保存后确认工具列表显示九个 `grande_*` 工具

若此步失败，把失败信息记入观察记录的「未覆盖项」—— 这本身就是 S0 必须解决的问题。

- [ ] **Step 4: 确认训练数据设置（规格 D12）**

进入 **Settings → Data Controls**，确认「用我的内容改进模型」处于关闭状态，并把结果记入观察记录。

- [ ] **Step 5: 写 PROTOCOL.md**

`poc/PROTOCOL.md`：

````markdown
# POC 执行协议

> 严格按本文操作。**每一步都要记下你何时打了字** —— 这是判定 P-1 的另一半证据。
> **全程手动操作，禁止任何脚本化驱动**（规格 §2.3）。

## 准备

```bash
# 终端 A
cd poc && POC_SECRET=<secret> PORT=8787 POC_LOG=./observe.jsonl pnpm dev
# 终端 B
cd poc && pnpm tunnel
```

每轮开始前重置日志与状态：重启终端 A 的进程，并 `rm -f poc/observe.jsonl`。

## 每轮执行的脚本

在 ChatGPT 中新建对话（**每轮必须是全新对话**），启用 `demo-app` 连接器，然后：

**第 1 条消息**（原样粘贴）：

```
用 demo-app 这个仓库开一个开发任务，目标是「修复 parser 对空输入的处理」。
先看看代码结构，找到相关文件读一下，然后跑单元测试看看现在是什么情况。
```

**然后停手。** 不要再打字。观察并记录：

- [ ] 模型是否自己调用了 `grande_task_open`
- [ ] 模型是否自己调用了 `grande_run`
- [ ] **模型是否在没有你打字的情况下自己调用了 `grande_run_result`（这是 P-1）**
- [ ] 弹了几次确认框？分别是哪个工具？
- [ ] 你在此期间**一个字都没打**吗？（若打了，记下时刻与内容）

**若模型停下来问你「要我继续检查吗」之类的问题** —— 这就是 P-1 FAIL 的直接证据。记下它的原话，然后回复「继续」让流程走下去。

**第 2 条消息**（在模型报告测试失败之后）：

```
修一下这个问题，然后重新跑测试确认通过。
```

再次停手，记录同样的项目。

**第 3 条消息**（用于测 P-5）：

```
把 src/big-config.ts 完整读一遍，告诉我里面一共定义了多少个 key。
```

记录：

- [ ] 模型是否注意到响应被截断
- [ ] 模型是否用 `lineRange` 继续读取

**第 4 条消息**（用于测 P-3）：

```
搜一下仓库里所有的 export const，看看有多少个。
```

记录：

- [ ] 模型是否仍在使用正确的 `taskId`
- [ ] 模型是否用 `cursor` 续读

## 每轮结束后

```bash
cd poc && POC_LOG=./observe.jsonl pnpm report > ../docs/research/poc-round-<N>.md
```

把手工观察项补进生成的报告。

## 额度记录（P-2）

每轮**开始前**与**结束后**各记录一次：使用的模型（Sol / Terra / Luna）、
是否出现额度提示、剩余额度（若可见）。
````

- [ ] **Step 6: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add poc/PROTOCOL.md poc/package.json
git commit -m "docs(poc): 隧道接入与测试协议

PROTOCOL.md 要求执行者记录「我何时打了字」——
日志只能证明调用发生了，证明不了是模型自主还是人工催促，
两份证据必须互相印证。

强调每轮用全新对话，且全程手动（规格 §2.3 合规红线）。"
```

---

## Task 8: 执行 POC 并产出观察记录

**Files:**
- Create: `docs/research/2026-07-26-poc-observation.md`
- Modify: `docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`（依结果修订 §13 与 §5）

**Interfaces:**
- Consumes: `poc/PROTOCOL.md`、`pnpm report` 的输出
- Produces: S0 的 go / no-go 决定

**本任务无代码**，全部是人工执行与结论记录。

- [ ] **Step 1: 按 PROTOCOL.md 执行三轮**

三轮均使用全新对话。若可能，至少一轮用 Sol、一轮用 Terra —— 不同模型层级的工具遵循度可能差别很大，而这直接影响规格 §19.2 的模型分工建议。

每轮产出 `docs/research/poc-round-<N>.md`。

- [ ] **Step 2: 汇总为观察记录**

创建 `docs/research/2026-07-26-poc-observation.md`，必须包含：

```markdown
# GrandeGPT POC 观察记录

**执行日期**：<填写>
**执行者**：<填写>
**ChatGPT 套餐 / 模型**：<填写>
**POC 版本**：<git commit sha>

## 结论：S0 go / no-go

<一句话结论>

## P-1～P-5 判定

| # | 项 | 判定 | 证据 |
|---|---|---|---|
| P-1 | 模型自主轮询 | PASS / FAIL | <三轮的自主轮询比例；模型是否停下来问用户> |
| P-2 | 额度消耗 | 记录值 | <每轮消耗；按 Sol/Terra/Luna 分列> |
| P-3 | taskId 保持 | PASS / FAIL | <30 次调用后是否仍正确> |
| P-4 | 确认框 | 记录值 | <次数；「记住」是否生效> |
| P-5 | 截断续读 | PASS / FAIL | <是否主动 lineRange / cursor> |

## 未覆盖项

- **OAuth 2.1 + PKCE 握手未验证**（POC 用 No Authentication）。S0 第一周必须单独验证，失败会阻塞 S0。
- <其他执行中发现的未覆盖项>

## 对规格的修订建议

<按发现逐条列出，指明要改规格的哪一节>
```

- [ ] **Step 3: 依结果修订规格**

- **P-1 FAIL** → 修订规格 §13.2 R2 的严重度评估，并**暂停 S0**。先试 `POC_HINT_LANG=en` 重测一轮；若仍 FAIL，需重新设计异步模型（候选方向：把 `grande_run` 改为同步阻塞但缩短 job 时长、或探索 MCP Tasks 扩展在 ChatGPT 的可用性）。
- **P-1 PASS** → 在 §13.2 R2 记录实测证据，并按 P-2 的实测值修订 §13.2 R1 的结论。
- **P-3 FAIL** → 修订规格 §5.5，加强 `taskContext` 回带策略。
- **P-4 异常** → 修订规格 §5.1 与 §5.2 的工具粒度。
- **P-5 FAIL** → 修订规格 §5.4 的截断策略。

- [ ] **Step 4: 提交**

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt
git add docs/research/ docs/superpowers/specs/
git commit -m "docs: POC 观察记录与规格修订

<一句话写清 P-1 结果与 S0 的 go/no-go 决定>"
```

- [ ] **Step 5: 更新项目状态**

依 go / no-go 结果更新 `README.md` 的状态段与 `CLAUDE.md` 的「当前状态」段。

```bash
git add README.md CLAUDE.md
git commit -m "docs: 更新项目状态至 POC 完成"
```

---

## 附：POC 完成后的清理

POC 代码**不进入 S0 代码库**（Global Constraints）。S0 启动时：

```bash
git rm -r poc/
git commit -m "chore: 移除 POC 代码，结论已固化到规格与观察记录"
```

`poc/observe.jsonl` 与 `POC_SECRET` 属于本地产物，**不要提交**。在 `poc/.gitignore` 中加入：

```
observe.jsonl
.env
```
