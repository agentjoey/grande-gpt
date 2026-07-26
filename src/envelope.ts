export interface TaskContext {
  branch: string;
  filesChanged: number;
  lastJob: string | null;
}

/**
 * 字段声明顺序 = `JSON.stringify` 的输出顺序，这里是**有意为之**：
 * `truncated` / `nextCursor` / `hint` 必须排在 `data` 前面。
 *
 * 理由（POC 实测）：ChatGPT 会静默截断超大响应。读大文件时 `data` 可达数十 KB，
 * 若这三个信号字段排在其后，模型可能永远看不到它们——而它们恰恰是模型判断
 * 「要不要继续读」的唯一依据。实测中 `truncated` 一度出现在第 73,896 字节。
 */
export interface Envelope<T> {
  ok: true;
  taskId: string | null;
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

export function ok<T>(a: {
  taskId?: string | null;
  data: T;
  hint: string;
  truncated?: boolean;
  nextCursor?: string | null;
  taskContext?: TaskContext | null;
}): Envelope<T> {
  return {
    ok: true,
    taskId: a.taskId ?? null,
    truncated: a.truncated ?? false,
    nextCursor: a.nextCursor ?? null,
    hint: a.hint,
    data: a.data,
    taskContext: a.taskContext ?? null,
  };
}

export function err(a: {
  taskId?: string | null;
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}): ErrorEnvelope {
  return {
    ok: false,
    taskId: a.taskId ?? null,
    error: {
      code: a.code,
      message: a.message,
      retryable: a.retryable ?? false,
      details: a.details ?? {},
    },
  };
}

/**
 * 按 UTF-8 字节截断，不切出半个多字节字符。
 *
 * 回退原理：UTF-8 的 continuation byte 形如 `10xxxxxx`。若截断点落在 continuation byte 上，
 * 说明正处于某个多字节字符中间，向前回退到该字符起始处。
 * 例：「中文中文」取 5 字节 → buf[5]=0x87、buf[4]=0x96 均为 continuation，
 * 回退至 end=3（buf[3]=0xE6 是第二个「文」的首字节）→ 得到「中」。
 */
export function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };

  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--;

  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * 分页取一批 items。`offset` 来自上一页回传的 `nextCursor`。
 *
 * 续读必须真的能翻页且能终止：POC 阶段 `cursor` 一度只是摆设（hint 让模型带 cursor
 * 再调，但工具 schema 不接受该参数，zod 静默剥掉），模型于是在同一页上死循环。
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
