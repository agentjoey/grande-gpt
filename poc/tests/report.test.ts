import { describe, expect, it } from "vitest";
import { JOB_DURATION_MS } from "../src/jobs.ts";
import type { ObserveEvent, ObserveResult } from "../src/observe.ts";
import { analyze, renderMarkdown, type Analysis } from "../scripts/report.ts";

function ev(tool: string, ts: number, args: Record<string, unknown> = {}, result?: ObserveResult): ObserveEvent {
  return { ts, iso: new Date(ts).toISOString(), kind: "tool_call", repoId: "demo-app", tool, args, durationMs: 5, remoteUa: "test", result };
}

/** grande_run 的成功响应摘要，jobId 是调用者关心的部分。 */
function runResult(jobId: string): ObserveResult {
  return { isError: false, ok: true, errorCode: null, truncated: false, jobId, state: null };
}

/** 普通工具（非 grande_run）的成功响应摘要，默认未截断；按需覆盖。 */
function okResult(overrides: Partial<ObserveResult> = {}): ObserveResult {
  return { isError: false, ok: true, errorCode: null, truncated: false, jobId: null, state: null, ...overrides };
}

/** 信封 ok:false 的错误响应摘要（ErrorEnvelope 没有 truncated 字段，故为 null）。 */
function errResult(errorCode: string): ObserveResult {
  return { isError: false, ok: false, errorCode, truncated: null, jobId: null, state: null };
}

/**
 * grande_run_result 的成功响应摘要——state 是 C1 判定「是否轮询至终态」的关键
 * 字段。真实响应里 jobId 字段也存在，但 extractObserveResult 只在 toolName 是
 * grande_run 时才提取 jobId，故这里恒为 null（与真实提取行为保持一致）。
 */
function pollResult(state: string, overrides: Partial<ObserveResult> = {}): ObserveResult {
  return { isError: false, ok: true, errorCode: null, truncated: false, jobId: null, state, ...overrides };
}

/**
 * MCP 协议级 schema 拒绝：zod 校验在 handler 运行前就拒绝了参数（例如模型完全
 * 省略了必填的 taskId），没有信封。这与 errResult() 描述的「业务错误」不同——
 * errorCode 是 null，isError 是 true（I1 用例专用）。
 */
