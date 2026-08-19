import type { DatabaseSync } from "node:sqlite";
import { createOAuth } from "./oauth.ts";

/**
 * 客户端视角自检（遗留 #4 下半）。
 *
 * 先走真实 HTTP tools/list，再通过现有只读 grande_task_status 做一次 tools/call，
 * 读取【运行中 Gateway 自己】报告的 build / toolset identity。这样不会把本地 CLI
 * 版本误当成 server identity，也不需要新增 MCP tool。
 */

export interface SelfCheckResult {
  url: string;
  httpStatus: number;
  /** tools/list 响应体字节数。POC 实测 ~73,896 字节仍能被 ChatGPT 完整接收。 */
  bytes: number;
  gatewayBuild: string | null;
  toolsetEpoch: number | null;
  toolsCount: number;
  toolsDigest: string | null;
  identityError?: string;
  tools: {
    name: string;
    readOnly: boolean;
    destructive: boolean;
    openWorld: boolean;
    requiredParams: string[];
  }[];
}

interface ToolFromWire {
  name?: unknown;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown };
  inputSchema?: { required?: unknown };
}

interface ServerIdentity {
  gatewayBuild: string;
  toolsetEpoch: number;
  toolsCount: number;
  toolsDigest: string;
}

/**
 * StreamableHTTP 的 POST 响应可能是 application/json，也可能是 text/event-stream。
 */
function extractJsonRpc(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  if (data === "") throw new Error(`响应既不是 JSON 也不含 SSE data 帧：${trimmed.slice(0, 200)}`);
  return JSON.parse(data);
}

function parseServerIdentity(body: string): ServerIdentity | null {
  const rpc = extractJsonRpc(body) as {
    result?: { structuredContent?: { ok?: unknown; data?: Record<string, unknown> } };
  };
  const data = rpc.result?.structuredContent?.data;
  if (rpc.result?.structuredContent?.ok !== true || !data) return null;
  if (
    typeof data.gatewayBuild !== "string" ||
    typeof data.toolsetEpoch !== "number" ||
    typeof data.toolsCount !== "number" ||
    typeof data.toolsDigest !== "string"
  ) return null;
  return {
    gatewayBuild: data.gatewayBuild,
    toolsetEpoch: data.toolsetEpoch,
    toolsCount: data.toolsCount,
    toolsDigest: data.toolsDigest,
  };
}

