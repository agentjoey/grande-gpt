import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { inspectBaseStatus } from "./baseStatus.ts";
import { classifyDevelopmentRisk } from "./developmentRisk.ts";
import { projectDeliveryTargetProgress, resolveDeliveryTarget } from "./deliveryTarget.ts";
import { err, ok, type Envelope } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import { TERMINAL } from "./jobs.ts";
import { assertTaskId } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import {
  decodeStatusCursor, encodeStatusCursor, publicStatusRow, readStatusPage, statusScope,
  type StatusCursor, type StatusRow, type StatusView,
} from "./statusPages.ts";
import { compactTaskProgress, projectTaskProgress, type TaskProgress } from "./taskProgress.ts";
import { getTask, type TaskRow } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";
import { listChangedFiles } from "./worktree.ts";

// Reserve the remaining MCP budget for runtime/activation/verifier metadata added by tools.ts.
const PAGE_BYTES = 20 * 1024;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const BRIEF_CHARS = 1024;
const VIEWS: readonly StatusView[] = ["overview", "detail", "jobs", "attestations", "brief"];

function deliveredBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] }));
}
function bounded(envelope: Envelope<Record<string, unknown>>) {
  if (deliveredBytes(envelope) > PAGE_BYTES) {
    throw new StateError("RESOURCE_EXHAUSTED", "单条 status 超出响应预算；请使用更窄的 history view，不截断 blocker 或证据。");
  }
  return { structuredContent: envelope };
}

function progressFor(deps: ToolDeps, task: TaskRow, mode: "manual" | "auto") {
  const deliveryTarget = resolveDeliveryTarget(deps.db, task);
  const progress = projectDeliveryTargetProgress(
    projectTaskProgress(deps.db, task, { hostVerificationMode: mode }), deliveryTarget, task.taskId,
  );
  let filesChanged: number | null = null;
  let developmentRisk: ReturnType<typeof classifyDevelopmentRisk> = "L3";
  if (!(task.state === "CLOSED" && progress.completed && !progress.cleanupRequired)) {
    try {
      const changed = listChangedFiles(task.worktreePath, task.baseCommit);
      filesChanged = changed.length;
      developmentRisk = classifyDevelopmentRisk(changed);
    } catch { /* unknown state remains L3, never a claim of safety */ }
  }
  return { progress, filesChanged, developmentRisk, deliveryTarget };
}

function preview(db: DatabaseSync, view: "jobs" | "attestations", taskId: string) {
  const page = readStatusPage(db, view, taskId, 5, null);
  return { rows: page.rows.slice(0, 5).map(publicStatusRow), more: page.rows.length > 5 };
}

function briefAvailable(db: DatabaseSync, taskId: string): boolean {
  return db.prepare("SELECT 1 FROM task_brief WHERE taskId=?").get(taskId) !== undefined;
}

function detail(deps: ToolDeps, task: TaskRow, mode: "manual" | "auto") {
  const { progress, filesChanged, developmentRisk, deliveryTarget } = progressFor(deps, task, mode);
  let base: unknown;
  if (task.state === "CLOSED" && progress.completed && !progress.cleanupRequired) {
    base = { relation: "archived", detail: "Task 已关闭，worktree 已清理；不再比较本地 HEAD" };
  } else {
    try { base = inspectBaseStatus(deps.layout, task); }
    catch (error) { base = { error: redact(error instanceof Error ? error.message : String(error), [deps.layout.workspaceRoot, deps.layout.controlRoot]) }; }
  }
  const recovery = !progress.completed && !existsSync(task.worktreePath)
    ? "worktree 缺失；运行 grande gc 只读对账，不要直接清理。" : "";
  const jobs = preview(deps.db, "jobs", task.taskId);
  const attestations = preview(deps.db, "attestations", task.taskId);
  return bounded(ok({ taskId: task.taskId,
    data: { view: "detail", taskId: task.taskId, repoId: task.repoId, branch: task.branch,
      state: task.state, baseCommit: task.baseCommit, filesChanged, base,
      recentJobs: jobs.rows, attestations: attestations.rows, progress, deliveryTarget, developmentRisk,
      briefAvailable: briefAvailable(deps.db, task.taskId),
      moreJobs: jobs.more, moreAttestations: attestations.more,
    },
    hint: `deliveryTarget=${deliveryTarget}；${compactTaskProgress(progress)}；下一步：${progress.nextAction}。${recovery}历史用 view=jobs/attestations；任务说明用 view=brief。`,
  }));
}

