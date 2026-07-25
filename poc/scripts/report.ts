import { readFileSync } from "node:fs";
import { JOB_DURATION_MS } from "../src/jobs.ts";
import type { ObserveEvent } from "../src/observe.ts";
import { observeLogPath } from "../src/observe.ts";

/**
 * 超过这个间隔就认为中间夹了人类操作，而非模型自主连续调用。
 *
 * 定义为 job 时长的 2 倍，而不是一个独立的固定常数（I5 修复）：此前硬编码的
 * 60_000 是默认 job 时长（20s）的 3 倍，人类在第 25 秒打字催促、和模型自己在
 * 第 25 秒轮询，在日志里长一个样，两者都会被判成「自主」。导入 JOB_DURATION_MS
 * 而不是重新硬编码一个数字，保证这两个量永远耦合——`POC_JOB_DURATION_MS`
 * 改了，这里也跟着变。
 */
const HUMAN_GAP_MS = 2 * JOB_DURATION_MS;

/** grande_run_result 记录到的 job state 里，哪些算「到终态」。 */
const TERMINAL_JOB_STATES = new Set(["passed", "failed"]);

function isTerminalState(state: string | null): boolean {
  return state !== null && TERMINAL_JOB_STATES.has(state);
}

/**
 * 一次 grande_run 及其后续轮询。身份是响应里回传的 jobId（见 observe.ts 的
 * ObserveResult），不是它在日志里的位置——按位置切分曾经是个 bug（I1）：
 * 模型抢跑连开两个 run 时，晚到的第一个 run 的轮询会被位置法错配给第二个 run，
 * 能把从未被轮询过的 run 伪造成 autoPolled:true。
 *
 * 「拿不到 jobId」分两种，处理方式截然不同：
 *
 * - 确认失败：result 到了，但明确说没有 jobId（业务失败如 PROFILE_NOT_FOUND、
 *   或 MCP 协议级拒绝）。这种调用从未真正开始过一个可轮询的任务，说明不了模型
 *   会不会轮询，因此不生成 episode，只计入 Analysis.confirmedFailedRunCalls——
 *   否则一次业务错误就能把 P-1 拖成假 FAIL。
 * - 无法观测：ObserveEvent.result 整个缺失（见 observe.ts 对该字段的注释：可能
 *   是旧格式日志，也可能是当前调用里 server.ts 的 summarizeResponse 吞掉了响应
 *   解析异常——那种情况下模型收到的原始响应可能完全正常、job 也真的创建了，只是
 *   这条日志没能记下摘要）。这不是「没有失败」的证据，是「不知道」，不能像确认
 *   失败那样被排除：这里会生成一个 jobId:null、零轮询、autoPolled:false 的
 *   fail-safe episode，计入 Analysis.episodes 与 Analysis.unobservableRunCalls，
 *   把 P-1 判定拖向 FAIL，而不是让这次真假莫辨的调用从证据里悄悄消失。
 *
 * jobId 的类型是 `string | null` 正对应这两档：episode 存在就说明它不是「确认
 * 失败」，jobId 是 string 就说明它也不是「无法观测」；null 专门留给 fail-safe
 * episode。
 */
export interface RunEpisode {
  jobId: string | null;
  runAt: number;
  polls: number[];
  gapsMs: number[];
  maxGapMs: number;
  /**
   * 最后一次 grande_run_result 轮询里记录的 job state（来自 ObserveResult.state），
   * 没有任何轮询、或轮询到但响应无法观测时为 null。C1 修复的核心字段：判定
   * autoPolled 除了看轮询间隔，还必须看轮询有没有看到终态——只看间隔会把「模型
   * 轮询一次看到 running 就转头去跟用户聊天」误判为自主轮询到底。
   */
  lastPollState: string | null;
  autoPolled: boolean;
}

