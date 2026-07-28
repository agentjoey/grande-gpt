import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ok, err, type TaskContext } from "./envelope.ts";
import { toToolError, redact, StateError } from "./errors.ts";
import { resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { getTask, listActiveTasks, createTask } from "./tasks.ts";
import { getJob, listJobs } from "./jobs.ts";
import { jobReport, jobStateToError, startJob } from "./runner.ts";
import { repoRead } from "./repoFile.ts";
import { repoEdit, type EditOp } from "./repoFile.ts";
import { repoSearch } from "./repoSearch.ts";
import { repoMap } from "./repoMap.ts";
import { listChangedFiles, repoDiff, openWorktree } from "./worktree.ts";
import type { Layout } from "./layout.ts";
import { loadDenyRules } from "./policy.ts";
import { beginAudit } from "./audit.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  handler: (args: Record<string, unknown>) => Promise<{ structuredContent: unknown }>;
}

export interface ToolDeps {
  db: DatabaseSync;
  layout: Layout;
  repoId: string;
}

function makeTaskContext(db: DatabaseSync, layout: Layout, taskId: string): TaskContext | null {
  const t = getTask(db, taskId);
  if (!t) return null;
  const jobs = listJobs(db, taskId);
  return {
    branch: t.branch,
    filesChanged: listChangedFiles(t.worktreePath, t.baseCommit).length,
    lastJob: jobs.length > 0 ? `${jobs[0]!.jobId} (${jobs[0]!.state})` : null,
  };
}

