import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.ts";

const SECRET = "test-secret";

beforeEach(() => {
  process.env.POC_SECRET = SECRET;
});

/**
 * MCP 端点的响应可能是纯 JSON，也可能是 SSE 帧（`event: message\ndata: {...}`），
 * 取决于 SDK 内部选择。两种都尝试解析。
 */
function parseMcpJsonRpcResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) {
      throw new Error(`无法解析 MCP 响应：既不是 JSON，也找不到 SSE data 行。原始内容：${text.slice(0, 200)}`);
    }
    return JSON.parse(dataLine.slice("data: ".length));
  }
}

/**
 * 观测日志写入是 fire-and-forget（server.ts 中 `void cloned.json().then(...)`），
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
});
