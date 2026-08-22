import { err } from "./envelope.ts";
import { assertTaskId } from "./paths.ts";

export const MAX_MCP_TOOL_RESULT_BYTES = 32 * 1024;

export interface McpTextResult {
  [key: string]: unknown;
  content: [{ type: "text"; text: string }];
}

/** Measures the complete MCP result object exactly as it is returned by GrandeGPT. */
export function mcpToolResultByteLength(result: McpTextResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function availableTaskId(envelope: unknown): string | null {
  if (typeof envelope !== "object" || envelope === null || !("taskId" in envelope)) return null;
  const taskId = (envelope as { taskId?: unknown }).taskId;
  if (taskId === null) return null;
  if (typeof taskId !== "string") return null;
  try {
    assertTaskId(taskId);
    return taskId;
  } catch {
    // Invalid caller data is not an available canonical task id and must not be
    // copied into the compact fallback where it could defeat the hard cap.
    return null;
  }
}

function encodeTextEnvelope(envelope: unknown): McpTextResult {
  const text = JSON.stringify(envelope);
  if (text === undefined) {
    throw new TypeError("MCP tool result envelope is not JSON-serializable");
  }
  return { content: [{ type: "text", text }] };
}

export function toMcpTextResult(envelope: unknown): McpTextResult {
  const result = encodeTextEnvelope(envelope);
  if (mcpToolResultByteLength(result) <= MAX_MCP_TOOL_RESULT_BYTES) return result;

  const fallback = encodeTextEnvelope(err({
    taskId: availableTaskId(envelope),
    code: "RESOURCE_EXHAUSTED",
    message: `GrandeGPT result exceeded the ${MAX_MCP_TOOL_RESULT_BYTES}-byte delivered MCP result limit. ` +
      "Request a smaller page or line range.",
    retryable: true,
    details: { maxOutputBytes: MAX_MCP_TOOL_RESULT_BYTES },
  }));
  if (mcpToolResultByteLength(fallback) > MAX_MCP_TOOL_RESULT_BYTES) {
    throw new TypeError("Canonical MCP output-budget error exceeded its own hard cap");
  }
  return fallback;
}