async function postRpc(
  url: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; body: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

/**
 * 向【正在运行的】网关问一次 tools/list，随后通过现有 grande_task_status 读取
 * server-side toolset identity。token 只在本进程内传给 fetch，绝不打印、绝不写盘。
 */
export async function selfCheck(
  opts: { issuer: string; db: DatabaseSync; keyPath: string; baseUrl: string },
): Promise<SelfCheckResult> {
  const endpointFor = () => `${opts.issuer}/mcp`;
  const oauth = createOAuth({
    issuer: opts.issuer,
    endpointFor,
    keyPath: opts.keyPath,
    db: opts.db,
  });
  const token = await oauth.mintSelfCheckToken();
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/mcp`;

  const listed = await postRpc(url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const bytes = Buffer.byteLength(listed.body, "utf8");
  if (!listed.ok) {
    return {
      url,
      httpStatus: listed.status,
      bytes,
      gatewayBuild: null,
      toolsetEpoch: null,
      toolsCount: 0,
      toolsDigest: null,
      tools: [],
    };
  }

  const rpc = extractJsonRpc(listed.body) as { result?: { tools?: ToolFromWire[] } };
  const wire = rpc.result?.tools ?? [];
  const tools = wire.map((t) => ({
    name: String(t.name ?? "?"),
    readOnly: t.annotations?.readOnlyHint === true,
    destructive: t.annotations?.destructiveHint === true,
    openWorld: t.annotations?.openWorldHint === true,
    requiredParams: Array.isArray(t.inputSchema?.required)
      ? (t.inputSchema.required as unknown[]).map(String)
      : [],
  }));

  let identity: ServerIdentity | null = null;
  let identityError: string | undefined;
  try {
    const status = await postRpc(url, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "grande_task_status", arguments: {} },
    });
    if (!status.ok) {
      identityError = `grande_task_status HTTP ${status.status}`;
    } else {
      identity = parseServerIdentity(status.body);
      if (!identity) identityError = "grande_task_status 未返回完整 toolset identity";
    }
  } catch (error) {
    identityError = error instanceof Error ? error.message : String(error);
  }

  if (identity && identity.toolsCount !== tools.length) {
    identityError = `server identity toolsCount=${identity.toolsCount}，但 tools/list 实际返回 ${tools.length}`;
  }

  return {
    url,
    httpStatus: listed.status,
    bytes,
    gatewayBuild: identity?.gatewayBuild ?? null,
    toolsetEpoch: identity?.toolsetEpoch ?? null,
    toolsCount: identity?.toolsCount ?? tools.length,
    toolsDigest: identity?.toolsDigest ?? null,
    ...(identityError ? { identityError } : {}),
    tools,
  };
}

/** 把自检结果渲染成人能一眼比对的表。 */
export function renderSelfCheck(r: SelfCheckResult): string[] {
  const out: string[] = [];
  out.push(`端点    ${r.url}`);
  out.push(`HTTP    ${r.httpStatus}`);
  out.push(`响应    ${r.bytes} 字节（POC 实测 ~73,896 字节仍能被 ChatGPT 完整接收）`);
  out.push("");

  if (r.httpStatus === 401) {
    out.push("401 —— 自签 token 没通过校验。可能原因：");
    out.push("  · 刚跑过 grande revoke --yes（epoch 已递增）——这是【正确】行为，");
    out.push("    真实客户端此刻同样被拒，需要重新走一次授权");
    out.push("  · GRANDE_ISSUER 与网关启动时用的不是同一个值（aud 对不上）");
    return out;
  }
  if (r.httpStatus !== 200) {
    out.push(`非 200，无法读取工具表。先看网关日志的 [gw] 与 [rpc] 两行。`);
    return out;
  }

  out.push("Server toolset identity");
  out.push(`  gatewayBuild  ${r.gatewayBuild ?? "（不可用）"}`);
  out.push(`  toolsetEpoch  ${r.toolsetEpoch ?? "（不可用）"}`);
  out.push(`  toolsCount    ${r.toolsCount}`);
  out.push(`  toolsDigest   ${r.toolsDigest ?? "（不可用）"}`);
  if (r.identityError) out.push(`  ⚠ identity     ${r.identityError}`);
  out.push("ChatGPT session binding  ? server-side 无法直接验证；需在新聊天执行 read probe 验证当前 binding");
  out.push("");

  const ro = r.tools.filter((t) => t.readOnly);
  const rw = r.tools.filter((t) => !t.readOnly);
  out.push(`工具    ${r.tools.length} 个：${ro.length} 只读 / ${rw.length} 写`);
  out.push("");
  out.push("⚠️ ChatGPT 在「Allow low-risk actions」档下【拒绝调用】readOnlyHint: false 的");
  out.push("   工具——症状是「能列出、调不动」，且服务端日志里连请求都没有。");
  out.push("   要用写工具必须把连接器权限改成「Allow all actions」。");
  out.push("");

  const row = (t: SelfCheckResult["tools"][number]): string => {
    const flags = [
      t.readOnly ? "只读" : "写  ",
      t.destructive ? "破坏性" : "      ",
      t.openWorld ? "触网" : "    ",
    ].join(" ");
    const req = t.requiredParams.length > 0 ? `必填: ${t.requiredParams.join(",")}` : "无必填参数";
    return `  ${t.name.padEnd(22)} ${flags}  ${req}`;
  };

  out.push(`只读工具（低风险档下可用）：`);
  for (const t of ro) out.push(row(t));
  out.push("");
  out.push(`写工具（低风险档下会被客户端拒绝调用）：`);
  for (const t of rw) out.push(row(t));

  const network = r.tools.filter((t) => t.openWorld);
  const destructive = r.tools.filter((t) => t.destructive);
  out.push("");
  out.push(`触网工具  ${network.length > 0 ? network.map((t) => t.name).join("、") : "（无）"}`);
  out.push(`破坏性工具 ${destructive.length > 0 ? destructive.map((t) => t.name).join("、") : "（无）"}`);
  return out;
}