export interface Analysis {
  totalToolCalls: number;
  byTool: Record<string, number>;
  episodes: RunEpisode[];
  /**
   * 确认失败：grande_run 的 result 到了，但明确说没有 jobId——业务失败（如
   * PROFILE_NOT_FOUND）或 MCP 协议级拒绝。这些调用从未开始过一个可轮询的任务，
   * 不构成「没有被轮询」的证据，因此被排除在 episodes 之外、不参与 P-1 判定；
   * 这里如实计数，P-1 小节的文案里同样如实报告，不静默丢弃。
   */
  confirmedFailedRunCalls: number;
  /**
   * 无法观测：grande_run 的 ObserveEvent.result 字段整个缺失。这不是「没有
   * 失败」的证据，是「不知道」——旧格式日志、或当前调用里 summarizeResponse 吞掉
   * 响应解析异常，两种成因在日志行里长一个样子（见 observe.ts 对 result 字段的
   * 注释）。这类调用不被排除：每次各自生成一个 fail-safe episode（jobId:null、
   * 零轮询、autoPolled:false）计入 episodes，把 P-1 判定拖向 FAIL；这里单独计数，
   * P-1 文案里与 confirmedFailedRunCalls 分开报告，不能让读者把「无法观测」看成
   * 「确认模型没轮询」。
   */
  unobservableRunCalls: number;
  /** grande_run_result 的 args.jobId 未匹配到任何已知 episode 的次数（不再被静默丢弃） */
  orphanPolls: number;
  /** 响应 errorCode === "TASK_NOT_FOUND" 的次数——taskId 丢失的直接信号 */
  taskIdLossEvents: number;
  /** 信息补充，不构成判定：全程出现过的不同 taskId 数 */
  distinctTaskIds: number;
  /** 信息补充，不构成判定：grande_task_open 调用次数 */
  taskOpenCalls: number;
  longestChainWithoutGap: number;
  /** 响应 truncated === true 的次数（P-5 的"机会"数） */
  truncationOpportunities: number;
  /** 在至少一次 truncated 响应之后发生的、带 cursor/lineRange 的调用次数 */
  truncationFollowUps: number;
  /**
   * MCP 协议级 schema 拒绝次数：ObserveResult.isError === true，即 zod 校验在
   * handler 运行前就拒绝了参数（例如模型完全省略了必填的 taskId）。I1 修复：
   * 这类调用此前被完全忽略——它没有信封，errorCode 是 null，走不到
   * TASK_NOT_FOUND 那条分支，taskIdLossEvents 数不到它们，导致模型每次都漏传
   * taskId 时 P-3 仍能 PASS。ObserveResult.isError 一直被忠实记录，只是从未被
   * report.ts 读过。
   */
  schemaRejections: number;
  /**
   * 已知 episode（jobId 非 null）里，轮询过至少一次、但最后一次轮询记录的
   * state 不是终态（passed/failed）的次数——「轮询但半途放弃」。与「压根没
   * 轮询」（polls.length === 0）和「轮询到终态」是三个互斥的桶，C1 修复要求
   * P-1 的文案把这一桶单独点出来，不能让它混进笼统的「非自主」。
   */
  abandonedRunEpisodes: number;
  /** remoteUa → 出现次数。端点公网可达，这是唯一能看出「非预期来源流量」的信号。 */
  byRemoteUa: Record<string, number>;
  /** 首条事件的 ISO 时间戳；events 为空时为 null。报告出处信息的一部分。 */
  firstEventIso: string | null;
  /** 末条事件的 ISO 时间戳；events 为空时为 null。报告出处信息的一部分。 */
  lastEventIso: string | null;
}

