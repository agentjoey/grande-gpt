import type { DatabaseSync } from "node:sqlite";
import { createOAuth } from "./oauth.ts";

/**
 * 客户端视角自检（遗留 #4 下半）。
 *
 * ## 它要回答的问题
 *
 * 2026-07-29 那次故障：模型能**列出** `grande_task_open` 却调不动，报
 * `Resource not found`，而服务端日志里连一条请求都没有。排查绕了三个错误假设
 * 才找到根因（ChatGPT 在 `Allow low-risk actions` 档下拒绝调用
 * `readOnlyHint: false` 的工具）。
 *
 * 当时真正起作用的那一步，是**用库里的签名密钥自签一枚 token，直接问服务端
 * `tools/list`，然后比对能用与不能用两组工具的结构差异**——一比就发现除
 * `readOnlyHint` 外完全相同，变量瞬间隔离到只剩一个。
 *
 * 那一步是临时手搓的。这个模块把它固化下来：**排查时不该现想招**。
 *
 * ## 为什么必须走真实的网络路径
 *
 * 直接 `buildTools()` 打印一遍是没有意义的——那是「我们以为客户端看到什么」，
 * 不是「客户端实际看到什么」。中间隔着 bearer 校验、epoch 检查、MCP 的
 * 序列化与 zod schema 转换，任何一层出问题都会让两者分叉，而分叉恰恰是
 * 我们要找的东西。所以自检必须：真的起 HTTP 请求、真的带 Authorization、
 * 真的解析回来的 JSON-RPC 响应。
 *
 * ⚠️ **它需要网关正在跑。** 网关没起时说清楚，不要退化成本地推断——
 * 那会把「连不上」伪装成「一切正常」。
 */

export interface SelfCheckResult {
  url: string;
  httpStatus: number;
  /** 响应体字节数。POC 实测 ~73,896 字节仍能被 ChatGPT 完整接收。 */
  bytes: number;
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

/**
 * StreamableHTTP 的 POST 响应可能是 `application/json`，也可能是
 * `text/event-stream`（同一个 JSON-RPC 结果包在 SSE 帧里）。两种都要认——
 * 只认前者的话，SDK 换个协商结果就静默失效，而失效的表现是「自检说没有工具」，
 * 那比没有自检更糟。
 */
function extractJsonRpc(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  // SSE：逐行取 `data:` 后面的内容，拼起来再解析。
  const data = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("");
  if (data === "") throw new Error(`响应既不是 JSON 也不含 SSE data 帧：${trimmed.slice(0, 200)}`);
  return JSON.parse(data);
}

/**
 * 向【正在运行的】网关问一次 `tools/list`，返回客户端视角的事实。
 *
 * `db` 必须是已经 `openDb()` 过的连接——epoch 从它读，这样
 * `grande revoke --yes` 之后自检会和真实客户端一样被拒（那是正确行为，
 * 不是 bug；输出会明说这一点）。
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

  // ⚠️ 这枚 token 只在本进程内传给 fetch，**绝不打印、绝不写盘**。
  // 一枚有效 bearer 落进终端回滚区，等于把「只有本机能做」变成
  // 「谁看过这块屏幕都能做」。60 秒过期，见 oauth.ts 的 mintSelfCheckToken。
  const token = await oauth.mintSelfCheckToken();

  const url = `${opts.baseUrl.replace(/\/+$/, "")}/mcp`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // 两种都接受——让服务端按它自己的偏好协商，自检才反映真实行为。
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  const body = await res.text();
  const bytes = Buffer.byteLength(body, "utf8");
  if (!res.ok) return { url, httpStatus: res.status, bytes, tools: [] };

  const rpc = extractJsonRpc(body) as { result?: { tools?: ToolFromWire[] } };
  const wire = rpc.result?.tools ?? [];

  return {
    url,
    httpStatus: res.status,
    bytes,
    tools: wire.map((t) => ({
      name: String(t.name ?? "?"),
      // 注解缺失时按 false 记——**不要写成「未知」再在渲染层猜**。
      // MCP 规范下缺失即 false，而客户端也是这么解读的。
      readOnly: t.annotations?.readOnlyHint === true,
      destructive: t.annotations?.destructiveHint === true,
      openWorld: t.annotations?.openWorldHint === true,
      requiredParams: Array.isArray(t.inputSchema?.required)
        ? (t.inputSchema.required as unknown[]).map(String)
        : [],
    })),
  };
}

/** 把自检结果渲染成人能一眼比对的表。**分组按 readOnlyHint**——那是 2026-07-29 的变量。 */
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
