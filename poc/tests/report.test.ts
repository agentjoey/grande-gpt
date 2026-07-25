import { describe, expect, it } from "vitest";
import type { ObserveEvent, ObserveResult } from "../src/observe.ts";
import { analyze, renderMarkdown, type Analysis } from "../scripts/report.ts";

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

/**
 * 「无法观测」状态：result 字段整个缺失——不是 errResult() 描述的「确认失败」。
 * 两种可能成因（旧格式日志 / summarizeResponse 吞掉了响应解析异常，见
 * observe.ts 对 result 字段的注释）都是这个形状，不能混同为「已知失败」。
 * 命名为函数而不是直接省略第四个参数，是为了让调用点自解释意图。
 */
function unobservable(): undefined {
  return undefined;
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

  it("result 整个缺失（无法观测）时不崩溃，生成一个 jobId:null 的 fail-safe episode，不计入确认失败（Important 发现修复：无法观测是「不知道」，不是「确认失败」，不能从证据里消失）", () => {
    // 无法观测：可能是 Task 6 修复前写入的旧格式日志，也可能是当前调用里
    // summarizeResponse 吞掉了响应解析异常（模型收到的原始响应可能完全正常，
    // jobId 也许真的创建了）。两种成因日志行里长一个样子，report.ts 都无法
    // 区分，也不需要区分——统一保守处理为「未被证明自主轮询」。
    const a = analyze([ev("grande_run", T0, { taskId: "task_1", profile: "unit" }, unobservable())]);
    expect(a.episodes).toHaveLength(1);
    expect(a.episodes[0]!.jobId).toBeNull();
    expect(a.episodes[0]!.polls).toHaveLength(0);
    expect(a.episodes[0]!.autoPolled).toBe(false);
    expect(a.confirmedFailedRunCalls).toBe(0);
    expect(a.unobservableRunCalls).toBe(1);
  });

  it("业务失败（PROFILE_NOT_FOUND，jobId null）的 grande_run 同样不生成 episode、改记入 confirmedFailedRunCalls，且不影响同批次里真正开始的 run（重要发现：确认失败的 run 不是「未被轮询的证据」）", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "t", profile: "integration" }, errResult("PROFILE_NOT_FOUND")),
      ev("grande_run", T0 + 1_000, { taskId: "t", profile: "unit" }, runResult("job_a")),
      ev("grande_run_result", T0 + 11_000, { taskId: "t", jobId: "job_a" }),
    ]);
    expect(a.episodes).toHaveLength(1);
    expect(a.episodes[0]!.jobId).toBe("job_a");
    expect(a.episodes[0]!.autoPolled).toBe(true);
    expect(a.confirmedFailedRunCalls).toBe(1);
    expect(a.unobservableRunCalls).toBe(0);
  });

  it("两次 grande_run 撞了同一个 jobId 时保留先到的 builder，轮询归属先到者，不被后到者静默覆盖（Minor 发现 2 回归）", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_dup")),
      ev("grande_run", T0 + 1_000, { taskId: "t", profile: "unit" }, runResult("job_dup")),
      ev("grande_run_result", T0 + 11_000, { taskId: "t", jobId: "job_dup" }),
    ]);
    expect(a.episodes).toHaveLength(2);
    const earlier = a.episodes.find((e) => e.runAt === T0)!;
    const later = a.episodes.find((e) => e.runAt === T0 + 1_000)!;
    expect(earlier.polls).toHaveLength(1);
    expect(earlier.autoPolled).toBe(true);
    expect(later.polls).toHaveLength(0);
    expect(later.autoPolled).toBe(false);
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

  it("一次确认失败的 grande_run（PROFILE_NOT_FOUND，jobId null）加两次完美自主轮询 ⇒ P-1 仍是 PASS，且排除的调用数在文案中可见（重要发现回归：确认失败的调用不能拖累判定，也不能被悄悄藏起来）", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "integration" }, errResult("PROFILE_NOT_FOUND")),
        ev("grande_run", T0 + 1_000, { taskId: "t", profile: "unit" }, runResult("job_a")),
        ev("grande_run_result", T0 + 11_000, { taskId: "t", jobId: "job_a" }),
        ev("grande_run", T0 + 20_000, { taskId: "t", profile: "unit-file" }, runResult("job_b")),
        ev("grande_run_result", T0 + 30_000, { taskId: "t", jobId: "job_b" }),
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*PASS\*\*/s);
    expect(md).toContain("1 次确认失败");
  });

  it("一次响应无法观测的 grande_run 加两次完美自主轮询 ⇒ P-1 仍是 FAIL，不能因为其余都自主轮询了就把无法观测的那次当成已确认（假 PASS 回归防护——本次修复里最关键的一条：真的创建了 job、模型真的没轮询，但日志侧没能记下响应摘要时，这条负面证据绝不能悄悄消失）", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }, unobservable()),
        ev("grande_run", T0 + 1_000, { taskId: "t", profile: "unit" }, runResult("job_a")),
        ev("grande_run_result", T0 + 11_000, { taskId: "t", jobId: "job_a" }),
        ev("grande_run", T0 + 20_000, { taskId: "t", profile: "unit-file" }, runResult("job_b")),
        ev("grande_run_result", T0 + 30_000, { taskId: "t", jobId: "job_b" }),
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*FAIL\*\*/s);
  });

  it("grande_run 全部确认失败（0 次真正开始的 run）⇒ P-1 仍是 FAIL，不因为排除了确认失败的调用就矫枉过正变成空真 PASS", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "integration" }, errResult("PROFILE_NOT_FOUND")),
        ev("grande_run", T0 + 1_000, { taskId: "t", profile: "bogus" }, errResult("PROFILE_NOT_FOUND")),
        ev("grande_run", T0 + 2_000, { taskId: "t", profile: "typo" }, errResult("PROFILE_NOT_FOUND")),
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*FAIL\*\*/s);
    expect(md).toContain("3 次确认失败");
  });

  it("确认失败的调用与一次真实但从未被轮询的 episode 共存时仍是 FAIL（本次修复的 Minor 2：排除确认失败不能连带稀释掉另一个真正未被自主轮询的 episode，两者独立判定）", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "integration" }, errResult("PROFILE_NOT_FOUND")),
        ev("grande_run", T0 + 1_000, { taskId: "t", profile: "unit" }, runResult("job_a")),
        // job_a 故意没有任何 grande_run_result：一个真实拿到 jobId、但从未被轮询的 episode。
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*FAIL\*\*/s);
  });

  it("渲染文案把「确认失败」与「无法观测」分开报告为两个独立的数字，读者不会把无法观测误读成确认的模型失败（重要发现修复的核心要求）", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "integration" }, errResult("PROFILE_NOT_FOUND")),
        ev("grande_run", T0 + 1_000, { taskId: "t", profile: "unit" }, unobservable()),
        ev("grande_run", T0 + 2_000, { taskId: "t", profile: "unit-file" }, runResult("job_a")),
        ev("grande_run_result", T0 + 12_000, { taskId: "t", jobId: "job_a" }),
      ]),
    );
    expect(md).toContain("1 次确认失败");
    expect(md).toContain("1 次响应无法观测");
    // 无法观测那次仍以「未知」出现在下表——jobId ?? "未知" 的兜底现在由真实的
    // analyze() 输出触发，而不只是手工构造的 fixture。
    expect(md).toContain("`未知`");
    expect(md).toMatch(/P-1.*\*\*FAIL\*\*/s);
  });

  it("孤立轮询的次数出现在渲染文案里，而不只是 analyze() 的数据里（Minor 发现 1）", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a")),
        ev("grande_run_result", T0 + 10_000, { taskId: "t", jobId: "job_a" }),
        ev("grande_run_result", T0 + 20_000, { taskId: "t", jobId: "job_ghost" }),
      ]),
    );
    expect(md).toContain("另有 1 次 `grande_run_result` 轮询的 jobId 未匹配到任何已知 run");
  });

  it("episode 的 jobId 出现在表格里（Minor 发现 1）", () => {
    const md = renderMarkdown(analyze([ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_xyz"))]));
    expect(md).toContain("`job_xyz`");
  });

  it("jobId 缺失时表格用「未知」兜底（Minor 发现 1；这里继续直接构造 Analysis 来单独锁定 renderMarkdown 的渲染契约——这个 fixture 现在也正是 analyze() 对「无法观测」调用的真实产出形状，另见上面 unobservable() 相关用例）", () => {
    const a: Analysis = {
      totalToolCalls: 1,
      byTool: { grande_run: 1 },
      episodes: [
        { jobId: null, runAt: T0, polls: [], gapsMs: [], maxGapMs: Number.POSITIVE_INFINITY, autoPolled: false },
      ],
      confirmedFailedRunCalls: 0,
      unobservableRunCalls: 1,
      orphanPolls: 0,
      taskIdLossEvents: 0,
      distinctTaskIds: 0,
      taskOpenCalls: 0,
      longestChainWithoutGap: 1,
      truncationOpportunities: 0,
      truncationFollowUps: 0,
    };
    const md = renderMarkdown(a);
    expect(md).toContain("`未知`");
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
