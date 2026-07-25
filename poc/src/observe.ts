import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 工具调用响应的精简摘要——只留下判定 P-1/P-3/P-5 所需的字段，刻意保持扁平。
 * 之前 observe.ts 只记参数(args)、不记响应，导致 report.ts 只能靠位置或启发式
 * 猜测响应内容，产生了三个误判（详见 report.ts 顶部注释）。这个类型是根治。
 */
export interface ObserveResult {
  /** MCP 协议级错误（例如 zod 校验在 handler 运行前就拒绝了参数）；此时没有信封 */
  isError: boolean;
  /** 信封的 `ok`；响应里没有信封（isError 为 true）时为 null */
  ok: boolean | null;
  /** 信封的 error.code，例如 "TASK_NOT_FOUND" */
  errorCode: string | null;
  /** 信封的 `truncated` */
  truncated: boolean | null;
  /** 仅对 grande_run 有意义：它在响应里回传的 jobId */
  jobId: string | null;
}

export interface ObserveEvent {
  ts: number;
  iso: string;
  kind: "tool_call";
  repoId: string;
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  remoteUa: string;
  /**
   * 可选：Task 6 修复前写入的日志行没有这个字段。report.ts 必须能在缺失时
   * 优雅降级（视作「无法判定」），而不是崩溃。
   */
  result?: ObserveResult;
}

export function observeLogPath(): string {
  return resolve(process.env.POC_LOG ?? "./observe.jsonl");
}

export function logEvent(e: ObserveEvent): void {
  const path = observeLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(e) + "\n", "utf8");
}
