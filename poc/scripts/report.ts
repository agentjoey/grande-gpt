import { readFileSync } from "node:fs";
import type { ObserveEvent } from "../src/observe.ts";
import { observeLogPath } from "../src/observe.ts";

/** 超过这个间隔就认为中间夹了人类操作，而非模型自主连续调用 */
const HUMAN_GAP_MS = 60_000;

export interface RunEpisode {
  jobId: string;
  runAt: number;
  polls: number[];
  gapsMs: number[];
  maxGapMs: number;
  resolved: boolean;
  autoPolled: boolean;
}

export interface Analysis {
  totalToolCalls: number;
  byTool: Record<string, number>;
  episodes: RunEpisode[];
  taskIdLossEvents: number;
  longestChainWithoutGap: number;
  truncationFollowUps: number;
}

export function analyze(events: ObserveEvent[]): Analysis {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  const byTool: Record<string, number> = {};
  for (const e of sorted) byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;

  // task_open 的 taskId 出现在返回值而非入参，因此以「后续调用中最早出现的 taskId」
  // 作为基线；此后任何使用其他 taskId 的调用都计为一次 taskId 丢失。
  const baseline = sorted.find((e) => typeof e.args.taskId === "string")?.args.taskId as string | undefined;

  let taskIdLossEvents = 0;
  let truncationFollowUps = 0;
  for (const e of sorted) {
    const tid = e.args.taskId;
    if (baseline !== undefined && typeof tid === "string" && tid !== baseline) taskIdLossEvents++;
    if (e.args.cursor !== undefined || e.args.lineRange !== undefined) truncationFollowUps++;
  }

  const episodes: RunEpisode[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i] as ObserveEvent;
    if (e.tool !== "grande_run") continue;

    // 收集本次 run 之后、下一次 run 之前的全部轮询
    const pollEvents: ObserveEvent[] = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const p = sorted[j] as ObserveEvent;
      if (p.tool === "grande_run") break;
      if (p.tool === "grande_run_result") pollEvents.push(p);
    }

    const polls = pollEvents.map((p) => p.ts);
    const marks = [e.ts, ...polls];
    const gapsMs = marks.slice(1).map((ts, k) => ts - (marks[k] as number));
    const maxGapMs = gapsMs.length > 0 ? Math.max(...gapsMs) : Number.POSITIVE_INFINITY;

    episodes.push({
      jobId: String(pollEvents[0]?.args.jobId ?? "?"),
      runAt: e.ts,
      polls,
      gapsMs,
      maxGapMs,
      resolved: polls.length > 0,
      autoPolled: polls.length > 0 && maxGapMs <= HUMAN_GAP_MS,
    });
  }

  let longestChainWithoutGap = sorted.length > 0 ? 1 : 0;
  let current = sorted.length > 0 ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] as ObserveEvent).ts - (sorted[i - 1] as ObserveEvent).ts;
    current = gap <= HUMAN_GAP_MS ? current + 1 : 1;
    longestChainWithoutGap = Math.max(longestChainWithoutGap, current);
  }

  return { totalToolCalls: sorted.length, byTool, episodes, taskIdLossEvents, longestChainWithoutGap, truncationFollowUps };
}

function verdict(pass: boolean): string {
  return pass ? "**PASS**" : "**FAIL**";
}

export function renderMarkdown(a: Analysis): string {
  const autoPolled = a.episodes.filter((e) => e.autoPolled).length;
  const p1Pass = a.episodes.length > 0 && autoPolled === a.episodes.length;

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
    `共 ${a.episodes.length} 次 \`grande_run\`，其中 ${autoPolled} 次由模型自主轮询至终态。`,
    "",
    "| # | 轮询次数 | 各次间隔(s) | 最大间隔(s) | 判定 |",
    "|---|---|---|---|---|",
    ...a.episodes.map(
      (e, i) =>
        `| ${i + 1} | ${e.polls.length} | ${e.gapsMs.map((g) => (g / 1000).toFixed(1)).join(", ") || "—"} | ${
          Number.isFinite(e.maxGapMs) ? (e.maxGapMs / 1000).toFixed(1) : "∞"
        } | ${e.autoPolled ? "自主" : "非自主"} |`,
    ),
    "",
    `> 判定规则：\`grande_run\` 到终态之间相邻间隔均 ≤ ${HUMAN_GAP_MS / 1000}s 视为自主轮询。`,
    "> **这只是证据的一半**，另一半是执行者在 PROTOCOL.md 中记录的「我何时打了字」。两者需一致。",
    "",
    "## P-2 额度消耗",
    "",
    "自动统计无法得知消耗了多少条额度（ChatGPT 不暴露该信息）。",
    "**须由执行者手工填写**：任务开始前后各查看一次额度提示，记录差值。",
    "",
    `## P-3 taskId 保持 —— ${verdict(a.taskIdLossEvents === 0)}`,
    "",
    `检测到 ${a.taskIdLossEvents} 次使用了非基线 taskId 的调用。`,
    "",
    "## P-4 确认框次数",
    "",
    "自动统计无法观测 ChatGPT 端的确认框。**须由执行者手工填写**：记录弹框次数与「记住」后是否不再弹。",
    "",
    `## P-5 截断续读 —— ${verdict(a.truncationFollowUps > 0)}`,
    "",
    `检测到 ${a.truncationFollowUps} 次带 \`cursor\` 或 \`lineRange\` 的续读调用。`,
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
