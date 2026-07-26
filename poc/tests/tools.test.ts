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

/**
 * 工具返回的信封放在 structuredContent；取出以便断言。
 *
 * 例外：当参数在 zod inputSchema 层就被拒绝（例如 grande_repo_edit 的
 * op 枚举不含 "delete"）时，SDK 1.29 在工具处理函数被调用之前就返回
 * `isError:true` 且没有 structuredContent 的结果（见 task-4-report.md
 * 的 Concerns 一节）。这里补一个最小的 `{ ok: false }` 占位，使调用方
 * 仍能用同一套 e.ok / e.error 断言，且不改变任何工具的行为或措辞。
 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const structured = (r as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) return structured as Record<string, unknown>;
  const raw = r as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  if (raw.isError) {
    return { ok: false, error: { code: "SCHEMA_VALIDATION_ERROR", message: raw.content?.[0]?.text ?? "" } } as Record<
      string,
      unknown
    >;
  }
  return structured as unknown as Record<string, unknown>;
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

  it("I3 回归：content[0].text 是精简摘要，明显短于 structuredContent 的完整信封——不再是重复的 JSON.stringify（读大文件时此前测得 143KB，一大半就是这份重复）", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const r = await client.callTool({ name: "grande_repo_read", arguments: { taskId: t.taskId, path: "src/big-config.ts" } });
    const content = (r as { content: Array<{ type: string; text?: string }> }).content;
    const structured = (r as { structuredContent: Record<string, unknown> }).structuredContent;
    const text = content[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(JSON.stringify(structured).length / 2);
    // 摘要仍然带着 truncated 信号和 hint，模型不需要 structuredContent 也能
    // 知道"这个响应被截断了、要带 lineRange 续读"。
    expect(text).toContain("truncated=true");
    expect(text).toContain("lineRange");
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

  it("C2 回归：带上一页的 nextCursor 作为 cursor 再次调用，返回下一页而不是与第一页字节相同的结果（此前 inputSchema 不接受 cursor，zod 会静默剥掉它）", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const page1 = await call(client, "grande_repo_search", { taskId: t.taskId, query: "export const" });
    const cursor = page1.nextCursor as string;
    expect(cursor).not.toBeNull();

    const page2 = await call(client, "grande_repo_search", { taskId: t.taskId, query: "export const", cursor });
    const hits1 = (page1.data as { hits: unknown[] }).hits;
    const hits2 = (page2.data as { hits: unknown[] }).hits;
    expect(hits2).not.toEqual(hits1);
  });

  it("C2 回归：翻到最后一页时 truncated 为 false、nextCursor 为 null——续读能终止", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    // "export const" 共 201 处命中（见 fixtures.test.ts）；带一个远超总数的 cursor
    // 直接跳到末页之后，验证收尾行为而不依赖记住确切总数。
    const e = await call(client, "grande_repo_search", { taskId: t.taskId, query: "export const", cursor: "1000" });
    expect(e.truncated).toBe(false);
    expect(e.nextCursor).toBeNull();
    expect((e.data as { hits: unknown[] }).hits).toEqual([]);
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

  it("M9 回归：create 作用于已存在路径时报错、不写入任何文件——此前会静默覆盖，绕过 expectedSha256 机制", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const before = getRepo("demo-app")!.readFile("src/parser.ts")!.content;
    const e = await call(client, "grande_repo_edit", {
      taskId: t.taskId,
      edits: [{ op: "create", path: "src/parser.ts", content: "overwritten by mistake" }],
    });
    expect(e.ok).toBe(false);
    expect((e.error as { code: string }).code).toBe("PATH_EXISTS");
    expect(getRepo("demo-app")!.readFile("src/parser.ts")!.content).toBe(before);
    expect(getRepo("demo-app")!.changedPaths()).toEqual([]);
  });

  it("M9 回归：批量编辑里只要有一个 create 命中已存在路径，整批（包括其它本该成功的 create）都不生效——事务保证不因为新增的校验分支而被破坏", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const e = await call(client, "grande_repo_edit", {
      taskId: t.taskId,
      edits: [
        { op: "create", path: "src/brand-new.ts", content: "export const x = 1;" },
        { op: "create", path: "src/parser.ts", content: "overwritten by mistake" }, // 已存在，应让整批失败
      ],
    });
    expect(e.ok).toBe(false);
    expect(getRepo("demo-app")!.changedPaths()).toEqual([]);
    expect(getRepo("demo-app")!.readFile("src/brand-new.ts")).toBeUndefined();
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

  it("M8 回归：taskId 错误（TASK_NOT_FOUND）与 grande_task_status 缺省 taskId 两条恢复路径返回同一套字段，模型不会从「传错」恢复时比从「漏传」恢复时拿到更多线索", async () => {
    await call(client, "grande_task_open", { goal: "g" });

    const wrongTaskId = await call(client, "grande_repo_read", { taskId: "task_nope", path: "src/parser.ts" });
    const fromWrongTaskId = (wrongTaskId.error as { details: { activeTasks: Array<Record<string, unknown>> } }).details
      .activeTasks[0]!;

    const statusNoTaskId = await call(client, "grande_task_status", {});
    const fromStatusNoTaskId = (statusNoTaskId.data as { activeTasks: Array<Record<string, unknown>> }).activeTasks[0]!;

    expect(Object.keys(fromWrongTaskId).sort()).toEqual(Object.keys(fromStatusNoTaskId).sort());
    expect(Object.keys(fromWrongTaskId).sort()).toEqual(["branch", "filesChanged", "goal", "lastJob", "taskId"]);
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

  it("C2 回归：diff 超过 400 行时截断并给出游标，cursor 续读能翻到下一页而不是重复第一页", async () => {
    const t = await call(client, "grande_task_open", { goal: "g" });
    const bigContent = Array.from({ length: 450 }, (_, i) => `line_${i}`).join("\n");
    await call(client, "grande_repo_edit", {
      taskId: t.taskId,
      edits: [{ op: "create", path: "src/huge.txt", content: bigContent }],
    });

    const page1 = await call(client, "grande_diff", { taskId: t.taskId });
    expect(page1.truncated).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    expect((page1.data as { lines: string[] }).lines).toHaveLength(LIMITS.diffLines);

    const page2 = await call(client, "grande_diff", { taskId: t.taskId, cursor: page1.nextCursor as string });
    const lines1 = (page1.data as { lines: string[] }).lines;
    const lines2 = (page2.data as { lines: string[] }).lines;
    expect(lines2).not.toEqual(lines1);
  });
});
