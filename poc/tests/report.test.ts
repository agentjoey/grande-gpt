import { describe, expect, it } from "vitest";
import type { ObserveEvent, ObserveResult } from "../src/observe.ts";
import { analyze, renderMarkdown } from "../scripts/report.ts";

function ev(tool: string, ts: number, args: Record<string, unknown> = {}, result?: ObserveResult): ObserveEvent {
  return { ts, iso: new Date(ts).toISOString(), kind: "tool_call", repoId: "demo-app", tool, args, durationMs: 5, remoteUa: "test", result };
}

/** grande_run 的成功响应摘要，jobId 是调用者关心的部分。 */
function runResult(jobId: string): ObserveResult {
  return { isError: false, ok: true, errorCode: null, truncated: false, jobId };
}

/** 普通工具（非 grande_run）的成功响应摘要，默认未截断；按需覆盖。 */
function okResult(overrides: Partial<ObserveResult> = {}): ObserveResult {
  return { isError: false, ok: true, errorCode: null, truncated: false, jobId: null, ...overrides };
}

/** 信封 ok:false 的错误响应摘要（ErrorEnvelope 没有 truncated 字段，故为 null）。 */
function errResult(errorCode: string): ObserveResult {
  return { isError: false, ok: false, errorCode, truncated: null, jobId: null };
}

const T0 = 1_800_000_000_000;

describe("analyze()", () => {
  it("统计工具调用总数与分布", () => {
    const a = analyze([ev("grande_repo_read", T0), ev("grande_repo_read", T0 + 1000), ev("grande_diff", T0 + 2000)]);
    expect(a.totalToolCalls).toBe(3);
    expect(a.byTool.grande_repo_read).toBe(2);
  });

  it("间隔均 ≤60s 的轮询序列按响应里的 jobId 归属到同一 episode，判定为自主轮询", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }, runResult("job_a")),
      ev("grande_run_result", T0 + 10_000, { taskId: "task_1", jobId: "job_a" }),
      ev("grande_run_result", T0 + 22_000, { taskId: "task_1", jobId: "job_a" }),
    ]);
    expect(a.episodes).toHaveLength(1);
    expect(a.episodes[0]!.jobId).toBe("job_a");
    expect(a.episodes[0]!.polls).toHaveLength(2);
    expect(a.episodes[0]!.autoPolled).toBe(true);
    expect(a.episodes[0]!.maxGapMs).toBeLessThanOrEqual(60_000);
    expect(a.orphanPolls).toBe(0);
  });

  it("出现超过 60s 的间隔则判定为非自主（疑似人工催促）", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }, runResult("job_a")),
      ev("grande_run_result", T0 + 95_000, { taskId: "task_1", jobId: "job_a" }),
    ]);
    expect(a.episodes[0]!.autoPolled).toBe(false);
  });

  it("run 之后没有任何轮询则记为零轮询、非自主；日志行没有响应摘要时优雅降级而不崩溃", () => {
    // 不带 result 参数：模拟 Task 6 修复前写入的旧格式日志行。
    const a = analyze([ev("grande_run", T0, { taskId: "task_1", profile: "unit" })]);
    expect(a.episodes[0]!.jobId).toBeNull();
    expect(a.episodes[0]!.polls).toHaveLength(0);
    expect(a.episodes[0]!.autoPolled).toBe(false);
  });

  it("后到的轮询按响应里的 jobId 归属，而不是日志中的相邻位置（I1 回归：抢跑连开两个 run）", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }, runResult("job_1")),
      ev("grande_run", T0 + 2_000, { taskId: "task_1", profile: "unit" }, runResult("job_2")),
      // 迟到的轮询：紧跟在 run2 之后发生，但按 jobId 属于 run1——按位置切分的旧
      // 实现会把它错配给 run2，从而伪造出「run2 也被自主轮询了」的假象。
      ev("grande_run_result", T0 + 12_000, { taskId: "task_1", jobId: "job_1" }),
    ]);
    expect(a.episodes).toHaveLength(2);
    const run1 = a.episodes.find((e) => e.jobId === "job_1")!;
    const run2 = a.episodes.find((e) => e.jobId === "job_2")!;
    expect(run1.polls).toHaveLength(1);
    expect(run1.autoPolled).toBe(true);
    expect(run2.polls).toHaveLength(0);
    expect(run2.autoPolled).toBe(false);
    expect(a.orphanPolls).toBe(0);
  });

  it("轮询的 jobId 匹配不到任何已知 run 时计为孤立轮询，而不是被静默丢弃", () => {
    const a = analyze([ev("grande_run_result", T0, { taskId: "task_1", jobId: "job_ghost" })]);
    expect(a.episodes).toHaveLength(0);
    expect(a.orphanPolls).toBe(1);
  });

  it("统计 TASK_NOT_FOUND 响应次数——taskId 丢失的直接信号", () => {
    const a = analyze([
      ev("grande_repo_read", T0, { taskId: "task_1", path: "a" }, okResult()),
      ev("grande_repo_read", T0 + 1000, { taskId: "task_ghost", path: "a" }, errResult("TASK_NOT_FOUND")),
    ]);
    expect(a.taskIdLossEvents).toBe(1);
  });

  it("合法的第二个任务不应被误判为 taskId 丢失（I2 回归：不再用基线 taskId 启发式）", () => {
    const a = analyze([
      ev("grande_task_open", T0, { goal: "task one" }, okResult()),
      ev("grande_repo_read", T0 + 1000, { taskId: "task_1", path: "a" }, okResult()),
      ev("grande_task_open", T0 + 2000, { goal: "task two" }, okResult()),
      ev("grande_repo_read", T0 + 3000, { taskId: "task_2", path: "b" }, okResult()),
    ]);
    expect(a.taskIdLossEvents).toBe(0);
    expect(a.distinctTaskIds).toBe(2);
    expect(a.taskOpenCalls).toBe(2);
  });

  it("截断发生前主动指定 lineRange/cursor 不计入续读次数（I3 回归：首次指定范围 ≠ 续读）", () => {
    const a = analyze([
      ev("grande_repo_read", T0, { taskId: "task_1", path: "big", lineRange: "1-100" }, okResult({ truncated: false })),
      ev("grande_repo_search", T0 + 1000, { taskId: "task_1", query: "q", cursor: "50" }, okResult({ truncated: false })),
    ]);
    expect(a.truncationOpportunities).toBe(0);
    expect(a.truncationFollowUps).toBe(0);
  });

  it("截断响应之后带 cursor 或 lineRange 的调用才计入续读次数（P-5 信号）", () => {
    const a = analyze([
      ev("grande_repo_read", T0, { taskId: "task_1", path: "big" }, okResult({ truncated: true })),
      ev("grande_repo_read", T0 + 1000, { taskId: "task_1", path: "big", lineRange: "500-1000" }, okResult({ truncated: false })),
      ev("grande_repo_search", T0 + 2000, { taskId: "task_1", query: "q", cursor: "50" }, okResult({ truncated: false })),
    ]);
    expect(a.truncationOpportunities).toBe(1);
    expect(a.truncationFollowUps).toBe(2);
  });

  it("统计相邻间隔均 ≤60s 的最长连续调用链", () => {
    const a = analyze([
      ev("grande_repo_read", T0),
      ev("grande_repo_read", T0 + 5_000),
      ev("grande_repo_read", T0 + 10_000),
      ev("grande_repo_read", T0 + 200_000),
    ]);
    expect(a.longestChainWithoutGap).toBe(3);
  });
});

