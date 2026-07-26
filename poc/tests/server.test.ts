import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMcpJsonRpcResponse } from "../src/mcpResponse.ts";
import { createApp } from "../src/server.ts";

const SECRET = "test-secret";

beforeEach(() => {
  process.env.POC_SECRET = SECRET;
});

/**
 * 观测日志写入是 fire-and-forget（server.ts 中 `void clonedReq.json().then(...)`），
 * app.request() resolve 时不保证日志已经落盘。轮询直到文件出现或超时，
 * 避免用固定 sleep 赌时间导致 CI 偶发失败。
 */
async function waitForFileContent(path: string, timeoutMs = 2000, intervalMs = 20): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`等待观测日志写入超时（${timeoutMs}ms 内未出现）：${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/**
 * 同上是轮询而非固定 sleep，但等待的是「至少 N 行」而不是「文件存在」——
 * 用于一个用例里连续发两次 tools/call 的场景：文件在第一次写入后就已存在，
 * 若只等「存在」，第二次的 fire-and-forget 写入可能还没落盘就被读到。
 */
async function waitForLineCount(path: string, count: number, timeoutMs = 2000, intervalMs = 20): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let lines: string[] = [];
    try {
      lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (lines.length >= count) return lines;
    if (Date.now() >= deadline) {
      throw new Error(`等待观测日志写满 ${count} 行超时（${timeoutMs}ms 内只有 ${lines.length} 行）：${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

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
    const body = parseMcpJsonRpcResponse(text) as { result?: { tools?: Array<{ name: string }> } };
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toHaveLength(9);
    expect(new Set(names)).toEqual(
      new Set([
        "grande_task_open",
        "grande_task_status",
        "grande_repo_map",
        "grande_repo_search",
        "grande_repo_read",
        "grande_repo_edit",
        "grande_diff",
        "grande_run",
        "grande_run_result",
      ]),
    );
  });
});

describe("响应信封序列化（I3 修复）", () => {
  /**
   * 这里刻意走真实 HTTP 往返（而不是 tools.test.ts 里的 InMemoryTransport），
   * 因为"序列化后的键序"这个断言只有在真的过了一次 JSON.stringify/JSON.parse
   * 之后才有意义——JSON.parse 按 ECMAScript 规范重建对象时，字符串键按它们在
   * 源文本里出现的先后顺序插入，所以 Object.keys() 的顺序如实反映了线上字节序。
   */
  it("data 体积很大时，truncated/nextCursor/hint 仍排在 data 之前——即使响应被从尾部截断也不会丢失这些信号字段", async () => {
    const app = createApp();
    await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });

    const openRes = await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "grande_task_open", arguments: { goal: "g" } },
      }),
    });
    const openBody = parseMcpJsonRpcResponse(await openRes.text()) as {
      result: { structuredContent: { taskId: string } };
    };
    const taskId = openBody.result.structuredContent.taskId;

    const readRes = await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "grande_repo_read", arguments: { taskId, path: "src/big-config.ts" } },
      }),
    });
    const text = await readRes.text();
    const parsed = parseMcpJsonRpcResponse(text) as {
      result: { content: Array<{ text?: string }>; structuredContent: Record<string, unknown> };
    };

    const structured = parsed.result.structuredContent;
    expect((structured as { truncated: boolean }).truncated).toBe(true); // 前提：这次读取确实触发了截断

    const keys = Object.keys(structured);
    const truncatedIdx = keys.indexOf("truncated");
    const nextCursorIdx = keys.indexOf("nextCursor");
    const hintIdx = keys.indexOf("hint");
    const dataIdx = keys.indexOf("data");
    expect(truncatedIdx).toBeGreaterThanOrEqual(0);
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(truncatedIdx).toBeLessThan(dataIdx);
    expect(nextCursorIdx).toBeLessThan(dataIdx);
    expect(hintIdx).toBeLessThan(dataIdx);

    // content[0].text 不再是 structuredContent 的完整重复：真正的大段 data 内容
    // 不应该在这段摘要文本里再出现一遍。
    const bigContentSample = (structured as { data: { content: string } }).data.content.slice(0, 200);
    expect(parsed.result.content[0]?.text ?? "").not.toContain(bigContentSample);
  });
});

