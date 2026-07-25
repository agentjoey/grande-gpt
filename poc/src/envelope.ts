export interface TaskContext {
  branch: string;
  filesChanged: number;
  lastJob: string | null;
}

export interface Envelope<T> {
  ok: true;
  taskId: string | null;
  // truncated / nextCursor / hint 声明在 data 之前，对应 ok() 里实际的构造顺序
  // （从而也是 JSON.stringify 的键序）——见 ok() 内的注释（I3 修复）。
  truncated: boolean;
  nextCursor: string | null;
  hint: string;
  data: T;
  taskContext: TaskContext | null;
}

export interface ErrorEnvelope {
  ok: false;
  taskId: string | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export function ok<T>(args: {
  taskId?: string | null;
  data: T;
  hint: string;
  truncated?: boolean;
  nextCursor?: string | null;
  taskContext?: TaskContext | null;
}): Envelope<T> {
  return {
    ok: true,
    taskId: args.taskId ?? null,
    // I3 修复：truncated / nextCursor / hint 排在 data 前面构造，而不是按参数
    // 声明的顺序。JSON.stringify 按对象属性的插入顺序输出键；data 可能有几十
    // KB（例如 grande_repo_read 截断到 65536 字节上限），如果 ChatGPT 侧对
    // 响应做静默截断（项目自己的调研已经记录了这一点），排在 data 之后的
    // truncated/nextCursor/hint 就可能落在永远看不到的那部分文本里——这几个
    // 字段恰恰是模型判断"要不要继续读/搜"的唯一依据，必须排在前面。
    truncated: args.truncated ?? false,
    nextCursor: args.nextCursor ?? null,
    hint: args.hint,
    data: args.data,
    taskContext: args.taskContext ?? null,
  };
}

export function err(args: {
  taskId?: string | null;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}): ErrorEnvelope {
  return {
    ok: false,
    taskId: args.taskId ?? null,
    error: {
      code: args.code,
      message: args.message,
      retryable: args.retryable ?? false,
      details: args.details ?? {},
    },
  };
}

/**
 * 按 UTF-8 字节数截断，且不切断多字节字符。
 * ChatGPT 侧按 token 截断且不告知；我们主动截断并显式标记（规格 §5.4）。
 *
 * 回退原理：UTF-8 的 continuation byte 形如 `10xxxxxx`。若截断点落在
 * continuation byte 上，说明正处于某个多字节字符中间，向前回退到该字符起始处。
 * 例：「中文中文」取 5 字节 → buf[5]=0x87 与 buf[4]=0x96 均为 continuation，
 * 回退至 end=3（buf[3]=0xE6 是「文」的首字节）→ 得到「中」。
 */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };

  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--;

  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * 分页取一批 items，可选从 offset 开始（C2 修复）。offset 默认 0，此时首页行为
 * 与旧签名完全一致：未超限时 `nextCursor: null`，超限时截断到 `max` 条并给出
 * `nextCursor: String(max)`。
 *
 * cursor 此前只是摆设：grande_repo_search/grande_diff 的 hint 让模型带
 * `cursor=${nextCursor}` 再次调用，但两个工具的 inputSchema 都不接受 cursor
 * 参数——zod 会静默剥离这个未声明的字段，模型的第二次调用其实和第一次一模
 * 一样，拿到字节相同的结果，却把这当成"翻页成功"继续读下去。offset 让续读
 * 真正返回下一页，而不是让 cursor 停留在"看起来像回事"的摆设状态。
 */
export function truncateList<T>(
  items: T[],
  max: number,
  offset = 0,
): { items: T[]; truncated: boolean; nextCursor: string | null } {
  const page = items.slice(offset, offset + max);
  const truncated = offset + page.length < items.length;
  return {
    items: page,
    truncated,
    nextCursor: truncated ? String(offset + page.length) : null,
  };
}
