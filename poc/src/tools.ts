import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { err, ok, truncateList, truncateText, type TaskContext } from "./envelope.ts";
import { getRepo } from "./fixtures.ts";
import { getJobStatus, JOB_DURATION_MS, lastJobStateForTask, startJob } from "./jobs.ts";

export const LIMITS = {
  readBytes: 65_536,
  searchHits: 50,
  diffLines: 400,
  tailLines: 40,
} as const;

/** 规格 §12.2 待决策项。P-1 若失败，第一件要试的事就是切到 "en" 重测。 */
export const HINT_LANG: "zh" | "en" = process.env.POC_HINT_LANG === "en" ? "en" : "zh";

const PROFILES = ["unit", "lint", "typecheck"] as const;

interface Task {
  taskId: string;
  repoId: string;
  goal: string;
  branch: string;
}

const tasks = new Map<string, Task>();

export function resetTasks(): void {
  tasks.clear();
}

function slugify(goal: string): string {
  const ascii = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return ascii.length > 0 ? ascii.slice(0, 24) : "task";
}

function contextFor(task: Task): TaskContext {
  const repo = getRepo(task.repoId);
  return {
    branch: task.branch,
    filesChanged: repo?.changedPaths().length ?? 0,
    lastJob: lastJobStateForTask(task.taskId),
  };
}

function t(zh: string, en: string): string {
  return HINT_LANG === "en" ? en : zh;
}

/** 工具结果统一形态：structuredContent 承载信封，content 给人类可读摘要 */
function reply(envelope: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as Record<string, unknown>,
  };
}

function requireTask(taskId: string | undefined) {
  if (taskId === undefined) {
    return err({
      code: "INVALID_INPUT",
      message: t("缺少 taskId。", "Missing taskId."),
      details: { activeTasks: [...tasks.values()].map((x) => ({ taskId: x.taskId, goal: x.goal })) },
    });
  }
  const task = tasks.get(taskId);
  if (!task) {
    return err({
      code: "TASK_NOT_FOUND",
      message: t(
        `任务 ${taskId} 不存在。请从下面的活跃任务中选一个。`,
        `Task ${taskId} not found. Pick one of the active tasks below.`,
      ),
      retryable: true,
      details: {
        activeTasks: [...tasks.values()].map((x) => ({
          taskId: x.taskId,
          goal: x.goal,
          branch: x.branch,
          filesChanged: getRepo(x.repoId)?.changedPaths().length ?? 0,
        })),
      },
    });
  }
  return task;
}

function isTask(v: Task | ReturnType<typeof err>): v is Task {
  return (v as { ok?: false }).ok !== false;
}

