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
  /**
   * 仅对 grande_run_result 有意义：它在响应里回传的 job state（"running" /
   * "passed" / "failed"）。C1 修复：report.ts 判定「模型是否自主轮询至终态」
   * 此前只看轮询间隔，从不看轮询看到的 job 状态——一次 running 中途的轮询和一次
   * 真正到达终态的轮询，在只看间隔的逻辑下长一个样。这个字段是让 autoPolled 能
   * 分辨两者的唯一依据。
   */
  state: string | null;
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
   * 可选，且缺失有两种截然不同的成因，日志行本身无法区分二者：
   * (1) Task 6 修复前写入的旧格式日志行，本来就没有这个字段；
   * (2) 当前调用里 server.ts 的 summarizeResponse 吞掉了响应解析异常、返回了
   *     undefined——此时原始响应（包括真实的 jobId）依然正常送回给了模型，只是
   *     这一条日志的响应摘要没能记录下来，不代表这次调用本身有任何问题。
   * report.ts 不能把「缺失」当成「已确认失败」，必须视作「无法判定」保守处理
   * （详见 report.ts 里 RunEpisode / Analysis 的相关注释）。
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