export function analyze(events: ObserveEvent[]): Analysis {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  const byTool: Record<string, number> = {};
  for (const e of sorted) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;

  // P-3：TASK_NOT_FOUND 是模型把 taskId 用丢的直接信号。此前的「基线 taskId」
  // 启发式会把合法开启的第二个任务也算作一次丢失（I2）；直接读响应里的错误码
  // 没有这个问题。distinctTaskIds / taskOpenCalls 只是给人看的背景信息。
  const taskIdLossEvents = sorted.filter((e) => e.result?.errorCode === "TASK_NOT_FOUND").length;
  const distinctTaskIds = new Set(
    sorted.map((e) => e.args.taskId).filter((v): v is string => typeof v === "string"),
  ).size;
  const taskOpenCalls = byTool.grande_task_open ?? 0;

  // I1：schema 级拒绝（zod 在 handler 运行前就拒绝参数，例如模型漏传了必填的
  // taskId）与 TASK_NOT_FOUND 是两回事：前者没有信封，errorCode 是 null，
  // 但 isError 一直被忠实记录，只是此前从没被读过。
  const schemaRejections = sorted.filter((e) => e.result?.isError === true).length;

  // remoteUa 一直被记录，但从未被展示过。端点公网可达，这是唯一能看出「非预期
  // 来源流量」的信号。
  const byRemoteUa: Record<string, number> = {};
  for (const e of sorted) {
    const key = e.remoteUa.trim().length > 0 ? e.remoteUa : "(空)";
    byRemoteUa[key] = (byRemoteUa[key] ?? 0) + 1;
  }

  const firstEventIso = sorted.length > 0 ? (sorted[0] as ObserveEvent).iso : null;
  const lastEventIso = sorted.length > 0 ? (sorted[sorted.length - 1] as ObserveEvent).iso : null;

  // P-5：只有「已经出现过至少一次 truncated:true 的响应」之后，携带 cursor/lineRange
  // 的调用才算「续读」。此前只看 args 有没有 cursor/lineRange，分不清"续读"与
  // "模型一上来就主动指定范围读"（I3）——两者在参数形状上完全一样，只有响应里的
  // truncated 标志能区分。
  let sawTruncatedResponse = false;
  let truncationOpportunities = 0;
  let truncationFollowUps = 0;
  for (const e of sorted) {
    const looksLikeContinuation = e.args.cursor !== undefined || e.args.lineRange !== undefined;
    if (looksLikeContinuation && sawTruncatedResponse) truncationFollowUps++;
    if (e.result?.truncated === true) {
      truncationOpportunities++;
      sawTruncatedResponse = true;
    }
  }

  // P-1：episode 的身份是 grande_run 响应里的 jobId。「拿不到 jobId」分两种，
  // 处理方式不同（详见 RunEpisode / Analysis 顶部注释）：确认失败（result 到了
  // 但明确没有 jobId）整体不生成 episode，只计入 confirmedFailedRunCalls；无法
  // 观测（result 整个缺失）不能排除，每次生成一个 jobId:null 的 fail-safe
  // episode，计入 unobservableRunCalls。grande_run_result 按它请求参数里的
  // jobId（args.jobId，工具的必填入参，不需要看响应）归属到对应 episode；匹配
  // 不到任何已知 jobId 的轮询计为孤立轮询，如实报告而不是静默丢弃——fail-safe
  // episode 的 jobId 未知，天然不会被任何轮询匹配到。
  interface EpisodeBuilder {
    jobId: string;
    runAt: number;
    polls: number[];
    /** 每次轮询记录的 state，与 polls 一一对应（C1 修复）。 */
    pollStates: (string | null)[];
  }

  const runCalls = sorted.filter((e) => e.tool === "grande_run");
  const confirmedFailedRunCalls = runCalls.filter(
    (e) => e.result !== undefined && typeof e.result.jobId !== "string",
  ).length;
  const unobservableRuns = runCalls.filter((e) => e.result === undefined);

  const builders: EpisodeBuilder[] = runCalls
    .filter((e) => typeof e.result?.jobId === "string")
    .map((e) => ({ jobId: e.result?.jobId as string, runAt: e.ts, polls: [], pollStates: [] }));

  const byJobId = new Map<string, EpisodeBuilder>();
  for (const b of builders) {
    // jobId 由 job_${randomUUID().slice(0,8)} 生成，POC 规模下撞车概率可忽略不计；
    // 但 Map.set 撞车会静默覆盖，让先到的 run 冻结在零轮询、伪造出一次假 FAIL
    // （Minor 发现 2）。保留先到的 builder、丢弃后到的重复 key——代价更小的一侧。
    if (!byJobId.has(b.jobId)) byJobId.set(b.jobId, b);
  }

  let orphanPolls = 0;
  for (const e of sorted) {
    if (e.tool !== "grande_run_result") continue;
    const jobId = typeof e.args.jobId === "string" ? e.args.jobId : undefined;
    const target = jobId !== undefined ? byJobId.get(jobId) : undefined;
    if (!target) {
      orphanPolls++;
      continue;
    }
    target.polls.push(e.ts);
    target.pollStates.push(e.result?.state ?? null);
  }

  const knownEpisodes: RunEpisode[] = builders.map((b) => {
    const marks = [b.runAt, ...b.polls];
    const gapsMs = marks.slice(1).map((ts, k) => ts - (marks[k] as number));
    const maxGapMs = gapsMs.length > 0 ? Math.max(...gapsMs) : Number.POSITIVE_INFINITY;
    const lastPollState = b.pollStates.length > 0 ? (b.pollStates[b.pollStates.length - 1] as string | null) : null;
    return {
      jobId: b.jobId,
      runAt: b.runAt,
      polls: b.polls,
      gapsMs,
      maxGapMs,
      lastPollState,
      // C1 修复：间隔够短不再够用，最后一次轮询记录的状态必须也到了终态
      // （passed/failed）——否则一次「轮询一下看到 running 就转头跟用户聊天」
      // 会被间隔条件单独判成自主轮询到底，而这正是被验证过的假 PASS 场景。
      autoPolled: b.polls.length > 0 && maxGapMs <= HUMAN_GAP_MS && isTerminalState(lastPollState),
    };
  });

  // 轮询过至少一次、但最后一次记录的状态不是终态——「轮询但半途放弃」，与
  // 「压根没轮询」和「轮询到终态」是三个互斥的桶（C1 修复，供 P-1 文案单独点名）。
  const abandonedRunEpisodes = knownEpisodes.filter(
    (e) => e.polls.length > 0 && !isTerminalState(e.lastPollState),
  ).length;

  // 无法观测的调用各自生成一个 fail-safe episode：jobId 未知、零轮询、
  // maxGapMs 为 ∞、autoPolled 为 false——刻意保守，把这次真假莫辨的调用当作
  // 「没被自主轮询」处理，而不是让它从证据里消失、造成假 PASS（详见「重要发现」
  // 修复）。
  const unobservableEpisodes: RunEpisode[] = unobservableRuns.map((e) => ({
    jobId: null,
    runAt: e.ts,
    polls: [],
    gapsMs: [],
    maxGapMs: Number.POSITIVE_INFINITY,
    lastPollState: null,
    autoPolled: false,
  }));

  const episodes = [...knownEpisodes, ...unobservableEpisodes].sort((a, b) => a.runAt - b.runAt);

  let longestChainWithoutGap = sorted.length > 0 ? 1 : 0;
  let current = sorted.length > 0 ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] as ObserveEvent).ts - (sorted[i - 1] as ObserveEvent).ts;
    current = gap <= HUMAN_GAP_MS ? current + 1 : 1;
    longestChainWithoutGap = Math.max(longestChainWithoutGap, current);
  }

  return {
    totalToolCalls: sorted.length,
    byTool,
    episodes,
    confirmedFailedRunCalls,
    unobservableRunCalls: unobservableRuns.length,
    orphanPolls,
    taskIdLossEvents,
    distinctTaskIds,
    taskOpenCalls,
    longestChainWithoutGap,
    truncationOpportunities,
    truncationFollowUps,
    schemaRejections,
    abandonedRunEpisodes,
    byRemoteUa,
    firstEventIso,
    lastEventIso,
  };
}

