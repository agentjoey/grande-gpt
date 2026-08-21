import type { DatabaseSync } from "node:sqlite";
import { ok, err, type TaskContext } from "./envelope.ts";
import { toToolError, redact, StateError } from "./errors.ts";
import { PathSecurityError, resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { getTask, listActiveTasks, createTask, updateTaskState } from "./tasks.ts";
import { loadProfiles } from "./profiles.ts";
import { getJob, listJobs, TERMINAL } from "./jobs.ts";
import { JOB_RESULT_WAIT_MS, waitForTerminalJob } from "./jobWait.ts";
import { jobReport, jobStateToError, startJob } from "./runner.ts";
import { DEFAULT_REPO_READ_BYTES, repoEdit, repoRead, type EditOp } from "./repoFile.ts";
import { repoSearch } from "./repoSearch.ts";
import { repoMap } from "./repoMap.ts";
import { listChangedFiles, repoDiff, openWorktree, removeWorktree } from "./worktree.ts";
import type { Layout } from "./layout.ts";
import { assertPairedEditsSatisfied, loadEffectiveDenyRules } from "./policy.ts";
import { beginAudit } from "./audit.ts";
import { CheckpointError, restoreCheckpoint } from "./checkpoint.ts";

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
  /**
   * D18：单一端点之后，工具不再固定绑在一个 repo 上——写/跑路径从 `taskId`
   * 逐次推导（见 `resolveWriteRepo` 的调用点），只读工具在没有 `taskId` 时
   * 逐次从显式 `repoId` 参数或这里的 `defaultRepoId` 解析根目录。
   *
   * `defaultRepoId` 只在通过旧 `/mcp/:repoId` 别名路由进入时才有值（`server.ts`
   * 的 `handleMcp` 透传路径段），单一 `/mcp` 端点下始终是 `undefined`。它只是
   * 「没给 repoId 时的缺省」——**绝不覆盖**由 `taskId` 推导出的仓库。
   */
  defaultRepoId?: string;
}

function makeTaskContext(db: DatabaseSync, layout: Layout, taskId: string): TaskContext | null {
  const t = getTask(db, taskId);
  if (!t) return null;
  const jobs = listJobs(db, taskId);
  try {
    return {
      branch: t.branch,
      filesChanged: listChangedFiles(t.worktreePath, t.baseCommit).length,
      lastJob: jobs.length > 0 ? `${jobs[0]!.jobId} (${jobs[0]!.state})` : null,
    };
  } catch {
    return null;
  }
}

function activeTaskSummary(task: ReturnType<typeof listActiveTasks>[number]): {
  taskId: string;
  branch: string;
  filesChanged: number | null;
} {
  let filesChanged: number | null = null;
  try {
    filesChanged = listChangedFiles(task.worktreePath, task.baseCommit).length;
  } catch {
    // Error enrichment must never replace the original tool error. A missing
    // worktree is reported as an unknown count and remains visible by task id.
  }
  return { taskId: task.taskId, branch: task.branch, filesChanged };
}

/**
 * 只读工具（repo_map/repo_search/repo_read）的根目录解析。D18 之前这只需要
 * 在「带 taskId」与「不带 taskId（读固定的那一个 repoId）」之间二选一；
 * 单一端点之后没有「固定的那一个」了，多了两件事要做：
 *
 * 1. 没有 taskId 时，根目录来自显式 `repoId` 参数，或（旧别名路由下）
 *    `defaultRepoId`；两者都没有就是一个「模型不知道该看哪个仓库」的真实
 *    状态，必须给出**可操作**的错误——列出已注册仓库，而不是一句「缺参数」。
 * 2. **taskId 与 repoId 同时给出且不一致时拒绝**，不静默择一——模型的意图
 *    含糊时，猜一个方向永远不如让它把话说清楚（尤其是这里猜错的后果是读到
 *    了错误仓库的内容却毫无察觉）。
 *
 * 带 taskId 时该读 worktree 还是 canonical，取决于「模型是否已经在这个任务里
 * 改过东西」——没有 taskId 时读 canonical 是合理的（开任务前先逛逛仓库），但
 * **带着 taskId 却仍悄悄读 canonical 不行**：模型自己刚用 grande_repo_edit
 * 写进 worktree 的内容，下一次读会看不到（BUG 1）。taskId 未知时抛
 * TASK_NOT_FOUND，与 grande_run/grande_diff 一致。
 */
