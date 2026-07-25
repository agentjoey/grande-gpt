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
