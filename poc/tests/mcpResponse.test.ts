import { describe, expect, it } from "vitest";
import { extractObserveResult, parseMcpJsonRpcResponse } from "../src/mcpResponse.ts";

/** 构造一个 tools/call 的 JSON-RPC 成功响应，结构信封放在 result.structuredContent。 */
function rpcResult(structuredContent: Record<string, unknown>): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  };
}

/** 构造一个 MCP 协议级拒绝响应：zod 校验在 handler 运行前就失败，没有 structuredContent。 */
function rpcSchemaRejection(): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { isError: true, content: [{ type: "text", text: "Invalid arguments" }] },
  };
}

describe("parseMcpJsonRpcResponse()", () => {
  it("解析纯 JSON 响应", () => {
    expect(parseMcpJsonRpcResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it("解析 SSE 帧响应（data: 行）", () => {
    expect(parseMcpJsonRpcResponse('event: message\ndata: {"a":1}\n\n')).toEqual({ a: 1 });
  });

  it("既不是 JSON 也没有 data 行时抛出异常", () => {
    expect(() => parseMcpJsonRpcResponse("not json at all")).toThrow();
  });
});

describe("extractObserveResult() — state 字段（C1 修复）", () => {
  it("grande_run_result 的响应里 state 为 running 时被提取", () => {
    const r = extractObserveResult(
      rpcResult({ ok: true, taskId: "t", data: { jobId: "job_a", state: "running" }, truncated: false, nextCursor: null, hint: "h", taskContext: null }),
      "grande_run_result",
    );
    expect(r.state).toBe("running");
  });

  it("grande_run_result 的响应里 state 为 passed 时被提取", () => {
    const r = extractObserveResult(
      rpcResult({ ok: true, taskId: "t", data: { jobId: "job_a", state: "passed" }, truncated: false, nextCursor: null, hint: "h", taskContext: null }),
      "grande_run_result",
    );
    expect(r.state).toBe("passed");
  });

  it("grande_run 的响应里即便 data.state 也存在（恒为字面量 running），也不提取——state 只对 grande_run_result 有意义", () => {
    const r = extractObserveResult(
      rpcResult({ ok: true, taskId: "t", data: { jobId: "job_a", state: "running" }, truncated: false, nextCursor: null, hint: "h", taskContext: null }),
      "grande_run",
    );
    expect(r.state).toBeNull();
    expect(r.jobId).toBe("job_a"); // jobId 仍然只在 grande_run 时提取，两者互不影响
  });

  it("其它工具（例如 grande_repo_read）的响应不提取 state", () => {
    const r = extractObserveResult(
      rpcResult({ ok: true, taskId: "t", data: { path: "a" }, truncated: false, nextCursor: null, hint: "h", taskContext: null }),
      "grande_repo_read",
    );
    expect(r.state).toBeNull();
  });

  it("MCP 协议级 schema 拒绝（isError:true，没有 structuredContent）时 state 为 null，不崩溃", () => {
    const r = extractObserveResult(rpcSchemaRejection(), "grande_run_result");
    expect(r.isError).toBe(true);
    expect(r.state).toBeNull();
    expect(r.ok).toBeNull();
  });

  it("错误信封（ok:false）时 state 为 null", () => {
    const r = extractObserveResult(
      rpcResult({ ok: false, taskId: "t", error: { code: "INVALID_INPUT", message: "bad jobId", retryable: false, details: {} } }),
      "grande_run_result",
    );
    expect(r.state).toBeNull();
  });
});