function compactProgress(progress: TaskProgress) {
  return {
    phase: progress.phase, taskHead: progress.taskHead, completed: progress.completed, blocker: progress.blocker,
    nextAction: progress.nextAction, localState: progress.localState,
    stages: Object.fromEntries(Object.entries(progress.stages).map(([name, stage]) => [name, { state: stage.state }])),
    cleanupRequired: progress.cleanupRequired, cleanupEligibility: progress.cleanupEligibility,
    liveness: progress.liveness, hostVerification: progress.hostVerification,
    ...(progress.deliveryAuthorization ? { deliveryAuthorization: progress.deliveryAuthorization } : {}),
  };
}

function overviewItem(deps: ToolDeps, taskId: string, mode: "manual" | "auto") {
  const task = getTask(deps.db, taskId);
  if (!task) throw new StateError("STALE_STATE", "任务在读取页面时消失，请重新查询。");
  const fields = { taskId, repoId: task.repoId, branch: task.branch, state: task.state };
  try {
    const { progress, filesChanged, developmentRisk, deliveryTarget } = progressFor(deps, task, mode);
    const terminal = [...TERMINAL];
    const condition = `taskId=? AND state NOT IN (${terminal.map(() => "?").join(",")})`;
    const live = deps.db.prepare(`SELECT jobId,profile,state FROM job WHERE ${condition} ORDER BY rowid DESC LIMIT 5`)
      .all(taskId, ...terminal);
    const liveCount = deps.db.prepare(`SELECT COUNT(*) n FROM job WHERE ${condition}`)
      .get(taskId, ...terminal) as { n: number };
    return { ...fields, filesChanged, developmentRisk, deliveryTarget,
      progress: compactProgress(progress), liveJobs: live, liveJobsTruncated: liveCount.n > live.length };
  } catch (error) {
    const reason = redact(error instanceof Error ? error.message : String(error), [deps.layout.workspaceRoot, deps.layout.controlRoot]);
    return { ...fields, filesChanged: null, developmentRisk: "L3", progress: {
      phase: "unknown", completed: false, blocker: `status: ${reason}`,
      nextAction: "读取该 task 详情，修复缺失或冲突的证据；禁止自动清理。",
      cleanupEligibility: { eligible: false, reason: "状态无法确认" },
    } };
  }
}

function recordPage(
  deps: ToolDeps, view: "overview" | "jobs" | "attestations", taskId: string | null,
  size: number, scope: string, cursor: StatusCursor | null, mode: "manual" | "auto",
) {
  const page = readStatusPage(deps.db, view, taskId, size, cursor);
  const key = view === "overview" ? "activeTasks" : view;
  const items: unknown[] = [];
  const registered = view === "overview" ? [...registeredIds(deps.layout)].sort() : [];
  const data: Record<string, unknown> = { view, [key]: items, order: "insertion-desc" };
  if (view === "overview") {
    data.registeredRepos = registered.slice(0, 100);
    data.registeredReposTruncated = registered.length > 100;
  }
  let last: StatusRow | undefined;
  const envelope = ok({ taskId, data,
    hint: "使用 nextCursor 续取同一 view/task。新插入记录不加入当前序列；任务状态仍按每次请求现查。",
  });
  for (const row of page.rows.slice(0, size)) {
    const item = view === "overview" ? overviewItem(deps, row.taskId as string, mode) : publicStatusRow(row);
    items.push(item);
    envelope.truncated = true;
    envelope.nextCursor = encodeStatusCursor({ scope, ceiling: page.ceiling, before: row._row });
    if (deliveredBytes(envelope) > PAGE_BYTES) {
      items.pop();
      if (!last) throw new StateError("RESOURCE_EXHAUSTED", "单条 status/history 超出预算；未省略 blocker，请读取对应 task/job 的窄详情。");
      break;
    }
    last = row;
  }
  const more = items.length < page.rows.length;
  envelope.truncated = more;
  envelope.nextCursor = more && last ? encodeStatusCursor({ scope, ceiling: page.ceiling, before: last._row }) : null;
  return bounded(envelope);
}

