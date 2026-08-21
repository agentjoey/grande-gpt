export function toMcpTextResult(envelope: unknown): {
  content: [{ type: "text"; text: string }];
} {
  const text = JSON.stringify(envelope);
  if (text === undefined) {
    throw new TypeError("MCP tool result envelope is not JSON-serializable");
  }
  return { content: [{ type: "text", text }] };
}
