import type { ToolDef } from "./toolsCore.ts";

/**
 * 工具入参的**前置校验**。
 *
 * ## 为什么需要
 *
 * 每个工具都在 `inputSchema` 里声明了 `properties` 与 `required`，
 * **而在此之前没有任何地方执行它**。handler 直接 `args.ops as EditOp[]`，
 * 把 `undefined` 强转过去，下游某处抛一个 `TypeError`——那不是我们自己的错误类，
 * 于是落进 `toToolError` 的兜底，模型收到：
 *
 * ```
 * {"code":"INTERNAL","message":"Gateway 内部错误。详情见服务端日志。"}
 * ```
 *
 * **模型看不到服务端日志。** 它只知道「内部错误」，不知道是自己把 `ops` 写成了
 * `edits`。我自己就撞过这个——写 S3 验证脚本时参数名写错，对着这条消息毫无头绪，
 * 直到去翻工具的 schema 才发现。这是遗留表 #13。
 *
 * ## 兜底本身是对的，不要削弱它
 *
 * `INTERNAL` 存在的意义是**不让未知异常泄漏内部细节**。修法不是让它更啰嗦，
 * 而是让「参数不对」这类**可预期的错误根本走不到兜底**。
 *
 * ## 只做浅层检查
 *
 * 不做完整 JSON Schema 校验：`grande_repo_edit` 的 `ops` 是个带 `oneOf` 的数组，
 * 真要全量校验得引入一个 schema 库，而**深层结构的错误由领域函数报得更准**
 * （`EditError` 会说清是哪个 op 的哪个字段）。这里只挡三类最常见、
 * 且当前会退化成 INTERNAL 的错误：缺必填、多余字段、顶层类型不符。
 */

export class ArgError extends Error {
  readonly code = "INVALID_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "ArgError [INVALID_INPUT]";
  }
}

/** JSON Schema 的 `type` 到 JS 运行时类型的映射，只覆盖我们实际用到的几种。 */
function typeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/**
 * 校验一次工具调用的入参。不合法时抛 `ArgError`（→ `INVALID_INPUT`）。
 *
 * **点名字段**——「缺少必填参数 ops」比「参数不合法」有用得多，
 * 而对模型来说，能不能自我修正全看这一句说没说清楚。
 */
export function checkArgs(tool: ToolDef, args: Record<string, unknown>): void {
  const schema = tool.inputSchema;
  const declared = Object.keys(schema.properties);

  /**
   * ⚠️ **三类问题一起报，不在第一条就 return。**
   *
   * 我第一版就是逐条 throw 的，结果 `{taskId, edits: []}` 只说「缺少必填参数 ops」
   * ——完全没提 `edits` 这个词。那对撞上 #13 的人毫无帮助：他看到的是自己传了
   * 一个数组却被告知「缺数组」，只会以为是格式不对，而**真正的信息是他把名字写错了**。
   *
   * 「缺 ops」+「不认识 edits」放在一起，拼写错误才自己浮出来。
   */
  const problems: string[] = [];

  // ① 缺必填
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
  if (missing.length > 0) problems.push(`缺少必填参数：${missing.join("、")}`);

  // ② 多余字段——拼写错误的另一半
  const unknown = Object.keys(args).filter((k) => !declared.includes(k));
  if (unknown.length > 0) problems.push(`不认识这些参数：${unknown.join("、")}`);

  // ③ 顶层类型不符
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v === undefined) continue;                       // 非必填且没给，正常
    const want = (spec as { type?: unknown }).type;
    if (typeof want !== "string") continue;              // 没声明 type 就不查
    const got = typeOf(v);
    // JSON Schema 的 integer/number 都对应 JS 的 number
    if (want === got || (want === "integer" && got === "number")) continue;
    problems.push(`参数 ${key} 类型不对：期望 ${want}，收到 ${got}`);
  }

  if (problems.length === 0) return;

  const hint = missing.length > 0 && unknown.length > 0 ? "（名字写错了？）" : "";
  // 全部参数都必填时不再重复一遍名单——那只是噪音，而模型的上下文是有限资源。
  const req = schema.required ?? [];
  const reqClause = req.length > 0 && req.length < declared.length
    ? `，其中必填：${req.join("、")}` : "";
  throw new ArgError(
    `${tool.name} 的入参不合法——${problems.join("；")}。${hint}` +
      `该工具接受的参数是：${declared.join("、")}${reqClause}。`,
  );
}
