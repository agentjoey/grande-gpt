import { readFileSync } from "node:fs";
import type { ObserveEvent } from "../src/observe.ts";
import { observeLogPath } from "../src/observe.ts";

/** 超过这个间隔就认为中间夹了人类操作，而非模型自主连续调用 */
const HUMAN_GAP_MS = 60_000;

/**
 * 一次 grande_run 及其后续轮询。身份是响应里回传的 jobId（见 observe.ts 的
 * ObserveResult），不是它在日志里的位置——按位置切分曾经是个 bug（I1）：
 * 模型抢跑连开两个 run 时，晚到的第一个 run 的轮询会被位置法错配给第二个 run，
 * 能把从未被轮询过的 run 伪造成 autoPolled:true。
 *
 * jobId 为 null 表示这次 grande_run 的日志行没有响应摘要（Task 6 修复前写入的
 * 旧格式日志，或响应解析失败）——此时这次 run 无法归属任何轮询，polls 恒为空。
 */
export interface RunEpisode {
  jobId: string | null;
  runAt: number;
  polls: number[];
  gapsMs: number[];
  maxGapMs: number;
  autoPolled: boolean;
}

export interface Analysis {
  totalToolCalls: number;
  byTool: Record<string, number>;
  episodes: RunEpisode[];
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

  // P-1：episode 的身份是 grande_run 响应里的 jobId。grande_run_result 按它
  // 请求参数里的 jobId（args.jobId，工具的必填入参，不需要看响应）归属到对应
  // episode；匹配不到任何已知 jobId 的轮询计为孤立轮询，如实报告而不是静默丢弃。
  interface EpisodeBuilder {
    jobId: string | null;
    runAt: number;
    polls: number[];
  }

  const builders: EpisodeBuilder[] = sorted
    .filter((e) => e.tool === "grande_run")
    .map((e) => ({ jobId: e.result?.jobId ?? null, runAt: e.ts, polls: [] }));

  const byJobId = new Map<string, EpisodeBuilder>();
  for (const b of builders) if (b.jobId !== null) byJobId.set(b.jobId, b);

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
  }

  const episodes: RunEpisode[] = builders.map((b) => {
    const marks = [b.runAt, ...b.polls];
    const gapsMs = marks.slice(1).map((ts, k) => ts - (marks[k] as number));
    const maxGapMs = gapsMs.length > 0 ? Math.max(...gapsMs) : Number.POSITIVE_INFINITY;
    return {
      jobId: b.jobId,
      runAt: b.runAt,
      polls: b.polls,
      gapsMs,
      maxGapMs,
      autoPolled: b.polls.length > 0 && maxGapMs <= HUMAN_GAP_MS,
    };
  });

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
    orphanPolls,
    taskIdLossEvents,
    distinctTaskIds,
    taskOpenCalls,
    longestChainWithoutGap,
    truncationOpportunities,
    truncationFollowUps,
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

export function renderMarkdown(a: Analysis): string {
  const autoPolledCount = a.episodes.filter((e) => e.autoPolled).length;
  // 空真守卫：零 episode 不能算「全部自主轮询」为真——一次 grande_run 都没有
  // 发生过，就没有证据支持 PASS，必须是 FAIL。
  const p1Pass = a.episodes.length > 0 && autoPolledCount === a.episodes.length;

  const lines: string[] = [
    "# GrandeGPT POC 观测报告（自动生成部分）",
    "",
    `工具调用总数：**${a.totalToolCalls}**　·　最长无人工间隔调用链：**${a.longestChainWithoutGap}**`,
    "",
    "## 工具调用分布",
    "",
    "| 工具 | 次数 |",
    "|---|---|",
    ...Object.entries(a.byTool)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `| \`${k}\` | ${v} |`),
    "",
    `## P-1 模型是否自主轮询 —— ${verdict(p1Pass)}`,
    "",
    `共 ${a.episodes.length} 次 \`grande_run\`，其中 ${autoPolledCount} 次由模型自主轮询至终态。` +
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
        } | ${e.autoPolled ? "自主" : "非自主"} |`,
    ),
    "",
    `> 判定规则：\`grande_run\` 到终态之间相邻间隔均 ≤ ${HUMAN_GAP_MS / 1000}s 视为自主轮询；episode 按响应中的 jobId 归属轮询，不看日志中的先后位置。`,
    "> **这只是证据的一半**，另一半是执行者在 PROTOCOL.md 中记录的「我何时打了字」。两者需一致。",
    "",
    "## P-2 额度消耗",
    "",
    "自动统计无法得知消耗了多少条额度（ChatGPT 不暴露该信息）。",
    "**须由执行者手工填写**：任务开始前后各查看一次额度提示，记录差值。",
    "",
    `## P-3 taskId 保持 —— ${verdict(a.taskIdLossEvents === 0)}`,
    "",
    `检测到 ${a.taskIdLossEvents} 次响应为 \`TASK_NOT_FOUND\`（模型用了一个已经不存在的 taskId，直接信号，不再靠启发式猜测）。`,
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
  process.stdout.write(renderMarkdown(analyze(events)));
}