function schemaRejection(): ObserveResult {
  return { isError: true, ok: null, errorCode: null, truncated: null, jobId: null, state: null };
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

  it("间隔够短、且最后一次轮询到终态的序列按响应里的 jobId 归属到同一 episode，判定为自主轮询", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }, runResult("job_a")),
      ev("grande_run_result", T0 + 10_000, { taskId: "task_1", jobId: "job_a" }, pollResult("running")),
      ev("grande_run_result", T0 + 22_000, { taskId: "task_1", jobId: "job_a" }, pollResult("passed")),
    ]);
    expect(a.episodes).toHaveLength(1);
    expect(a.episodes[0]!.jobId).toBe("job_a");
    expect(a.episodes[0]!.polls).toHaveLength(2);
    expect(a.episodes[0]!.lastPollState).toBe("passed");
    expect(a.episodes[0]!.autoPolled).toBe(true);
    expect(a.episodes[0]!.maxGapMs).toBeLessThanOrEqual(2 * JOB_DURATION_MS);
    expect(a.orphanPolls).toBe(0);
  });

  it("出现超过阈值（2 × job 时长）的间隔则判定为非自主（疑似人工催促，I5 回归：阈值现在与 job 时长耦合）", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "task_1", profile: "unit" }, runResult("job_a")),
      // 即便最后一次轮询到了终态，间隔太大也不算自主——这里把两个独立条件分开验证。
      ev("grande_run_result", T0 + 2 * JOB_DURATION_MS + 5_000, { taskId: "task_1", jobId: "job_a" }, pollResult("passed")),
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
      ev("grande_run_result", T0 + 11_000, { taskId: "t", jobId: "job_a" }, pollResult("passed")),
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
      ev("grande_run_result", T0 + 11_000, { taskId: "t", jobId: "job_dup" }, pollResult("passed")),
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
      ev("grande_run_result", T0 + 12_000, { taskId: "task_1", jobId: "job_1" }, pollResult("passed")),
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

  it("C1 回归：只轮询到 running（非终态）就没有更多轮询时，autoPolled 为 false，即使间隔很短——这是被验证过的假 PASS 场景：模型轮询一次看到 running 就转头去跟用户聊天", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a")),
      ev("grande_run_result", T0 + 2_000, { taskId: "t", jobId: "job_a" }, pollResult("running")),
    ]);
    expect(a.episodes[0]!.polls).toHaveLength(1);
    expect(a.episodes[0]!.lastPollState).toBe("running");
    expect(a.episodes[0]!.autoPolled).toBe(false);
    expect(a.abandonedRunEpisodes).toBe(1);
  });

  it("C1 回归：最后一次轮询到 failed（终态）时 autoPolled 为 true，且不计入 abandonedRunEpisodes", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a")),
      ev("grande_run_result", T0 + 2_000, { taskId: "t", jobId: "job_a" }, pollResult("failed")),
    ]);
    expect(a.episodes[0]!.autoPolled).toBe(true);
    expect(a.abandonedRunEpisodes).toBe(0);
  });

  it("C1 回归：轮询了几次，中间是 running，只要最后一次到终态就算自主轮询到底", () => {
    const a = analyze([
      ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a")),
      ev("grande_run_result", T0 + 2_000, { taskId: "t", jobId: "job_a" }, pollResult("running")),
      ev("grande_run_result", T0 + 4_000, { taskId: "t", jobId: "job_a" }, pollResult("running")),
      ev("grande_run_result", T0 + 6_000, { taskId: "t", jobId: "job_a" }, pollResult("passed")),
    ]);
    expect(a.episodes[0]!.autoPolled).toBe(true);
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

  it("I1 回归：统计 isError:true 的 schema 级拒绝次数，与 errResult() 描述的业务错误分开计数", () => {
    const a = analyze([
      ev("grande_repo_read", T0, {}, schemaRejection()),
      ev("grande_repo_read", T0 + 1000, { taskId: "t" }, okResult()),
      ev("grande_repo_read", T0 + 2000, { taskId: "t_ghost" }, errResult("TASK_NOT_FOUND")),
    ]);
    expect(a.schemaRejections).toBe(1);
    expect(a.taskIdLossEvents).toBe(1); // 两者互不覆盖，各自独立计数
  });

  it("remoteUa 按值聚合次数，空字符串归入占位桶而不是被丢弃（remoteUa 此前只记录、从未被读取）", () => {
    const a = analyze([
      { ...ev("grande_repo_read", T0, { taskId: "t" }, okResult()), remoteUa: "ChatGPT-Agent/1.0" },
      { ...ev("grande_repo_read", T0 + 1000, { taskId: "t" }, okResult()), remoteUa: "curl/8.0" },
      { ...ev("grande_repo_read", T0 + 2000, { taskId: "t" }, okResult()), remoteUa: "ChatGPT-Agent/1.0" },
      { ...ev("grande_repo_read", T0 + 3000, { taskId: "t" }, okResult()), remoteUa: "" },
    ]);
    expect(a.byRemoteUa["ChatGPT-Agent/1.0"]).toBe(2);
    expect(a.byRemoteUa["curl/8.0"]).toBe(1);
    expect(a.byRemoteUa["(空)"]).toBe(1);
  });

  it("首尾事件的 ISO 时间戳（Report provenance 的一部分）", () => {
    const a = analyze([ev("grande_repo_read", T0), ev("grande_repo_read", T0 + 5000), ev("grande_repo_read", T0 + 2000)]);
    expect(a.firstEventIso).toBe(new Date(T0).toISOString());
    expect(a.lastEventIso).toBe(new Date(T0 + 5000).toISOString());
  });

  it("events 为空时首尾时间戳为 null", () => {
    const a = analyze([]);
    expect(a.firstEventIso).toBeNull();
    expect(a.lastEventIso).toBeNull();
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
        ev("grande_run_result", T0 + 11_000, { taskId: "t", jobId: "job_a" }, pollResult("passed")),
        ev("grande_run", T0 + 20_000, { taskId: "t", profile: "unit-file" }, runResult("job_b")),
        ev("grande_run_result", T0 + 30_000, { taskId: "t", jobId: "job_b" }, pollResult("failed")),
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
        ev("grande_run_result", T0 + 11_000, { taskId: "t", jobId: "job_a" }, pollResult("passed")),
        ev("grande_run", T0 + 20_000, { taskId: "t", profile: "unit-file" }, runResult("job_b")),
        ev("grande_run_result", T0 + 30_000, { taskId: "t", jobId: "job_b" }, pollResult("failed")),
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

  it("jobId 缺失时表格用「未知」兜底，判定列渲染为「无法观测」而不是「非自主」（Minor 发现 1 + M15 回归；这里继续直接构造 Analysis 来单独锁定 renderMarkdown 的渲染契约——这个 fixture 现在也正是 analyze() 对「无法观测」调用的真实产出形状，另见上面 unobservable() 相关用例）", () => {
    const a: Analysis = {
      totalToolCalls: 1,
      byTool: { grande_run: 1 },
      episodes: [
        {
          jobId: null,
          runAt: T0,
          polls: [],
          gapsMs: [],
          maxGapMs: Number.POSITIVE_INFINITY,
          lastPollState: null,
          autoPolled: false,
        },
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
      schemaRejections: 0,
      abandonedRunEpisodes: 0,
      byRemoteUa: {},
      firstEventIso: null,
      lastEventIso: null,
    };
    const md = renderMarkdown(a);
    expect(md).toContain("`未知`");
    expect(md).toContain("| 1 | `未知` | 0 | — | ∞ | 无法观测 |");
  });

  it("M15 回归：无法观测的 fail-safe episode 判定为「无法观测」，与真正观测到但轮询未到终态的 episode（「非自主」）区分开，不能渲染成同一个值", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }, unobservable()),
        ev("grande_run", T0 + 1_000, { taskId: "t", profile: "unit" }, runResult("job_a")),
        ev("grande_run_result", T0 + 2_000, { taskId: "t", jobId: "job_a" }, pollResult("running")),
      ]),
    );
    expect(md).toContain("| 1 | `未知` | 0 | — | ∞ | 无法观测 |");
    expect(md).toMatch(/\| 2 \| `job_a` \| 1 \| [\d.]+ \| [\d.]+ \| 非自主 \|/);
  });

  it("C1 回归（本次修复最核心的假 PASS 防护）：轮询一次但未到终态（仍是 running）⇒ P-1 FAIL，不能因为间隔够短就判自主", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a")),
        ev("grande_run_result", T0 + 2_000, { taskId: "t", jobId: "job_a" }, pollResult("running")),
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*FAIL\*\*/s);
    // 文案需区分「轮询到终态」与「轮询但半途放弃」，这里正是后者。
    expect(md).toContain("polled but abandoned");
  });

  it("C1 回归：轮询至终态（passed）⇒ P-1 PASS", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a")),
        ev("grande_run_result", T0 + 2_000, { taskId: "t", jobId: "job_a" }, pollResult("passed")),
      ]),
    );
    expect(md).toMatch(/P-1.*\*\*PASS\*\*/s);
  });

  it("I5 回归：P-1 PASS 时 headline 带「待人工确认：执行者未打字」限定语，且渲染出手工确认填空槽（不再是裸 PASS）", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_run", T0, { taskId: "t", profile: "unit" }, runResult("job_a")),
        ev("grande_run_result", T0 + 2_000, { taskId: "t", jobId: "job_a" }, pollResult("passed")),
      ]),
    );
    expect(md).toMatch(/\*\*PASS\*\*（待人工确认：执行者未打字）/);
    expect(md).toContain("须由执行者手工填写");
  });

  it("I5 回归：P-1 FAIL 时不带「待人工确认」限定语——歧义只发生在 PASS 一侧", () => {
    const md = renderMarkdown(analyze([]));
    expect(md).not.toContain("**FAIL**（待人工确认");
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

  it("I1 回归：schema 级拒绝（模型漏传必填参数，zod 在 handler 前就拒绝）不会被 TASK_NOT_FOUND 计数覆盖，但仍让 P-3 不是 PASS", () => {
    const md = renderMarkdown(
      analyze([
        ev("grande_repo_read", T0, {}, schemaRejection()),
        ev("grande_repo_read", T0 + 1_000, {}, schemaRejection()),
      ]),
    );
    expect(md).not.toMatch(/P-3.*\*\*PASS\*\*/s);
    // TASK_NOT_FOUND 计数如实为 0——这正是问题所在：光看这个数字会误判 PASS。
    expect(md).toContain("检测到 0 次响应为 `TASK_NOT_FOUND`");
    expect(md).toContain("另检测到 2 次 MCP 协议级 schema 拒绝");
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

  it("Report provenance 回归：传入 logPath 时渲染出证据来源、事件数与首末事件时间戳，报告不再脱离其证据存在", () => {
    const events = [
      ev("grande_repo_read", T0, { taskId: "t", path: "a" }, okResult()),
      ev("grande_diff", T0 + 5000, { taskId: "t" }, okResult()),
    ];
    const md = renderMarkdown(analyze(events), "/tmp/observe-round-1.jsonl");
    expect(md).toContain("/tmp/observe-round-1.jsonl");
    expect(md).toContain("事件数：**2**");
    expect(md).toContain(new Date(T0).toISOString());
    expect(md).toContain(new Date(T0 + 5000).toISOString());
  });

  it("Report provenance 回归：不传 logPath 时（向后兼容旧调用点）不崩溃，明确标注未知而不是留空", () => {
    const md = renderMarkdown(analyze([ev("grande_repo_read", T0, { taskId: "t", path: "a" }, okResult())]));
    expect(md).toContain("证据来源");
  });

  it("remoteUa 分布出现在渲染文案里（remoteUa 此前只记录、从未展示）", () => {
    const md = renderMarkdown(
      analyze([
        { ...ev("grande_repo_read", T0, { taskId: "t" }, okResult()), remoteUa: "ChatGPT-Agent/1.0" },
        { ...ev("grande_repo_read", T0 + 1000, { taskId: "t" }, okResult()), remoteUa: "curl/8.0" },
      ]),
    );
    expect(md).toContain("来源 User-Agent 分布");
    expect(md).toContain("ChatGPT-Agent/1.0");
    expect(md).toContain("curl/8.0");
  });
});
