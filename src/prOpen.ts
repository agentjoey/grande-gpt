import { execFileSync } from "node:child_process";
import { getAttestations } from "./attestation.ts";
import { beginAudit, type AuditHandle } from "./audit.ts";
import { err, ok } from "./envelope.ts";
import { StateError, redact, toToolError } from "./errors.ts";
import { createGithubApi, GithubApiError, type GithubApi } from "./githubApi.ts";
import { GithubAuthError, loadGithubToken, redactToken } from "./githubAuth.ts";
import { githubGitArgv } from "./push.ts";
import { getTask } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

export interface RemoteGithubState {
  defaultBranch: string;
  commit: string;
}

export interface PrOpenToolOptions {
  apiFactory?: (token: string) => GithubApi;
  readRemoteUrl?: (worktreePath: string, token: string) => string;
  inspectRemoteState?: (worktreePath: string, token: string) => RemoteGithubState;
}

function git(worktreePath: string, args: string[], token: string): string {
  try {
    return execFileSync("git", githubGitArgv(args, token), {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    const detail = redactToken(e.stderr ? String(e.stderr).trim() : e.message, token);
    throw new StateError("INVALID_INPUT", `git ${args[0] ?? "命令"} 失败：${detail}`);
  }
}

function parseDefaultBranch(output: string): string {
  for (const line of output.split(/\r?\n/)) {
    const match = /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/.exec(line.trim());
    if (match) return match[1]!;
  }
  throw new StateError(
    "INVALID_INPUT",
    "无法从 `git ls-remote --symref origin HEAD` 解析 origin 默认分支。",
  );
}

/** 只读取 URL；必须在任何可能访问 remote 的命令之前完成形状校验。 */
export function readGithubRemoteUrl(worktreePath: string, token: string): string {
  return git(worktreePath, ["remote", "get-url", "origin"], token).trim();
}

/** 确认确实需要创建 PR 后，才探测默认分支与当前 commit。 */
export function inspectGithubRemoteState(worktreePath: string, token: string): RemoteGithubState {
  const defaultBranch = parseDefaultBranch(
    git(worktreePath, ["ls-remote", "--symref", "origin", "HEAD"], token),
  );
  const commit = git(worktreePath, ["rev-parse", "HEAD"], token).trim();
  return { defaultBranch, commit };
}

/** 只接受无凭据、无端口的 https://github.com/<owner>/<repo>[.git]。 */
export function parseGithubRemote(remote: string): { owner: string; repo: string } {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new StateError(
      "INVALID_INPUT",
      `origin remote 不是可接受的 GitHub URL：${remote}。只接受 https://github.com/<owner>/<repo>.git。`,
    );
  }
  if (
    url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
  ) {
    throw new StateError(
      "INVALID_INPUT",
      `origin remote 必须是无内嵌凭据的 https://github.com/<owner>/<repo>.git，收到：${remote}`,
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new StateError("INVALID_INPUT", `GitHub remote 路径必须恰好包含 owner/repo，收到：${url.pathname}`);
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  if (!owner || !repo || repo === ".git") {
    throw new StateError("INVALID_INPUT", `GitHub remote 缺少有效 owner/repo：${remote}`);
  }
  return { owner, repo };
}

/** 与 commitWorktree 同形：剥掉模型提供的可信键，再由 Gateway 唯一追加。 */
export function buildPullRequestBody(
  body: string,
  taskId: string,
  attestationId: string,
  commit: string,
): string {
  const clean = body
    .split(/\r?\n/)
    .filter((line) => !/^\s*Grande-(?:Task|Attestation|Commit)\s*:/i.test(line))
    .join("\n")
    .trim();
  const prefix = clean ? `${clean}\n\n` : "";
  return `${prefix}---\nGrande-Task: ${taskId}\nGrande-Attestation: ${attestationId}\nGrande-Commit: ${commit}`;
}

function normalizedError(error: unknown, token?: string): StateError {
  const message = token
    ? redactToken(error instanceof Error ? error.message : String(error), token)
    : error instanceof Error ? error.message : String(error);
  if (error instanceof StateError) return new StateError(error.code, message);
  if (error instanceof GithubAuthError || error instanceof GithubApiError) {
    return new StateError("INVALID_INPUT", message);
  }
  return new StateError("INVALID_INPUT", message);
}

function failedEnvelope(deps: ToolDeps, taskId: string, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId }) };
}

