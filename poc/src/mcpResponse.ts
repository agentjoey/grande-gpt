import type { ObserveResult } from "./observe.ts";

/**
 * MCP 端点的响应可能是纯 JSON，也可能是 SSE 帧（`event: message\ndata: {...}`），
 * 取决于 SDK 内部选择。两种都尝试解析。
 *
 * 原本重复定义在 poc/tests/server.test.ts 里；现在这是唯一实现，server.ts 的
 * 观测日志路径和测试都从这里导入。
 */
export function parseMcpJsonRpcResponse(text: string): unknown {
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * 从已解析的 JSON-RPC 响应中提取观测摘要。
 *
 * 信封（envelope.ts 的 Envelope/ErrorEnvelope）位于 `result.structuredContent`。
 * MCP 协议级失败（例如 zod 校验在 handler 运行前就拒绝了参数）体现为
 * `result.isError === true` 且没有 structuredContent —— 这种情况下信封相关字段
 * 全部返回 null，不是崩溃。
 *
 * jobId 只在 toolName 是 "grande_run" 时提取：grande_run_result 的 jobId 已经
 * 在请求参数（args.jobId）里，不需要从响应里再取一份。
 */
export function extractObserveResult(parsed: unknown, toolName: string): ObserveResult {
  const result = isRecord(parsed) && isRecord(parsed.result) ? parsed.result : undefined;
  const isError = result?.isError === true;
  const envelope = result && isRecord(result.structuredContent) ? result.structuredContent : undefined;

  const ok = typeof envelope?.ok === "boolean" ? envelope.ok : null;

  const errorCode =
    envelope?.ok === false && isRecord(envelope.error) && typeof envelope.error.code === "string"
      ? envelope.error.code
      : null;

  const truncated = typeof envelope?.truncated === "boolean" ? envelope.truncated : null;

  const jobId =
    toolName === "grande_run" &&
    envelope?.ok === true &&
    isRecord(envelope.data) &&
    typeof envelope.data.jobId === "string"
      ? envelope.data.jobId
      : null;

  return { isError, ok, errorCode, truncated, jobId };
}
