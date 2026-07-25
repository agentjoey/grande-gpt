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
      .then((raw: unknown) => {
        const body = raw as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
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
      .catch((error: unknown) => {
        if (error instanceof SyntaxError) return; // 非 JSON 请求体：预期内，静默
        console.error("[observe] 观测日志写入失败", error);
      });

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
