import { createHash } from "node:crypto";

export interface McpCallMetrics {
  correlation: string;
  inputBytes: number;
  outputBytes: number | "unknown";
}

/** Returns the UTF-8 size of a value's JSON representation. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/**
 * Produces a log-safe correlation value from the MCP session header alone.
 * Authentication is intentionally unrelated: bearer credentials must never be
 * read, hashed, or written by telemetry.
 */
export function requestCorrelation(headers: Headers): string {
  const sessionId = headers.get("mcp-session-id");
  if (sessionId === null) return "none";
  return `mcp:${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
}