function resolveReadRoot(
  db: DatabaseSync,
  layout: Layout,
  args: { taskId?: string; repoId?: string },
  defaultRepoId: string | undefined,
): string {
  const { taskId, repoId } = args;
  if (taskId) {
    const t = getTask(db, taskId);
    if (!t) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
    if (repoId !== undefined && repoId !== t.repoId) {
      throw new StateError(
        "INVALID_INPUT",
        `repoId（${repoId}）与 taskId ${taskId} 所属仓库（${t.repoId}）不一致——两者同时给出时必须` +
          `一致，不会静默择一。要浏览另一个仓库，去掉 taskId 或改传该仓库自己的 taskId。`,
      );
    }
    return t.worktreePath;
  }

  const effectiveRepoId = repoId ?? defaultRepoId;
  if (effectiveRepoId === undefined) {
    const registered = [...registeredIds(layout)].sort();
    throw new StateError(
      "INVALID_INPUT",
      registered.length > 0
        ? `既没有 taskId 也没有 repoId，当前端点也没有默认仓库——已注册仓库：` +
          `${registered.join("、")}。请传 taskId（浏览某个任务的 worktree）或 repoId（浏览` +
          `某个仓库的 canonical checkout）。`
        : `既没有 taskId 也没有 repoId，当前端点也没有默认仓库，工作区里也没有任何已注册仓库` +
          `——请先在 ~/.grande-control/config/repos.yaml 里注册至少一个仓库。`,
    );
  }
  return resolveRepoPath(layout, effectiveRepoId, registeredIds(layout));
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
      te.details.activeTasks = listActiveTasks(deps.db).map(activeTaskSummary);
    }
    return { structuredContent: err({ ...te, taskId }) };
  }
}

async function wrapAsync(
  deps: ToolDeps,
  taskId: string | null,
  fn: () => Promise<unknown>,
): Promise<{ structuredContent: unknown }> {
  try {
    const data = await fn();
    return wrap(deps, taskId, () => data);
  } catch (error) {
    return wrap(deps, taskId, () => { throw error; });
  }
}

/**
 * BUG 4：`getProfile` 未注册时的报错早就列出可选 profile 了，但那只在**调用之后**
 * 才看得到——模型第一次选名字时手里没有这份列表，只能猜（实测：猜了 "test"，
 * 真实注册的是 "unit"，多花一轮工具调用才自纠正）。把同一份名字提前铺进
 * `grande_run` 的 schema 描述里，模型在选之前就看得到，不必先犯错再学。
 *
 * D18：`grande_run` 不再固定绑一个 repo（profile 归属哪个仓库要等到调用时带的
 * `taskId` 才知道），schema 描述却是在 `buildTools` 时一次性生成的——没法再说
 * 「这个端点注册了哪些 profile」，只能按仓库分组列出**全部**已注册仓库的
 * profile，模型据此自行对照它准备用哪个 taskId。用 try/catch 兜底：单个仓库
 * 的 profiles.yaml 缺失/损坏不该让整个工具列表都构建失败，也不该让别的仓库的
 * 列表跟着消失。
 */
function describeAvailableProfiles(layout: Layout): string {
  const parts: string[] = [];
  let ids: string[];
  try {
    ids = [...registeredIds(layout)].sort();
  } catch {
    return "";
  }
  for (const repoId of ids) {
    try {
      const names = [...loadProfiles(layout, repoId).keys()].sort();
      if (names.length > 0) parts.push(`${repoId}：${names.join("、")}`);
    } catch {
      // 单个仓库的 profiles.yaml 配置有问题不该拖垮其余仓库的描述。
    }
  }
  return parts.length > 0 ? `已注册：${parts.join("；")}` : "尚未有任何仓库注册 profile";
}