function verdict(pass: boolean): string {
  return pass ? "**PASS**" : "**FAIL**";
}

/** P-5 是三态的：从未触发截断时是「无法判定」，不是 FAIL——没测到的场景不算失败。 */
function p5Verdict(a: Analysis): string {
  if (a.truncationOpportunities === 0) return "未触发截断，无法判定";
  return verdict(a.truncationFollowUps > 0);
}

/**
 * P-3 也是三态的（I1 修复）：schema 级拒绝（zod 在 handler 运行前就拒绝了参数）
 * 意味着我们连这次调用带没带对 taskId 都无从判断——errorCode 是 null，根本走
 * 不到 TASK_NOT_FOUND 分支。这类调用存在时，taskIdLossEvents === 0 不能被当成
 * 「taskId 保持良好」的证据，必须至少停在「判定不充分」，不能侥幸 PASS。
 */
function p3Verdict(a: Analysis): string {
  if (a.schemaRejections > 0) return "判定不充分（存在 schema 级拒绝，见下）";
  return verdict(a.taskIdLossEvents === 0);
}

/** episode 表格「判定」列。M15 修复：无法观测的 fail-safe episode（jobId 为
 * null）此前和「真观测到但非自主」的 episode 渲染成同一个「非自主」，读者分不清
 * 「模型确实没轮询」和「日志根本没记下这次调用」。 */