function briefPage(deps: ToolDeps, taskId: string, scope: string, cursor: StatusCursor | null) {
  const row = deps.db.prepare("SELECT updatedAt,length(briefJson) chars FROM task_brief WHERE taskId=?")
    .get(taskId) as { updatedAt: number; chars: number } | undefined;
  if (!row) throw new StateError("INVALID_INPUT", "此 task 没有保存 TaskBrief。");
  if (cursor && (cursor.ceiling !== row.updatedAt || cursor.before >= row.chars)) {
    throw new StateError("STALE_STATE", "TaskBrief 已更新或 cursor 越界；请从首页重新读取。");
  }
  const offset = cursor?.before ?? 0;
  const chunk = deps.db.prepare("SELECT substr(briefJson,?,?) content FROM task_brief WHERE taskId=? AND updatedAt=?")
    .get(offset + 1, BRIEF_CHARS, taskId, row.updatedAt) as { content: string } | undefined;
  if (!chunk) throw new StateError("STALE_STATE", "TaskBrief 在读取期间变化。");
  const next = offset + Array.from(chunk.content).length;
  const more = next < row.chars;
  return bounded(ok({ taskId, data: { view: "brief", content: chunk.content, encoding: "json-text", offset },
    truncated: more, nextCursor: more ? encodeStatusCursor({ scope, ceiling: row.updatedAt, before: next }) : null,
    hint: "按顺序拼接 content 后解析 JSON；保留 nextCursor 直到完整读取。",
  }));
}

/** One public status implementation replaces the old eager wrapper chain, rather than trimming its output. */
export function createTaskStatusTool(deps: ToolDeps, mode: "manual" | "auto" = "manual"): ToolDef {
  return {
    name: "grande_task_status",
    description: "有界任务概览或指定 task 详情。overview 默认分页活跃任务；jobs/attestations 分页历史；brief 分块读取任务说明。所有状态只读，使用返回的 cursor 续取。",
    inputSchema: { type: "object", properties: {
      taskId: { type: "string", description: "任务ID；detail/jobs/attestations/brief 必须指定" },
      view: { type: "string", enum: [...VIEWS], description: "不传时：有 taskId 为 detail，否则 overview" },
      pageSize: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, description: "记录页条数，默认10，上限50；字节预算可缩小页面。brief 固定分块。" },
      cursor: { type: "string", description: "上一页的 nextCursor，必须保持相同 view/task" },
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args) => {
      const taskId = typeof args.taskId === "string" ? args.taskId : null;
      try {
        if (taskId !== null) assertTaskId(taskId);
        const view = (args.view ?? (taskId === null ? "overview" : "detail")) as StatusView;
        if (!VIEWS.includes(view) || (view === "overview" ? taskId !== null : taskId === null)) {
          throw new StateError("INVALID_INPUT", "overview 不接受 taskId；其余 view 必须绑定 taskId。");
        }
        const size = args.pageSize ?? DEFAULT_PAGE_SIZE;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
          throw new StateError("INVALID_INPUT", "pageSize 必须是 1–50 的整数。");
        }
        const task = taskId === null ? undefined : getTask(deps.db, taskId);
        if (taskId !== null && !task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
        if (view === "detail") {
          if (args.cursor !== undefined) throw new StateError("INVALID_INPUT", "detail 使用有界预览；历史续取请指定对应 view。");
          return detail(deps, task!, mode);
        }
        const scope = statusScope(deps.layout, view, taskId);
        const cursor = decodeStatusCursor(args.cursor as string | undefined, scope);
        return view === "brief" ? briefPage(deps, taskId!, scope, cursor)
          : recordPage(deps, view, taskId, size, scope, cursor, mode);
      } catch (error) {
        const failure = toToolError(error);
        failure.message = redact(failure.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
        return { structuredContent: err({ ...failure, taskId }) };
      }
    },
  };
}