export function buildTools(deps: ToolDeps): ToolDef[] {
  const { db, layout, defaultRepoId } = deps;
  const availableProfiles = describeAvailableProfiles(layout);

  return [
    {
      name: "grande_task_status",
      description: "查询指定 task 的状态：分支、state、变更文件数、最近 job 状态。" +
        "不带 taskId 调用时返回总览：已注册仓库列表 + 当前活跃任务列表——这是模型" +
        "了解「现在能在哪些仓库上开工、已经有哪些任务在跑」的入口（D18：单一端点下" +
        "不再有「这个连接器只服务一个 repo」这件事，需要一个显式的发现点）。",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "任务ID。不传则返回已注册仓库 + 活跃任务总览" },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, (args.taskId as string) ?? null, () => {
          const taskId = args.taskId as string | undefined;
          if (taskId === undefined) {
            const registered = [...registeredIds(layout)].sort();
            const active = listActiveTasks(db).map((t) => ({
              taskId: t.taskId,
              repoId: t.repoId,
              branch: t.branch,
              state: t.state,
              filesChanged: listChangedFiles(t.worktreePath, t.baseCommit).length,
            }));
            return ok({
              taskId: null,
              data: { registeredRepos: registered, activeTasks: active },
              hint: registered.length > 0
                ? `已注册仓库：${registered.join("、")}；活跃任务 ${active.length} 个。` +
                  `用 grande_task_open 在某个已注册仓库里开新任务，或传 taskId 查看某个` +
                  `任务的详情。`
                : `工作区里还没有任何已注册仓库——请先在 ~/.grande-control/config/repos.yaml ` +
                  `中注册。`,
            });
          }
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
      description: "列出仓库目录结构，识别关键文件（package.json/tsconfig.json/测试目录等）。" +
        "带 taskId 时读取该任务的 worktree（能看到你自己刚写入的改动）；不带 taskId 时按" +
        "repoId（或端点默认仓库）读取 canonical，两者都没有则报错并列出已注册仓库。",
      inputSchema: {
        type: "object",
        properties: {
          maxEntries: { type: "number", description: "单次返回的最大条目数（默认500）" },
          cursor: { type: "string", description: "分页游标，来自上一页的 nextCursor" },
          taskId: { type: "string", description: "可选：任务ID。带上时读取该任务 worktree 而非 canonical" },
          repoId: {
            type: "string",
            description: "可选：仓库ID，仅用于无 taskId 的浏览。若同时给出 taskId，必须与该任务所属仓库一致",
          },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, (args.taskId as string) ?? null, () => {
          const root = resolveReadRoot(
            db, layout,
            { taskId: args.taskId as string | undefined, repoId: args.repoId as string | undefined },
            defaultRepoId,
          );
          const r = repoMap(root, {
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
      description: "在仓库中搜索字面量（非正则），返回匹配行与上下文，支持分页与时间预算；" +
        "默认 20 条、硬上限 25 条，序列化 SearchResult 硬上限 16 KiB。" +
        "带 taskId 时搜索该任务的 worktree（能搜到你自己刚写入的改动）；不带 taskId 时按" +
        "repoId（或端点默认仓库）搜索 canonical，两者都没有则报错并列出已注册仓库。",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "要搜索的字面量文本（不支持正则）" },
          maxMatches: { type: "number", description: "单次返回的最大匹配数（默认50）" },
          budgetMs: { type: "number", description: "时间预算，毫秒（默认4000）" },
          cursor: { type: "string", description: "分页游标" },
          taskId: { type: "string", description: "可选：任务ID。带上时搜索该任务 worktree 而非 canonical" },
          repoId: {
            type: "string",
            description: "可选：仓库ID，仅用于无 taskId 的浏览。若同时给出 taskId，必须与该任务所属仓库一致",
          },
        },
        required: ["pattern"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, (args.taskId as string) ?? null, () => {
          const root = resolveReadRoot(
            db, layout,
            { taskId: args.taskId as string | undefined, repoId: args.repoId as string | undefined },
            defaultRepoId,
          );
          const r = repoSearch(root, args.pattern as string, {
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
      description: "读取仓库内文件内容，支持行区间与字节上限；默认 16 KiB，硬上限 24 KiB。" +
        "带 taskId 时读取该任务的 worktree（能看到你自己刚写入的改动）；不带 taskId 时按" +
        "repoId（或端点默认仓库）读取 canonical，两者都没有则报错并列出已注册仓库。",
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
          taskId: { type: "string", description: "可选：任务ID。带上时读取该任务 worktree 而非 canonical" },
          repoId: {
            type: "string",
            description: "可选：仓库ID，仅用于无 taskId 的浏览。若同时给出 taskId，必须与该任务所属仓库一致",
          },
        },
        required: ["path"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      handler: async (args) =>
        wrap(deps, (args.taskId as string) ?? null, () => {
          let lineRange: [number, number] | undefined;
          const lr = args.lineRange as [number, number] | undefined;
          if (lr) lineRange = [lr[0], lr[1]];
          const root = resolveReadRoot(
            db, layout,
            { taskId: args.taskId as string | undefined, repoId: args.repoId as string | undefined },
            defaultRepoId,
          );
          const r = repoRead(root, args.path as string, {
            maxBytes: args.maxBytes as number | undefined,
            lineRange,
          });
          const maxBytes = (args.maxBytes as number | undefined) ?? DEFAULT_REPO_READ_BYTES;
          const returnedBytes = Buffer.byteLength(r.content, "utf8");
          const continuationArgs: Record<string, unknown> = {
            path: r.path,
            lineRange: [r.nextLine, r.totalLines],
            maxBytes,
          };
          if (args.taskId !== undefined) continuationArgs.taskId = args.taskId;
          else if (args.repoId !== undefined) continuationArgs.repoId = args.repoId;
          return ok({
            data: r,
            hint: r.nextLine !== null
              ? `文件 ${r.path}（${r.totalLines} 行，${r.bytes} 字节），内容未完整返回（本页 ${returnedBytes} 字节）` +
                `；本页仅含完整 UTF-8 行；续取请调用 grande_repo_read(${JSON.stringify(continuationArgs)})`
              : r.truncated
                ? `文件 ${r.path}（${r.totalLines} 行，${r.bytes} 字节），本次请求已到文件末尾，没有后续行`
                : `文件 ${r.path}（${r.totalLines} 行，${r.bytes} 字节）`,
              truncated: r.truncated,
            });
          }),
      },
      {
        name: "grande_task_open",
        description: "为新任务创建 worktree 和分支，准备沙箱执行环境。" +
          "repoId 必须是已注册仓库（D18：这是唯一一处由模型显式指定写入目标仓库的地方——" +
          "此后 grande_repo_edit/grande_run 都只认 taskId，不再接受 repoId）。",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "任务ID" },
            slug: { type: "string", description: "任务简称（1–40 个小写字母、数字或连字符）" },
            repoId: { type: "string", description: "要在哪个已注册仓库里开任务" },
          },
          required: ["taskId", "slug", "repoId"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        handler: async (args) =>
          wrap(deps, args.taskId as string, () => {
            const taskId = args.taskId as string;
            const slug = args.slug as string;
            const repoId = args.repoId as string;
            if (getTask(db, taskId)) {
              throw new StateError("INVALID_INPUT", `任务 ${taskId} 已存在；taskId 不能重复使用。`);
            }
            // 与 grande_repo_edit 校验 taskId 存在性的做法一致：先验证前置条件，
            // 验不过的请求连 INTENT 都不留（这不是「执行失败留痕」，是请求本身
            // 就没通过最基本的合法性检查）。openWorktree 内部也会经
            // resolveRepoPath 校验，但把它提前到这里能给出更早、更明确的拒绝，
            // 且不依赖「openWorktree 恰好在建任何文件之前调用 resolveRepoPath」
            // 这个实现细节——校验在调用方这一层独立成立。
            if (!registeredIds(layout).has(repoId)) {
              throw new PathSecurityError(
                "REPO_NOT_REGISTERED",
                `仓库 ${repoId} 未注册。工作区下的仓库会被自动发现为候选，但必须显式注册后才可访问。`,
              );
            }
            // task_open 建分支、建 worktree、写 task 行——它是变更操作，必须先留下 INTENT
            // （规格 §7.0①）。此前漏了：真实使用中它成功建出 worktree 而审计账本为空。
            // openWorktree 的签名没有 AuditHandle 参数（不像 repoEdit/startJob 那样是
            // 硬约束），所以这里必须由调用方显式记——这也正是它被漏掉的原因。
            const h = beginAudit(db, { taskId, tool: "grande_task_open", input: { slug, repoId } });
            h.allowed();
            if (!h.executing()) {
              throw new StateError("STALE_STATE", `任务 ${taskId} 的审计句柄无法推进到 EXECUTING。`);
            }
            let wt: ReturnType<typeof openWorktree>;
            try {
              wt = openWorktree(layout, repoId, slug, taskId);
            } catch (e) {
              h.failed((e as Error).message);
              throw e;
            }
            const t = createTask(db, {
              taskId, repoId, branch: wt.branch, baseCommit: wt.baseCommit,
              worktreePath: wt.worktreePath, state: "READY",
            });
            h.succeeded([wt.worktreePath]);
            return ok({
              taskId,
              data: { taskId: t.taskId, branch: t.branch, baseCommit: t.baseCommit, worktreePath: t.worktreePath },
              hint: `任务 ${t.taskId} 已创建并处于 READY 状态——分支 ${t.branch} 与 worktree 已就绪，` +
                `可以开始工作。下一步：使用 grande_repo_edit (taskId="${t.taskId}") 修改文件，` +
                `或 grande_run (taskId="${t.taskId}") 运行测试。` +
                `完成后调用 grande_task_close (taskId="${t.taskId}") 回收资源。`,
              taskContext: makeTaskContext(db, layout, taskId),
            });
          }),
      },
      {
        name: "grande_run",
        description: "在沙箱中异步执行一个 profile 命令，立即返回 jobId 供后续查询。" +
          "profile 归属由 taskId 所在的仓库决定" +
          (availableProfiles ? `（${availableProfiles}）` : ""),
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "关联的任务ID" },
            profile: {
              type: "string",
              description: `要执行的 profile 名称${availableProfiles ? `（${availableProfiles}）` : ""}`,
            },
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
            const rules = loadEffectiveDenyRules(layout, t.worktreePath);
            const changedFiles = listChangedFiles(t.worktreePath, t.baseCommit);
            const h = beginAudit(db, { taskId, tool: "grande_run", input: { profile: profileName } });
            h.allowed();
            try {
              assertPairedEditsSatisfied(changedFiles, rules);
            } catch (error) {
              h.failed(error instanceof Error ? error.message : String(error));
              throw error;
            }
            const s = startJob(
              { db, layout },
              { taskId, repoId: t.repoId, worktreePath: t.worktreePath, profileName },
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
        description: "批量修改指定任务 worktree 里的文件：create（新建）、modify（修改，需要 " +
          "expectedSha256 防冲突）、move（移动）、delete（删除，需要 expectedSha256；文件会进入 " +
          "Trash，并由 Checkpoint 提供整批回滚）。taskId 决定写入哪个仓库的哪个 worktree" +
          "（D18：仓库由 taskId 单向推导，不接受也不认 repoId 参数）——写入的是该任务的" +
          "隔离工作区，不是 canonical checkout，其他工具（grande_repo_read/grande_repo_map/" +
          "grande_repo_search/grande_diff）带上同一个 taskId 才能看到这里的改动。",
        inputSchema: {
          type: "object",
          properties: {
            ops: {
              type: "array",
              items: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      op: { const: "create" },
                      path: { type: "string" },
                      content: { type: "string" },
                    },
                    required: ["op", "path", "content"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      op: { const: "modify" },
                      path: { type: "string" },
                      content: { type: "string" },
                      expectedSha256: {
                        type: "string",
                        description: "必须来自最近一次 grande_repo_read；用于拒绝覆盖已变化的文件",
                      },
                    },
                    required: ["op", "path", "content", "expectedSha256"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      op: { const: "move" },
                      from: { type: "string" },
                      to: { type: "string" },
                    },
                    required: ["op", "from", "to"],
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    properties: {
                      op: { const: "delete" },
                      path: { type: "string" },
                      expectedSha256: {
                        type: "string",
                        description: "必填，必须来自最近一次 grande_repo_read；用于拒绝删除已变化的文件",
                      },
                    },
                    required: ["op", "path", "expectedSha256"],
                    additionalProperties: false,
                  },
                ],
              },
              description: "修改操作数组：create / modify / move / delete。modify 与 delete 必须提供 expectedSha256。",
            },
            taskId: { type: "string", description: "任务ID，决定写入哪个仓库的哪个 worktree（必填）" },
          },
          required: ["ops", "taskId"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: async (args) =>
          wrap(deps, args.taskId as string, () => {
            const taskId = args.taskId as string;
            const t = getTask(db, taskId);
            if (!t) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
            const ops = args.ops as EditOp[];
            const rules = loadEffectiveDenyRules(layout, t.worktreePath);
            const h = beginAudit(db, { taskId, tool: "grande_repo_edit", input: { ops } });
            h.allowed();
            // 遗留 #6/#7：layout 与 taskId 显式传入。此前 repoEdit 自己 loadLayout()
              // 并 basename(root)——后者是一条签名上看不见的前置条件，
              // 而这两个值在这里本来就都在手边。
              const r = repoEdit(t.worktreePath, ops, rules, h, { layout, taskId });
            const paths = r.applied.map((a) => a.path);
            return ok({
              taskId,
              data: r,
              hint: `已应用 ${r.applied.length} 个操作：${paths.join(", ")}`,
              taskContext: makeTaskContext(db, layout, taskId),
            });
          }),
      },
      {
        name: "grande_rollback",
        description: "把指定任务的 worktree 恢复到某个 checkpoint 建立时的状态。" +
          "需要同时提供 taskId 与 checkpointId；实际被恢复的路径会写入审计账本并在响应中返回。",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "要回滚的任务ID" },
            checkpointId: { type: "string", description: "grande_repo_edit 返回的 checkpointId" },
          },
          required: ["taskId", "checkpointId"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: async (args) =>
          wrap(deps, args.taskId as string, () => {
            const taskId = args.taskId as string;
            const checkpointId = args.checkpointId as string;
            const t = getTask(db, taskId);
            if (!t) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);

            const h = beginAudit(db, {
              taskId,
              tool: "grande_rollback",
              input: { taskId, checkpointId },
            });
            h.allowed();
            if (!h.executing()) {
              throw new StateError("STALE_STATE", `任务 ${taskId} 的回滚审计句柄无法推进到 EXECUTING。`);
            }

            let restoredPaths: string[];
            try {
              restoredPaths = restoreCheckpoint(layout, taskId, t.worktreePath, checkpointId);
            } catch (e) {
              h.failed(e instanceof Error ? e.message : String(e));
              if (e instanceof CheckpointError && e.code === "NOT_FOUND") {
                throw new StateError("INVALID_INPUT", e.message);
              }
              throw e;
            }

            h.succeeded(restoredPaths);
            return ok({
              taskId,
              data: { taskId, checkpointId, restoredPaths },
              hint: `已从 checkpoint ${checkpointId} 恢复 ${restoredPaths.length} 个路径：` +
                `${restoredPaths.join(", ") || "无实际变更"}`,
              taskContext: makeTaskContext(db, layout, taskId),
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
        handler: (args) =>
          wrapAsync(deps, null, async () => {
            const jobId = args.jobId as string;
            const initialJob = getJob(db, jobId);
            if (initialJob && !TERMINAL.has(initialJob.state)) {
              await waitForTerminalJob(db, jobId);
            }
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
              // 遗留 #1（同源）：非终态一律说「仍在运行中」。写成 `=== "running"`
              // 的话，新增的非终态会掉进下面那条分支，模型读到「状态：<非终态>」
              // 会当作已结束——**而 P-1 的自主轮询正是靠这句 hint 决定要不要再取一次**。
              hint: !TERMINAL.has(r.state)
                ? `本次调用已等待 ${JOB_RESULT_WAIT_MS / 1000} 秒，Job ${jobId} 仍在运行中；` +
                  `请等待 grande_run 返回的 pollAfterSeconds 后再调用 grande_run_result`
                : `Job ${jobId} 状态：${r.state}${r.exitCode !== null ? `，exitCode: ${r.exitCode}` : ""}${r.networkDenied ? "（疑似网络被拒——启发式判定，非沙箱权威信号）" : ""}`,
              truncated: r.truncated,
              taskContext: taskId ? makeTaskContext(db, layout, taskId) : null,
            });
          }),
      },
      {
        name: "grande_task_close",
        description: "关闭任务，删除 worktree 与分支，回收磁盘空间。任务必须没有还在运行的 job——" +
          "close 不会替你去杀 job，你需要先等 job 结束（grande_run_result 轮询至终态），再关任务。" +
          "关闭是不可逆操作：worktree 里的改动如果没提交，将被永久丢弃。",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "要关闭的任务ID" },
          },
          required: ["taskId"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        handler: async (args) =>
          wrap(deps, args.taskId as string, () => {
            const taskId = args.taskId as string;
            const t = getTask(db, taskId);
            if (!t) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
            if (t.state === "CLOSED") {
              return ok({
                taskId,
                data: { taskId: t.taskId, repoId: t.repoId, branch: t.branch, worktreePath: t.worktreePath },
                hint: `任务 ${taskId} 此前已关闭（幂等）。worktree：${t.worktreePath}，分支：${t.branch}`,
                taskContext: makeTaskContext(db, layout, taskId),
              });
            }
            // 遗留 #1：用 jobs.ts 的 TERMINAL 集合取补，不写 `state === "running"`。
            // 今天两者等价（六个 JobState 里终态占五个），但加一个非终态就会漏，
            // 而这个守卫漏了意味着 worktree 会在 job 还活着时被删——
            // 那正是本项目已出现两次的「同源漏改」形状。
            const running = listJobs(db, taskId).filter((j) => !TERMINAL.has(j.state));
            if (running.length > 0) {
              throw new StateError(
                "JOB_RUNNING",
                `任务 ${taskId} 仍有一个在跑的 job：${running[0]!.jobId}。` +
                  `请先用 grande_run_result 轮询该 job 至终态（passed/failed/timeout/killed/cancelled），` +
                  `再关闭任务。`,
              );
            }
            const h = beginAudit(db, { taskId, tool: "grande_task_close", input: { taskId } });
            h.allowed();
            if (!h.executing()) {
              throw new StateError("STALE_STATE", `任务 ${taskId} 的审计句柄无法推进到 EXECUTING。`);
            }
            try {
              removeWorktree(layout, { repoId: t.repoId, worktreePath: t.worktreePath, branch: t.branch });
            } catch (e) {
              h.failed((e as Error).message);
              throw e;
            }
            updateTaskState(db, taskId, "CLOSED", t.stateVersion);
            h.succeeded([t.worktreePath]);
            return ok({
              taskId,
              data: { taskId: t.taskId, repoId: t.repoId, branch: t.branch, worktreePath: t.worktreePath },
              hint: `任务 ${taskId} 已关闭——worktree ${t.worktreePath} 与分支 ${t.branch} 已被删除。` +
                `磁盘空间已回收。`,
            });
          }),
      },
    ];
  }