function episodeVerdict(e: RunEpisode): string {
  if (e.jobId === null) return "无法观测";
  return e.autoPolled ? "自主" : "非自主";
}

export function renderMarkdown(a: Analysis, logPath: string | null = null): string {
  const autoPolledCount = a.episodes.filter((e) => e.autoPolled).length;
  const knownRunCount = a.episodes.length - a.unobservableRunCalls;
  const totalRunCalls = a.episodes.length + a.confirmedFailedRunCalls;
  // 空真守卫：零 episode 不能算「全部自主轮询」为真——不管是压根没调用过
  // grande_run，还是调用过但全部确认失败、一个 jobId 都没拿到（3 次 grande_run
  // 全部确认失败也一样落在这里），都没有「模型确实轮询过」的证据，必须是 FAIL，
  // 不能空真地判 PASS。无法观测的调用会生成 autoPolled:false 的 fail-safe
  // episode 计入 a.episodes，所以哪怕只有一次无法观测、其余全部完美自主轮询，
  // autoPolledCount 也会少于 a.episodes.length，同样正确地把判定拖向 FAIL——
  // 不确定就不能判 PASS，这正是这次修复要保证的方向。
  const p1Pass = a.episodes.length > 0 && autoPolledCount === a.episodes.length;

  const lines: string[] = [
    "# GrandeGPT POC 观测报告（自动生成部分）",
    "",
    // 报告出处：这份报告脱离生成它的原始日志之后极难追溯——round 之间日志文件
    // 互相覆盖、容易记混。没有这几行，读者没法确认这份报告到底对应哪一轮观测。
    `> 证据来源：\`${logPath ?? "未知（renderMarkdown 未收到 logPath）"}\`　·　事件数：**${a.totalToolCalls}**　·　首条事件：${a.firstEventIso ?? "—"}　·　末条事件：${a.lastEventIso ?? "—"}`,
    "",
    `工具调用总数：**${a.totalToolCalls}**　·　最长无人工间隔调用链：**${a.longestChainWithoutGap}**　·　Schema 级拒绝次数：**${a.schemaRejections}**（详见 P-3）`,
    "",
    "## 工具调用分布",
    "",
    "| 工具 | 次数 |",
    "|---|---|",
    ...Object.entries(a.byTool)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `| \`${k}\` | ${v} |`),
    "",
    // remoteUa 一直被记录但从未展示过；端点公网可达，这是唯一能看出「非预期
    // 来源流量」（爬虫、扫描器、非 ChatGPT 客户端）污染本次观测的信号。
    "## 来源 User-Agent 分布",
    "",
    "| remoteUa | 次数 |",
    "|---|---|",
    ...Object.entries(a.byRemoteUa)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `| \`${k}\` | ${v} |`),
    "",
    `## P-1 模型是否自主轮询 —— ${p1Pass ? "**PASS**（待人工确认：执行者未打字）" : "**FAIL**"}`,
    "",
    `共 ${totalRunCalls} 次 \`grande_run\` 调用：${a.confirmedFailedRunCalls} 次确认失败（业务失败或 MCP 协议级拒绝，响应到了但明确没有 jobId，从未真正开始过任务，已排除、不计入下表与本节判定），${a.unobservableRunCalls} 次响应无法观测（日志没能记录响应摘要——不代表调用失败，模型收到的原始响应可能完全正常，只是这条日志无法确认它是否创建了任务，因此不能排除，保守计入下表并按「未自主轮询」处理），剩余 ${knownRunCount} 次确认创建了任务的 run 里有 ${autoPolledCount} 次由模型自主轮询至终态（polled to completion）。` +
      (a.abandonedRunEpisodes > 0
        ? ` 另有 ${a.abandonedRunEpisodes} 次虽有轮询、但最后一次记录的状态并非终态（polled but abandoned——疑似模型半途转头去跟用户聊天或提前放弃，也可能是轮询记录不完整），不计入自主轮询。`
        : "") +
      (a.orphanPolls > 0
        ? ` 另有 ${a.orphanPolls} 次 \`grande_run_result\` 轮询的 jobId 未匹配到任何已知 run（孤立轮询，不计入下表，也不参与本节判定）。`
        : ""),
    "",
    "| # | jobId | 轮询次数 | 各次间隔(s) | 最大间隔(s) | 判定 |",
    "|---|---|---|---|---|---|",
    ...a.episodes.map(
      (e, i) =>
        `| ${i + 1} | \`${e.jobId ?? "未知"}\` | ${e.polls.length} | ${e.gapsMs.map((g) => (g / 1000).toFixed(1)).join(", ") || "—"} | ${
          Number.isFinite(e.maxGapMs) ? (e.maxGapMs / 1000).toFixed(1) : "∞"
        } | ${episodeVerdict(e)} |`,
    ),
    "",
    `> 判定规则：\`grande_run\` 到终态之间相邻间隔均 ≤ ${HUMAN_GAP_MS / 1000}s（= 2 × job 时长 ${JOB_DURATION_MS / 1000}s，见 src/jobs.ts 的 JOB_DURATION_MS）**且**最后一次轮询记录的 state 已到终态（passed/failed）才视为自主轮询；episode 按响应中的 jobId 归属轮询，不看日志中的先后位置。`,
    `> **须由执行者手工填写**：确认上表覆盖的每个 episode 的轮询期间，你没有主动打字或发送消息。若曾打字，请在此记下时刻与内容，并把上面的 PASS 视为无效重新判定：______________________`,
    "> **这只是证据的一半**，另一半是执行者在 PROTOCOL.md 中记录的「我何时打了字」。两者需一致。",
    "",
    "## P-2 额度消耗",
    "",
    "自动统计无法得知消耗了多少条额度（ChatGPT 不暴露该信息）。",
    "**须由执行者手工填写**：任务开始前后各查看一次额度提示，记录差值。",
    "",
    `## P-3 taskId 保持 —— ${p3Verdict(a)}`,
    "",
    `检测到 ${a.taskIdLossEvents} 次响应为 \`TASK_NOT_FOUND\`（模型用了一个已经不存在的 taskId，直接信号，不再靠启发式猜测）。`,
    `另检测到 ${a.schemaRejections} 次 MCP 协议级 schema 拒绝（\`isError:true\`——zod 校验在 handler 运行前就拒绝了参数，例如模型完全省略了必填的 taskId）。这类调用没有信封、errorCode 为 null，不会被上面的 TASK_NOT_FOUND 计数覆盖，但同样可能是 taskId（或其他必填参数）丢失的信号，需人工检查具体是哪次调用、缺了什么参数（I1 修复：此前完全不计入 P-3，模型每次都漏传 taskId 也能 PASS）。`,
    `信息补充：全程出现过 ${a.distinctTaskIds} 个不同的 taskId，对应 ${a.taskOpenCalls} 次 \`grande_task_open\` 调用——这两个数字本身不构成判定依据，合法的多任务并行会让它们都 >1。`,
    "",
    "## P-4 确认框次数",
    "",
    "自动统计无法观测 ChatGPT 端的确认框。**须由执行者手工填写**：记录弹框次数与「记住」后是否不再弹。",
    "",
    `## P-5 截断续读 —— ${p5Verdict(a)}`,
    "",
    a.truncationOpportunities === 0
      ? "本次观测没有任何响应触发 `truncated: true`，无法判断模型被截断后会不会主动续读——这是一个未测试到的场景，不是失败。"
      : `检测到 ${a.truncationOpportunities} 次响应被截断（\`truncated: true\`），其中 ${a.truncationFollowUps} 次之后出现了带 \`cursor\` 或 \`lineRange\` 的续读调用。`,
    "",
  ];
  return lines.join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const raw = readFileSync(observeLogPath(), "utf8");
  const events = raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ObserveEvent);
  process.stdout.write(renderMarkdown(analyze(events), observeLogPath()));
}