describe("renderMarkdown()", () => {
  it("输出含 P-1～P-5 五个小节", () => {
    const md = renderMarkdown(analyze([ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a"))]));
    for (const p of ["P-1", "P-2", "P-3", "P-4", "P-5"]) expect(md).toContain(p);
  });

  it("P-1 结论明确给出 PASS 或 FAIL", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a")),
        ev("grande_run_result", T0 + 10_000, { taskId: "t", jobId: "job_a" }),
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*(PASS|FAIL)\*\*/s);
  });

  it("analyze([]) 时 P-1 不是空真的 PASS，而是 FAIL（空真守卫回归）", () => {
    const md = renderMarkdown(analyze([]));
    expect(md).toMatch(/P-1.*\*\*FAIL\*\*/s);
  });

  it("有其他工具调用但一次 grande_run 都没有时，P-1 仍是 FAIL（空真守卫回归）", () => {
    const md = renderMarkdown(analyze([ev("grande_repo_read", T0, { taskId: "t", path: "a" }, okResult())]));
    expect(md).toMatch(/P-1.*\*\*FAIL\*\*/s);
  });

  it("合法的第二个任务使 P-3 判定为 PASS（I2 回归）", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_task_open", T0, { goal: "task one" }, okResult()),
        ev("grande_task_open", T0 + 1000, { goal: "task two" }, okResult()),
      ]),
    );
    expect(md).toMatch(/P-3.*\*\*PASS\*\*/s);
  });

  it("从未触发截断时 P-5 报告未判定，而不是 FAIL", () => {
    const md = renderMarkdown(
      analyze([ev("grande_repo_read", T0, { taskId: "t", path: "a" }, okResult({ truncated: false }))]),
    );
    expect(md).toContain("未触发截断，无法判定");
    expect(md).not.toMatch(/P-5.*\*\*FAIL\*\*/s);
  });

  it("截断响应之后出现续读调用时 P-5 判定为 PASS", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_repo_read", T0, { taskId: "t", path: "big" }, okResult({ truncated: true })),
        ev("grande_repo_read", T0 + 1000, { taskId: "t", path: "big", lineRange: "500-1000" }, okResult({ truncated: false })),
      ]),
    );
    expect(md).toMatch(/P-5.*\*\*PASS\*\*/s);
  });
});