function wrap(deps: ToolDeps, taskId: string | null, fn: () => unknown): { structuredContent: unknown } {
  try {
    const data = fn();
    // 如果 fn 已经返回了 envelope（比如 ok/err），直接用它
    if (data && typeof data === "object" && "ok" in (data as Record<string, unknown>)) {
      const env = data as Record<string, unknown>;
      // 确保 taskContext 存在
      if (!env.taskContext && taskId) {
        (env as { taskContext: unknown }).taskContext = makeTaskContext(deps.db, deps.layout, taskId);
      }
      return { structuredContent: env };
    }
    const ctx = taskId ? makeTaskContext(deps.db, deps.layout, taskId) : null;
    return { structuredContent: ok({ taskId, data, hint: "", taskContext: ctx }) };
  } catch (e) {
    const te = toToolError(e);
    te.message = redact(te.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
    if (te.code === "TASK_NOT_FOUND") {
      te.details.activeTasks = listActiveTasks(deps.db).map((t) => ({
        taskId: t.taskId,
        branch: t.branch,
        filesChanged: listChangedFiles(t.worktreePath, t.baseCommit).length,
      }));
    }
    return { structuredContent: err({ ...te, taskId }) };
  }
}

export function buildTools(deps: ToolDeps): ToolDef[] {
  const { db, layout, repoId } = deps;
  const repoRoot = resolveRepoPath(layout, repoId, registeredIds(layout));

  return [
    {
      name: "grande_task_status",
      description: "查询指定 task 的状态：分支、state、变更文件数、最近 job 状态",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "任务ID" },
        },
        required: ["taskId"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, args.taskId as string, () => {
          const taskId = args.taskId as string;
          const t = getTask(db, taskId);
          if (!t) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
          const jobs = listJobs(db, taskId);
          const filesChanged = listChangedFiles(t.worktreePath, t.baseCommit).length;
          const recentJobs = jobs.slice(0, 5).map((j) => ({
            jobId: j.jobId,
            state: j.state,
            profile: j.profile,
            exitCode: j.exitCode,
          }));
          return ok({
            taskId,
            data: {
              taskId: t.taskId,
              repoId: t.repoId,
              branch: t.branch,
              state: t.state,
              baseCommit: t.baseCommit,
              filesChanged,
              recentJobs,
            },
            hint: `任务 ${taskId} 当前状态：${t.state}，${filesChanged} 个文件已变更，` +
              `${recentJobs.length} 个 job 记录`,
            taskContext: makeTaskContext(db, layout, taskId),
          });
        }),
    },
    {
      name: "grande_repo_map",
      description: "列出仓库目录结构，识别关键文件（package.json/tsconfig.json/测试目录等）",
      inputSchema: {
        type: "object",
        properties: {
          maxEntries: { type: "number", description: "单次返回的最大条目数（默认500）" },
          cursor: { type: "string", description: "分页游标，来自上一页的 nextCursor" },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, null, () => {
          const r = repoMap(repoRoot, {
            maxEntries: args.maxEntries as number | undefined,
            cursor: args.cursor as string | null | undefined,
          });
          return ok({
            data: r,
            hint: r.truncated
              ? `共返回 ${r.entries.length} 个条目（已截断），续取请带 nextCursor: ${r.nextCursor}`
              : `共 ${r.entries.length} 个条目`,
            truncated: r.truncated,
            nextCursor: r.nextCursor,
          });
        }),
    },
    {
      name: "grande_repo_search",
      description: "在仓库中搜索字面量（非正则），返回匹配行与上下文，支持分页与时间预算",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "要搜索的字面量文本（不支持正则）" },
          maxMatches: { type: "number", description: "单次返回的最大匹配数（默认50）" },
          budgetMs: { type: "number", description: "时间预算，毫秒（默认4000）" },
          cursor: { type: "string", description: "分页游标" },
        },
        required: ["pattern"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, null, () => {
          const r = repoSearch(repoRoot, args.pattern as string, {
            maxMatches: args.maxMatches as number | undefined,
            budgetMs: args.budgetMs as number | undefined,
            cursor: args.cursor as string | null | undefined,
          });
          return ok({
            data: r,
            hint: r.timedOut
              ? `时间预算用尽，已返回 ${r.matches.length} 条匹配（可能不完整），续取请带 nextCursor: ${r.nextCursor}`
              : r.truncated
                ? `已返回 ${r.matches.length} 条匹配（已截断），续取请带 nextCursor: ${r.nextCursor}`
                : `共 ${r.matches.length} 条匹配`,
            truncated: r.truncated,
            nextCursor: r.nextCursor,
          });
        }),
    },
    {
      name: "grande_repo_read",
      description: "读取仓库内文件内容，支持行区间与字节上限",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "仓库内的相对文件路径" },
          maxBytes: { type: "number", description: "最大返回字节数（默认64KB）" },
          lineRange: {
            type: "array",
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
            description: "行区间 [from, to]，1-based",
          },
        },
        required: ["path"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, null, () => {
          let lineRange: [number, number] | undefined;
          const lr = args.lineRange as [number, number] | undefined;
          if (lr) lineRange = [lr[0], lr[1]];
          const r = repoRead(repoRoot, args.path as string, {
            maxBytes: args.maxBytes as number | undefined,
            lineRange,
          });
          return ok({
            data: r,
            hint: r.truncated
              ? `文件 ${r.path}（${r.totalLines} 行，${r.bytes} 字节），内容已截断（返回了 ${Buffer.byteLength(r.content, "utf8")} 字节）`
              : `文件 ${r.path}（${r.totalLines} 行，${r.bytes} 字节）`,
              truncated: r.truncated,
            });
          }),
      },
      {
        name: "grande_task_open",
        description: "为新任务创建 worktree 和分支，准备沙箱执行环境",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "任务ID" },
            slug: { type: "string", description: "任务简称（1–40 个小写字母、数字或连字符）" },
          },
          required: ["taskId", "slug"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: async (args) =>
          wrap(deps, args.taskId as string, () => {
            const taskId = args.taskId as string;
            const slug = args.slug as string;
            const wt = openWorktree(layout, repoId, slug, taskId);
            const t = createTask(db, {
              taskId, repoId, branch: wt.branch, baseCommit: wt.baseCommit,
              worktreePath: wt.worktreePath, state: "READY",
            });
            return ok({
              taskId,
              data: { taskId: t.taskId, branch: t.branch, baseCommit: t.baseCommit, worktreePath: t.worktreePath },
              hint: `已创建任务 ${t.taskId}，分支 ${t.branch}，worktree：${t.worktreePath}`,
              taskContext: makeTaskContext(db, layout, taskId),
            });
          }),
      },
      {
        name: "grande_run",
        description: "在沙箱中异步执行一个 profile 命令，立即返回 jobId 供后续查询",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "关联的任务ID" },
            profile: { type: "string", description: "要执行的 profile 名称" },
          },
          required: ["taskId", "profile"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: async (args) =>
          wrap(deps, args.taskId as string, () => {
            const taskId = args.taskId as string;
            const profileName = args.profile as string;
            const t = getTask(db, taskId);
            if (!t) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
            const rules = loadDenyRules(layout);
            const h = beginAudit(db, { taskId, tool: "grande_run", input: { profile: profileName } });
            h.allowed();
            const s = startJob(
              { db, layout },
              { taskId, repoId, worktreePath: t.worktreePath, profileName },
              h,
            );
            return ok({
              taskId,
              data: { jobId: s.jobId, state: s.state, pollAfterSeconds: s.pollAfterSeconds },
              hint: `Job ${s.jobId} 已启动（profile: ${profileName}），` +
                `稍后可通过 grande_run_result 查询结果，轮询间隔约 ${s.pollAfterSeconds} 秒`,
              taskContext: makeTaskContext(db, layout, taskId),
            });
          }),
      },
      {
        name: "grande_repo_edit",
        description: "批量修改仓库文件：create（新建）、modify（修改，需要 expectedSha256 防冲突）、move（移动）。不支持删除",
        inputSchema: {
          type: "object",
          properties: {
            ops: {
              type: "array",
              items: { type: "object" },
              description: "修改操作数组，每项含 op/create/modify/move 等字段",
            },
            taskId: { type: "string", description: "可选的任务ID，关联审计记录" },
          },
          required: ["ops"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: async (args) =>
          wrap(deps, (args.taskId as string) ?? null, () => {
            const ops = args.ops as EditOp[];
            const rules = loadDenyRules(layout);
            const h = beginAudit(db, { taskId: (args.taskId as string) ?? null, tool: "grande_repo_edit", input: { ops } });
            h.allowed();
            const r = repoEdit(repoRoot, ops, rules, h);
            const paths = r.applied.map((a) => a.path);
            return ok({
              taskId: (args.taskId as string | undefined),
              data: r,
              hint: `已应用 ${r.applied.length} 个操作：${paths.join(", ")}`,
              taskContext: (args.taskId as string) ? makeTaskContext(db, layout, args.taskId as string) : null,
            });
          }),
      },
      {
        name: "grande_diff",
      description: "查看任务 worktree 相对 base 的改动（diff），按文件分页",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "任务ID" },
          maxLines: { type: "number", description: "最大返回行数（默认400）" },
          cursor: { type: "string", description: "分页游标" },
        },
        required: ["taskId"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, args.taskId as string, () => {
          const taskId = args.taskId as string;
          const t = getTask(db, taskId);
          if (!t) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
          const r = repoDiff(t.worktreePath, t.baseCommit, {
            maxLines: args.maxLines as number | undefined,
            cursor: args.cursor as string | null | undefined,
          });
          return ok({
            taskId,
            data: r,
            hint: r.truncated
              ? `已返回 ${r.files.length} 个文件的 diff（已截断），续取请带 nextCursor: ${r.nextCursor}`
              : `共 ${r.files.length} 个文件有改动`,
            truncated: r.truncated,
            nextCursor: r.nextCursor,
            taskContext: makeTaskContext(db, layout, taskId),
          });
        }),
    },
    {
      name: "grande_run_result",
      description: "获取指定 job 的执行结果与日志尾部",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "作业ID" },
        },
        required: ["jobId"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, null, () => {
          const jobId = args.jobId as string;
          const r = jobReport(db, jobId);
          const j = getJob(db, jobId);
          const taskId = j?.taskId ?? null;
          const jobErr = jobStateToError(r);
          if (jobErr) {
            return err({ code: jobErr.code, message: jobErr.message, retryable: jobErr.retryable, details: jobErr.details, taskId });
          }
          return ok({
            taskId,
            data: r,
            hint: r.state === "running"
              ? `Job ${jobId} 仍在运行中`
              : `Job ${jobId} 状态：${r.state}${r.exitCode !== null ? `，exitCode: ${r.exitCode}` : ""}${r.networkDenied ? "（疑似网络被拒——启发式判定，非沙箱权威信号）" : ""}`,
            truncated: r.truncated,
            taskContext: taskId ? makeTaskContext(db, layout, taskId) : null,
          })
        }),
    },
  ];
}
