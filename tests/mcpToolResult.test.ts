import { describe, expect, it } from "vitest";
import {
  MAX_MCP_TOOL_RESULT_BYTES,
  mcpToolResultByteLength,
  toMcpTextResult,
} from "../src/mcpToolResult.ts";

describe("toMcpTextResult", () => {
  it("serializes one logical envelope into exactly one canonical text block", () => {
    const marker = "MCP_TEXT_RESULT_UNIQUE_NESTED_MARKER";
    const envelope = {
      ok: true,
      data: { nested: { marker, values: [1, 2, 3] } },
      hint: "continue",
    };

    const result = toMcpTextResult(envelope);

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(envelope) }],
    });
    expect(result).not.toHaveProperty("structuredContent");
    expect(JSON.stringify(result).split(marker)).toHaveLength(2);
    expect(JSON.parse(result.content[0].text)).toEqual(envelope);
    expect(mcpToolResultByteLength(result)).toBe(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    );
  });

  it("replaces an oversized escape-heavy envelope with a compact canonical error and preserves a valid taskId", () => {
    const marker = "OVERSIZED_ORIGINAL_RESULT_MARKER";
    const envelope = {
      ok: true,
      taskId: "task_wire_budget",
      data: { marker, content: String.fromCharCode(92, 34).repeat(12_000) },
      hint: "",
    };

    const result = toMcpTextResult(envelope);
    const deliveredBytes = mcpToolResultByteLength(result);
    const deliveredEnvelope = JSON.parse(result.content[0].text) as {
      ok: boolean;
      taskId: string | null;
      error: { code: string; message: string; retryable: boolean };
    };

    expect(deliveredBytes).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
    expect(deliveredBytes).toBeLessThanOrEqual(MAX_MCP_TOOL_RESULT_BYTES);
    expect(deliveredEnvelope).toMatchObject({
      ok: false,
      taskId: "task_wire_budget",
      error: { code: "RESOURCE_EXHAUSTED", retryable: true },
    });
    expect(deliveredEnvelope.error.message).toMatch(/smaller (?:page|line range)/i);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result).not.toHaveProperty("structuredContent");
  });
});