export function registerTools(server: McpServer, repoId: string): void {
  const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "grande_task_open",
    {
      title: "Open a development task",
      description: t(
        "在当前仓库上开启一个开发任务，创建隔离分支与工作区。任何读写代码的操作都必须先调用它拿到 taskId。",
        "Open a development task on the current repository, creating an isolated branch and worktree. Call this first to obtain a taskId; every other tool requires it.",
      ),
      inputSchema: { goal: z.string().describe("这次任务要达成的目标，一句话") },
      annotations: RW,
    },
    async ({ goal }) => {
      const taskId = `task_${randomUUID().slice(0, 8)}`;
      const task: Task = { taskId, repoId, goal, branch: `grande/${slugify(goal)}-${taskId.slice(5)}` };
      tasks.set(taskId, task);
      return reply(
        ok({
          taskId,
          data: { taskId, repoId, branch: task.branch, goal },
          taskContext: contextFor(task),
          hint: t(
            `任务已创建。先用 grande_repo_map 或 grande_repo_search 了解代码结构，再用 grande_repo_read 读具体文件。后续每次调用都要带 taskId=${taskId}。`,
            `Task created. Use grande_repo_map or grande_repo_search to explore, then grande_repo_read for specific files. Pass taskId=${taskId} on every later call.`,
          ),
        }),
      );
    },
  );

  server.registerTool(
    "grande_task_status",
    {
      title: "Get task status",
      description: t(
        "查询任务的分支、已修改文件与最近一次测试结果。新会话中恢复上下文时先调用它。不传 taskId 则列出全部活跃任务。",
        "Get a task's branch, changed files and latest test result. Call this first when resuming in a new conversation. Omit taskId to list all active tasks.",
      ),
      inputSchema: { taskId: z.string().optional() },
      annotations: RO,
    },
    async ({ taskId }) => {
      if (taskId === undefined) {
        return reply(
          ok({
            data: {
              activeTasks: [...tasks.values()].map((x) => ({
                taskId: x.taskId,
                goal: x.goal,
                branch: x.branch,
                filesChanged: getRepo(x.repoId)?.changedPaths().length ?? 0,
                lastJob: lastJobStateForTask(x.taskId),
              })),
            },
            hint: t("选一个 taskId 继续。", "Pick a taskId to continue."),
          }),
        );
      }
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const repo = getRepo(task.repoId)!;
      return reply(
        ok({
          taskId,
          data: {
            taskId,
            goal: task.goal,
            branch: task.branch,
            changedPaths: repo.changedPaths(),
            lastJob: lastJobStateForTask(taskId),
          },
          taskContext: contextFor(task),
          hint: t("可以继续读代码、修改或运行测试。", "You can continue reading, editing, or running tests."),
        }),
      );
    },
  );

  server.registerTool(
    "grande_repo_map",
    {
      title: "List repository files",
      description: t("列出仓库中的文件路径，用于快速了解结构。", "List file paths in the repository to understand its structure."),
      inputSchema: { taskId: z.string() },
      annotations: RO,
    },
    async ({ taskId }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const paths = getRepo(task.repoId)!.listPaths();
      return reply(
        ok({
          taskId,
          data: { paths },
          taskContext: contextFor(task),
          hint: t("用 grande_repo_read 读取感兴趣的文件。", "Use grande_repo_read to open a file."),
        }),
      );
    },
  );

  server.registerTool(
    "grande_repo_search",
    {
      title: "Search repository",
      description: t(
        "在仓库中按文本搜索，返回路径、行号与该行内容。结果最多 50 条，超出会标记 truncated。",
        "Search the repository by text; returns path, line number and line content. Capped at 50 hits; excess is flagged via truncated.",
      ),
      inputSchema: { taskId: z.string(), query: z.string() },
      annotations: RO,
    },
    async ({ taskId, query }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const all = getRepo(task.repoId)!.search(query);
      const { items, truncated, nextCursor } = truncateList(all, LIMITS.searchHits);
      return reply(
        ok({
          taskId,
          data: { hits: items, totalHits: all.length },
          truncated,
          nextCursor,
          taskContext: contextFor(task),
          hint: truncated
            ? t(
                `共 ${all.length} 处命中，只返回了前 ${LIMITS.searchHits} 条。需要更多请带 cursor=${nextCursor} 再次调用，或换一个更精确的 query。`,
                `${all.length} hits total, first ${LIMITS.searchHits} returned. Call again with cursor=${nextCursor} for more, or narrow the query.`,
              )
            : t("用 grande_repo_read 打开命中的文件。", "Use grande_repo_read to open a matched file."),
        }),
      );
    },
  );

  server.registerTool(
    "grande_repo_read",
    {
      title: "Read a file",
      description: t(
        "读取一个文件的内容，同时返回 sha256。修改该文件时必须把这个 sha256 作为 expectedSha256 传回，否则会被拒绝。",
        "Read a file's content along with its sha256. You MUST pass that sha256 back as expectedSha256 when modifying the file, or the edit is rejected.",
      ),
      inputSchema: {
        taskId: z.string(),
        path: z.string(),
        lineRange: z.string().optional().describe("形如 '100-200'，用于读取大文件的某一段"),
      },
      annotations: RO,
    },
    async ({ taskId, path, lineRange }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const file = getRepo(task.repoId)!.readFile(path);
      if (!file) {
        return reply(
          err({
            taskId,
            code: "INVALID_INPUT",
            message: t(`文件不存在：${path}`, `No such file: ${path}`),
            details: { path },
          }),
        );
      }

      let content = file.content;
      if (lineRange) {
        const [from, to] = lineRange.split("-").map((n) => Number(n));
        const lines = content.split("\n");
        content = lines.slice(Math.max(0, (from ?? 1) - 1), to ?? lines.length).join("\n");
      }

      const cut = truncateText(content, LIMITS.readBytes);
      return reply(
        ok({
          taskId,
          data: { path, content: cut.text, sha256: file.sha256, totalBytes: Buffer.byteLength(file.content, "utf8") },
          truncated: cut.truncated,
          taskContext: contextFor(task),
          hint: cut.truncated
            ? t(
                `文件过大已截断。需要后续内容请再次调用并带上 lineRange，例如 lineRange="500-1000"。修改此文件时用 expectedSha256=${file.sha256}。`,
                `File truncated. Call again with lineRange, e.g. lineRange="500-1000". Use expectedSha256=${file.sha256} when modifying it.`,
              )
            : t(
                `修改此文件时必须传 expectedSha256=${file.sha256}。`,
                `Pass expectedSha256=${file.sha256} when modifying this file.`,
              ),
        }),
      );
    },
  );

  server.registerTool(
    "grande_repo_edit",
    {
      title: "Edit files",
      description: t(
        "一次调用中修改或新建多个文件，全部成功或全部不生效。修改已有文件必须带 expectedSha256（来自 grande_repo_read）。不支持删除文件。",
        "Create or modify multiple files in one call; all succeed or none apply. Modifying an existing file requires expectedSha256 from grande_repo_read. Deleting files is not supported.",
      ),
      inputSchema: {
        taskId: z.string(),
        edits: z
          .array(
            z.object({
              op: z.enum(["create", "modify"]),
              path: z.string(),
              content: z.string(),
              expectedSha256: z.string().optional().describe("modify 时必填，取自 grande_repo_read"),
            }),
          )
          .min(1),
      },
      annotations: RW,
    },
    async ({ taskId, edits }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const repo = getRepo(task.repoId)!;

      // 事务语义：先全量校验，任一失败则整批不生效
      for (const e of edits) {
        if (e.op === "modify") {
          const cur = repo.readFile(e.path);
          if (!cur) {
            return reply(
              err({ taskId, code: "INVALID_INPUT", message: t(`文件不存在：${e.path}`, `No such file: ${e.path}`), details: { path: e.path } }),
            );
          }
          if (e.expectedSha256 !== cur.sha256) {
            return reply(
              err({
                taskId,
                code: "STALE_FILE",
                message: t(
                  `${e.path} 在你读取之后发生了变化，本次修改未生效（其他文件也未改动）。请重新 grande_repo_read 后再试。`,
                  `${e.path} changed after you read it; nothing was written. Re-read it with grande_repo_read and retry.`,
                ),
                retryable: true,
                details: { path: e.path, actualSha256: cur.sha256, providedSha256: e.expectedSha256 ?? null },
              }),
            );
          }
        }
      }

      for (const e of edits) repo.writeFile(e.path, e.content);

      return reply(
        ok({
          taskId,
          data: { written: edits.map((e) => e.path) },
          taskContext: contextFor(task),
          hint: t(
            "修改已应用。运行 grande_run(profile='unit') 验证。",
            "Edits applied. Run grande_run(profile='unit') to verify.",
          ),
        }),
      );
    },
  );

  server.registerTool(
    "grande_diff",
    {
      title: "Show changes",
      description: t("查看当前任务相对基线的全部改动。", "Show all changes in this task relative to its base."),
      inputSchema: { taskId: z.string() },
      annotations: RO,
    },
    async ({ taskId }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const all = getRepo(task.repoId)!.diff();
      const { items, truncated, nextCursor } = truncateList(all, LIMITS.diffLines);
      return reply(
        ok({
          taskId,
          data: { lines: items, totalLines: all.length },
          truncated,
          nextCursor,
          taskContext: contextFor(task),
          hint: truncated
            ? t(`diff 过长，只返回前 ${LIMITS.diffLines} 行。`, `Diff truncated to the first ${LIMITS.diffLines} lines.`)
            : t("确认改动无误后可运行测试。", "Run the tests once the changes look right."),
        }),
      );
    },
  );

  server.registerTool(
    "grande_run",
    {
      title: "Run a test/lint/build profile",
      description: t(
        `运行注册的命令 profile（可选：${PROFILES.join(" / ")}）。这是异步操作：本调用立即返回 jobId，你必须随后自行调用 grande_run_result 轮询直到得到最终结果，不要停下来等用户。`,
        `Run a registered command profile (one of: ${PROFILES.join(" / ")}). This is asynchronous: it returns a jobId immediately, and you MUST then poll grande_run_result yourself until you get a final result. Do not stop and wait for the user.`,
      ),
      inputSchema: { taskId: z.string(), profile: z.string() },
      annotations: RW,
    },
    async ({ taskId, profile }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      if (!(PROFILES as readonly string[]).includes(profile)) {
        return reply(
          err({
            taskId,
            code: "PROFILE_NOT_FOUND",
            message: t(`未注册的 profile：${profile}`, `Unregistered profile: ${profile}`),
            details: { available: PROFILES },
          }),
        );
      }
      const { jobId } = startJob({ taskId, repoId: task.repoId, profile });
      const pollAfterSeconds = Math.max(5, Math.round(JOB_DURATION_MS / 1000 / 2));
      return reply(
        ok({
          taskId,
          data: { jobId, state: "running", profile, pollAfterSeconds },
          taskContext: contextFor(task),
          hint: t(
            `${profile} 已启动，jobId=${jobId}。请在约 ${pollAfterSeconds} 秒后调用 grande_run_result(taskId="${taskId}", jobId="${jobId}") 查询；若仍在运行就继续轮询，直到 state 变为 passed 或 failed。这一步不需要用户介入。`,
            `${profile} started, jobId=${jobId}. Call grande_run_result(taskId="${taskId}", jobId="${jobId}") in about ${pollAfterSeconds} seconds; if it is still running, keep polling until state becomes passed or failed. No user input is needed for this.`,
          ),
        }),
      );
    },
  );

  server.registerTool(
    "grande_run_result",
    {
      title: "Poll a job result",
      description: t(
        "查询 grande_run 启动的 job。若 state 仍为 running，请稍候再次调用本工具，不要询问用户。",
        "Poll a job started by grande_run. If state is still running, call this tool again after a short wait — do not ask the user.",
      ),
      inputSchema: { taskId: z.string(), jobId: z.string() },
      annotations: RO,
    },
    async ({ taskId, jobId }) => {
      const task = requireTask(taskId);
      if (!isTask(task)) return reply(task);
      const status = getJobStatus(jobId);
      if (!status) {
        return reply(err({ taskId, code: "INVALID_INPUT", message: t(`未知 jobId：${jobId}`, `Unknown jobId: ${jobId}`), details: { jobId } }));
      }

      const running = status.state === "running";
      const pollAfterSeconds = Math.max(5, Math.round((JOB_DURATION_MS - status.durationMs) / 1000));

      return reply(
        ok({
          taskId,
          data: {
            jobId: status.jobId,
            state: status.state,
            exitCode: status.exitCode,
            durationMs: status.durationMs,
            failedTests: status.failedTests,
            tail: status.tail.slice(-LIMITS.tailLines),
            artifactId: status.artifactId,
            ...(running ? { pollAfterSeconds } : {}),
          },
          truncated: status.tail.length > LIMITS.tailLines,
          taskContext: contextFor(task),
          hint: running
            ? t(
                `job ${jobId} 仍在运行。请等待约 ${pollAfterSeconds} 秒后再次调用 grande_run_result(taskId="${taskId}", jobId="${jobId}")。不要询问用户，自行继续轮询。`,
                `Job ${jobId} is still running. Wait about ${pollAfterSeconds} seconds and call grande_run_result(taskId="${taskId}", jobId="${jobId}") again. Do not ask the user; keep polling yourself.`,
              )
            : status.state === "failed"
              ? t(
                  `${status.failedTests.length} 个用例失败。用 grande_repo_read 读相关文件，修改后再次运行。`,
                  `${status.failedTests.length} test(s) failed. Read the relevant file with grande_repo_read, fix it, then run again.`,
                )
              : t("测试全部通过。", "All tests passed."),
        }),
      );
    },
  );
}
