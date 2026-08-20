import { execFileSync } from "node:child_process";
import { beginAudit, type AuditHandle } from "./audit.ts";
import { err, ok } from "./envelope.ts";
import { StateError, redact, toToolError } from "./errors.ts";
import { basicCredential, GithubAuthError, loadGithubToken, redactToken } from "./githubAuth.ts";
import { assertTaskBranch } from "./commit.ts";
import { getTask } from "./tasks.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

export interface PushResult {
  branch: string;
  commit: string;
  remoteDefaultBranch: string;
}

type GithubGit = (cwd: string, args: string[], token: string) => string;

/**
 * S3 的每一条 git 调用都必须经过这一个前缀。
 *
 * `Basic` 而不是 `Bearer` —— 见 `githubAuth.ts` 的 `basicCredential()`，
 * 那里记着实测判决与「为什么测试全绿却从未推成功」。
 */
export function githubGitArgv(args: string[], token: string): string[] {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", `http.extraHeader=Authorization: Basic ${basicCredential(token)}`,
    ...args,
  ];
}

const runGithubGit: GithubGit = (cwd, args, token) => {
  try {
    return execFileSync("git", githubGitArgv(args, token), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    const raw = e.stderr ? String(e.stderr).trim() : e.message;
    const detail = redactToken(raw, token);
    if (/\b(?:401|403)\b|bad credentials|authentication failed|expired/i.test(detail)) {
      throw new StateError(
        "INVALID_INPUT",
        `GitHub PAT 已失效、过期或权限不足。请在控制平面更换专用 PAT。上游：${detail}`,
      );
    }
    throw new StateError("INVALID_INPUT", `git ${args[0] ?? "命令"} 失败：${detail}`);
  }
};

function defaultBranchFromLsRemote(output: string): string {
  for (const line of output.split(/\r?\n/)) {
    const match = /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/.exec(line.trim());
    if (match) return match[1]!;
  }
  throw new StateError(
    "INVALID_INPUT",
    "无法从 `git ls-remote --symref origin HEAD` 解析 remote 默认分支；请确认 origin 可达且已设置 HEAD。",
  );
}

function rethrowRedacted(error: unknown, token: string): never {
  if (error instanceof StateError) {
    throw new StateError(error.code, redactToken(error.message, token));
  }
  throw new StateError(
    "INVALID_INPUT",
    redactToken(error instanceof Error ? error.message : String(error), token),
  );
}

/** 执行真实 push；目标分支只从 task.branch 派生，不接受外部指定。 */
export function pushTask(deps: ToolDeps, taskId: string, git: GithubGit = runGithubGit): PushResult {
  const task = getTask(deps.db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  const head = assertTaskBranch(task.worktreePath, task.branch);

  let token: string;
  try {
    token = loadGithubToken(deps.layout).token;
  } catch (error) {
    if (error instanceof GithubAuthError) {
      throw new StateError("INVALID_INPUT", error.message);
    }
    throw error;
  }

  try {
    const target = task.branch;

    // 判据①：唯一允许的命名空间。未知分支一律 fail closed。
    if (!target.startsWith("grande/") || target.length <= "grande/".length) {
      throw new StateError("POLICY_DENIED", `拒绝 push 分支 ${target}：目标必须匹配 grande/* 白名单。`);
    }
    // 判据②：目标只能来自 task.branch。这里保留显式检查，防止未来增加参数时漏掉边界。
    if (target !== task.branch) {
      throw new StateError("POLICY_DENIED", `拒绝 push：目标 ${target} 与任务分支 ${task.branch} 不一致。`);
    }

    if (head === task.baseCommit) {
      throw new StateError(
        "INVALID_INPUT",
        `任务 ${taskId} 还没有自己的 commit；请先调用 grande_commit，再执行 grande_push。`,
      );
    }

    try {
      git(task.worktreePath, ["remote", "get-url", "origin"], token).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StateError(
        "INVALID_INPUT",
        `任务 ${taskId} 没有可用的 origin remote；请先由 Human Owner 配置 remote。详情：${message}`,
      );
    }

    const remoteDefaultBranch = defaultBranchFromLsRemote(
      git(task.worktreePath, ["ls-remote", "--symref", "origin", "HEAD"], token),
    );
    // 判据③：即使默认分支也恰好叫 grande/*，仍然绝不直推。
    if (target === remoteDefaultBranch) {
      throw new StateError(
        "POLICY_DENIED",
        `拒绝 push：任务分支 ${target} 等于 origin 的默认分支 ${remoteDefaultBranch}。`,
      );
    }

    // 不提供 --force；source 固定为刚验证过的 SHA，destination 固定为 task.branch。
    // 这同时消除 branch guard 与 push 之间发生 HEAD 变化时的 TOCTOU 歧义。
    git(
      task.worktreePath,
      ["push", "origin", `${head}:refs/heads/${target}`],
      token,
    );
    return { branch: target, commit: head, remoteDefaultBranch };
  } catch (error) {
    rethrowRedacted(error, token);
  }
}

function failedEnvelope(deps: ToolDeps, taskId: string, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId }) };
}

export function createPushTool(deps: ToolDeps): ToolDef {
  return {
    name: "grande_push",
    description: "把任务自己的 grande/* 分支推到 origin。禁用 hooks、清空宿主 credential helper，只使用控制平面专用 PAT；绝不强推或推默认分支。",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string", description: "任务ID" } },
      required: ["taskId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    handler: async (args) => {
      const taskId = args.taskId as string;
      let audit: AuditHandle | undefined;
      try {
        const task = getTask(deps.db, taskId);
        if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
        audit = beginAudit(deps.db, { taskId, tool: "grande_push", input: { taskId } });
        audit.allowed();
        if (!audit.executing()) {
          throw new StateError("STALE_STATE", `任务 ${taskId} 的 push 审计句柄无法推进到 EXECUTING。`);
        }
        const result = pushTask(deps, taskId);
        audit.succeeded([task.worktreePath]);
        return {
          structuredContent: ok({
            taskId,
            data: result,
            hint: `任务 ${taskId} 的 ${result.branch} 已推送到 origin（${result.commit}）。`,
            taskContext: {
              branch: task.branch,
              filesChanged: 0,
              lastJob: null,
            },
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failedEnvelope(deps, taskId, error);
      }
    },
  };
}