export function createPrOpenTool(deps: ToolDeps, options: PrOpenToolOptions = {}): ToolDef {
  const apiFactory = options.apiFactory ?? createGithubApi;
  const readRemoteUrl = options.readRemoteUrl ?? readGithubRemoteUrl;
  const inspectRemoteState = options.inspectRemoteState ?? inspectGithubRemoteState;
  return {
    name: "grande_pr_open",
    description: "为任务分支打开 Draft GitHub PR。按 head 幂等查重，可信尾注由 Gateway 重建；只接受 github.com HTTPS remote。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "任务ID" },
        title: { type: "string", description: "PR 标题" },
        body: { type: "string", description: "PR 正文；Grande-* 尾注由 Gateway 可信追加" },
      },
      required: ["taskId", "title", "body"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (args) => {
      const taskId = args.taskId as string;
      let audit: AuditHandle | undefined;
      let token: string | undefined;
      try {
        // 1. 先找任务；不存在时不读 remote、不碰 API。
        const task = getTask(deps.db, taskId);
        if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
        try {
          token = loadGithubToken(deps.layout).token;
        } catch (error) {
          throw normalizedError(error);
        }

        const title = typeof args.title === "string" ? args.title.trim() : "";
        const body = typeof args.body === "string" ? args.body : "";
        if (!title) throw new StateError("INVALID_INPUT", "PR title 不能为空。 ");

        // 2. 先只读并解析 URL。非法 remote 在任何 ls-remote/API 调用之前被拒绝。
        const remoteUrl = readRemoteUrl(task.worktreePath, token);
        const { owner, repo } = parseGithubRemote(remoteUrl);
        const api = apiFactory(token);

        // 3. 幂等查询必须在任何创建审计、remote state 探测和 create 之前。
        const existing = await api.findPullRequest(owner, repo, task.branch);
        if (existing) {
          return {
            structuredContent: ok({
              taskId,
              data: { ...existing, existing: true },
              hint: `任务 ${taskId} 已有 PR #${existing.number}，未创建重复 PR。`,
              taskContext: { branch: task.branch, filesChanged: 0, lastJob: null },
            }),
          };
        }

        // 4. 只有确实要创建时才写审计并进入执行态。
        audit = beginAudit(deps.db, {
          taskId,
          tool: "grande_pr_open",
          input: { taskId, title, body },
        });
        audit.allowed();
        if (!audit.executing()) {
          throw new StateError("STALE_STATE", `任务 ${taskId} 的 PR 审计句柄无法推进到 EXECUTING。`);
        }

        const remote = inspectRemoteState(task.worktreePath, token);
        const attestationId = getAttestations(deps.db, taskId)
          .find((candidate) => candidate.commit === remote.commit)?.attestationId ?? "none";
        const trustedBody = buildPullRequestBody(body, taskId, attestationId, remote.commit);

        // 5. draft 是字面量 true；既不读参数，也没有 false 分支。
        const created = await api.createPullRequest({
          owner,
          repo,
          head: task.branch,
          base: remote.defaultBranch,
          title,
          body: trustedBody,
          draft: true,
        });
        audit.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: {
              ...created,
              existing: false,
              draft: true,
              head: task.branch,
              base: remote.defaultBranch,
            },
            hint: `任务 ${taskId} 已创建 Draft PR #${created.number}。`,
            taskContext: { branch: task.branch, filesChanged: 0, lastJob: null },
          }),
        };
      } catch (error) {
        const safe = normalizedError(error, token);
        audit?.failed(safe.message);
        return failedEnvelope(deps, taskId, safe);
      }
    },
  };
}
