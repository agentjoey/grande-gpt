import { describe, expect, it } from "vitest";
import { toMcpTextResult } from "../src/mcpToolResult.ts";

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
  });
});
