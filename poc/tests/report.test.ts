import { describe, expect, it } from "vitest";
import type { ObserveEvent } from "../src/observe.ts";
import { analyze, renderMarkdown } from "../scripts/report.ts";

function ev(tool: string, ts: number, args: Record<string, unknown> = {}): ObserveEvent {
  return { ts, iso: new Date(ts).toISOString(), kind: "tool_call", repoId: "demo-app", tool, args, durationMs: 5, remoteUa: "test" };
}

const T0 = 1_800_000_000_000;

describe("analyze()", () => {
  it("统计工具调用总数与分布", () => {
    const a = analyze([ev("grande_repo_read", T0), ev("grande_repo_read", T0 + 1000), ev("grande_diff", T0 + 2000)]);
    expect(a.totalToolCalls).toBe(3);
    expect(a.byTool.grande_repo_read).toBe(2);
  });

  it("间隔均 ≤60s 的轮询序列判定为自主轮询", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }),
      ev("grande_run_result", T0 + 10_000, { taskId: "task_1", jobId: "job_a" }),
      ev("grande_run_result", T0 + 22_000, { taskId: "task_1", jobId: "job_a" }),
    ]);
    expect(a.episodes).toHaveLength(1);
    expect(a.episodes[0]!.polls).toHaveLength(2);
    expect(a.episodes[0]!.autoPolled).toBe(true);
    expect(a.episodes[0]!.maxGapMs).toBeLessThanOrEqual(60_000);
  });

  it("出现超过 60s 的间隔则判定为非自主（疑似人工催促）", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }),
      ev("grande_run_result", T0 + 95_000, { taskId: "task_1", jobId: "job_a" }),
    ]);
    expect(a.episodes[0]!.autoPolled).toBe(false);
  });

  it("run 之后没有任何轮询则记为未解析且非自主", () => {
    const a = analyze([ev("grande_run", T0, { taskId: "task_1", profile: "unit" })]);
    expect(a.episodes[0]!.polls).toHaveLength(0);
    expect(a.episodes[0]!.autoPolled).toBe(false);
    expect(a.episodes[0]!.resolved).toBe(false);
  });

  it("统计 TASK_NOT_FOUND 触发次数（taskId 丢失信号）", () => {
    const a = analyze([
      ev("grande_repo_read", T0, { taskId: "task_1", path: "a" }),
      ev("grande_repo_read", T0 + 1000, { path: "a" }),
      ev("grande_repo_read", T0 + 2000, { taskId: "task_wrong", path: "a" }),
    ]);
    expect(a.taskIdLossEvents).toBe(1);
  });

  it("统计带 cursor 或 lineRange 的续读次数（P-5 信号）", () => {
    const a = analyze([
      ev("grande_repo_read", T0, { taskId: "task_1", path: "big" }),
      ev("grande_repo_read", T0 + 1000, { taskId: "task_1", path: "big", lineRange: "100-200" }),
      ev("grande_repo_search", T0 + 2000, { taskId: "task_1", query: "q", cursor: "50" }),
    ]);
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
    const md = renderMarkdown(analyze([ev("grande_run", T0, { taskId: "t", profile: "unit" })]));
    for (const p of ["P-1", "P-2", "P-3", "P-4", "P-5"]) expect(md).toContain(p);
  });

  it("P-1 结论明确给出 PASS 或 FAIL", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }),
        ev("grande_run_result", T0 + 10_000, { taskId: "t", jobId: "job_a" }),
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*(PASS|FAIL)\*\*/s);
  });
});
