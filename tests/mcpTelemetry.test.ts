import { describe, expect, it } from "vitest";
import { jsonByteLength, requestCorrelation } from "../src/mcpTelemetry.ts";

describe("MCP call telemetry helpers", () => {
  it("measures the UTF-8 bytes of the JSON representation", () => {
    // Removing UTF-8 encoding would incorrectly count this emoji as one character.
    expect(jsonByteLength("🍜")).toBe(6);
  });

  it("derives a stable short correlation from only the MCP session id", () => {
    const headers = new Headers({ "Mcp-Session-Id": "mcp-session-id-unique" });

    expect(requestCorrelation(headers)).toBe("mcp:927d10d7f55c");
    expect(requestCorrelation(headers)).toBe("mcp:927d10d7f55c");
  });

  it("uses none when the MCP session id is absent", () => {
    expect(requestCorrelation(new Headers())).toBe("none");
  });

  it("does not derive correlation from bearer or request-body markers", () => {
    const bearerMarker = "BEARER_MARKER_MUST_NOT_BE_HASHED";
    const fileContentMarker = "FILE_CONTENT_MARKER_MUST_NOT_BE_HASHED";
    const request = new Request("https://grande.example.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerMarker}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: fileContentMarker }),
    });

    const correlation = requestCorrelation(request.headers);
    expect(correlation).toBe("none");
    expect(correlation).not.toContain(bearerMarker);
    expect(correlation).not.toContain(fileContentMarker);
  });
});