describe("观测日志", () => {
  let logPath: string;

  beforeEach(() => {
    // 落在 os.tmpdir() 下，绝不写进仓库工作区；每个用例一个独立文件名，互不干扰。
    logPath = join(tmpdir(), `grande-observe-test-${randomUUID()}.jsonl`);
    process.env.POC_LOG = logPath;
  });

  afterEach(() => {
    rmSync(logPath, { force: true });
    delete process.env.POC_LOG;
  });

  async function initialize(app: ReturnType<typeof createApp>): Promise<void> {
    await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    });
  }

  it("tools/call 请求会写入一行观测日志，字段与请求一致", async () => {
    const app = createApp();
    await initialize(app);

    const args = { goal: "写一个测试" };
    const res = await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "grande_task_open", arguments: args },
      }),
    });
    expect(res.status).toBe(200);

    const raw = await waitForFileContent(logPath);
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]!);
    expect(event.kind).toBe("tool_call");
    expect(event.tool).toBe("grande_task_open");
    expect(event.repoId).toBe("demo-app");
    expect(event.args).toEqual(args);
  });

  it("非 tools/call 请求（如 tools/list）不写入观测日志", async () => {
    const app = createApp();
    await initialize(app);

    // 不该被记录的请求。
    const listRes = await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listRes.status).toBe(200);

    // 哨兵请求：一定会被记录的 tools/call。日志写入是 fire-and-forget，没法直接
    // 等待"什么都没发生"；用它代替固定时长的 sleep —— 上面 tools/list 触发的
    // .then() 链在事件循环里排在这次请求之前入队，一旦轮询等到哨兵这一行落盘，
    // 前面那条更早入队的链必然已经跑完（Node 在进入下一个宏任务前会清空微任务
    // 队列）。届时日志里若只有这一行，就证明 tools/list 没有额外写入。
    const callRes = await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "grande_task_open", arguments: { goal: "sentinel" } },
      }),
    });
    expect(callRes.status).toBe(200);

    const raw = await waitForFileContent(logPath);
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).tool).toBe("grande_task_open");
  });

  it("grande_run 调用记录的日志行带有响应摘要，jobId 非空（根治 I1：日志此前只记参数不记响应）", async () => {
    const app = createApp();
    await initialize(app);

    const openRes = await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "grande_task_open", arguments: { goal: "写一个测试" } },
      }),
    });
    const openBody = parseMcpJsonRpcResponse(await openRes.text()) as {
      result?: { structuredContent?: { taskId?: unknown } };
    };
    const taskId = openBody.result?.structuredContent?.taskId;
    expect(typeof taskId).toBe("string");
    await waitForFileContent(logPath); // 确保 grande_task_open 这一行先落盘，再发下一个请求

    const runRes = await app.request(`/${SECRET}/mcp/demo-app`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "grande_run", arguments: { taskId, profile: "unit" } },
      }),
    });
    expect(runRes.status).toBe(200);

    const lines = await waitForLineCount(logPath, 2);
    expect(lines).toHaveLength(2);

    const openEvent = JSON.parse(lines[0]!);
    expect(openEvent.tool).toBe("grande_task_open");
    // jobId 只对 grande_run 有意义，其它工具即便响应里出现类似字段也不应被提取。
    expect(openEvent.result.jobId).toBeNull();

    const runEvent = JSON.parse(lines[1]!);
    expect(runEvent.tool).toBe("grande_run");
    expect(runEvent.result).toMatchObject({ isError: false, ok: true, errorCode: null });
    expect(typeof runEvent.result.jobId).toBe("string");
    expect(runEvent.result.jobId).toMatch(/^job_/);
  });
});
