export interface TaskContext {
  branch: string;
  filesChanged: number;
  lastJob: string | null;
}

export interface Envelope<T> {
  ok: true;
  taskId: string | null;
  data: T;
  truncated: boolean;
  nextCursor: string | null;
  hint: string;
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
    data: args.data,
    truncated: args.truncated ?? false,
    nextCursor: args.nextCursor ?? null,
    hint: args.hint,
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

export function truncateList<T>(
  items: T[],
  max: number,
): { items: T[]; truncated: boolean; nextCursor: string | null } {
  if (items.length <= max) return { items, truncated: false, nextCursor: null };
  return { items: items.slice(0, max), truncated: true, nextCursor: String(max) };
}
