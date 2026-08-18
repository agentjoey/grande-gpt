import { redactToken } from "./githubAuth.ts";

export interface GithubPullRequestCreateArgs {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  /** S6：完整闭环不再制造人为 Draft 断点；类型层也不允许调用方改回 true。 */
  draft: false;
}

export interface GithubPullRequestDetail {
  number: number;
  url: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  headSha: string;
  headRef: string;
  baseRef: string;
}

export interface GithubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  output: { title: string | null; summary: string | null; text: string | null } | null;
}

export interface GithubCommitStatus {
  context: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
}

export interface GithubMergeResult {
  merged: boolean;
  sha: string;
  message: string;
}

export interface GithubApi {
  /** 按 head 分支查 PR。S3 默认只查 open；S6 lifecycle 可显式查 all。 */
  findPullRequest(
    owner: string,
    repo: string,
    head: string,
    state?: "open" | "all",
  ): Promise<{ number: number; url: string } | null>;
  /** S6 创建 ready PR；draft 策略由 GithubPullRequestCreateArgs 的字面量约束。 */
  createPullRequest(args: GithubPullRequestCreateArgs): Promise<{ number: number; url: string }>;
}

/** S6 在现有 GitHub API wrapper 上增量扩展，不另建基础设施。 */
export interface GithubLifecycleApi extends GithubApi {
  getPullRequest(owner: string, repo: string, number: number): Promise<GithubPullRequestDetail>;
  listCheckRuns(owner: string, repo: string, ref: string): Promise<GithubCheckRun[]>;
  listCommitStatuses(owner: string, repo: string, ref: string): Promise<GithubCommitStatus[]>;
  mergePullRequest(owner: string, repo: string, number: number, expectedHeadSha: string): Promise<GithubMergeResult>;
}

export class GithubApiError extends Error {
  readonly code = "GITHUB_API_FAILED";
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

type FetchLike = typeof fetch;

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function responseJson(response: Response, token: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    const detail = redactToken(text || `${response.status} ${response.statusText}`, token);
    const credentialHint = response.status === 401 || response.status === 403
      ? "GitHub PAT 已失效、过期或权限不足；请检查专用 PAT。S6 建议 Commit statuses:read / Actions:read，merge 需要 Contents:write。"
      : "GitHub API 请求失败。";
    throw new GithubApiError(`${credentialHint} HTTP ${response.status}：${detail}`, response.status);
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new GithubApiError(
      redactToken(`GitHub API 返回了无法解析的 JSON：${error instanceof Error ? error.message : String(error)}`, token),
    );
  }
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GithubApiError(`GitHub API 返回的 ${context} 结构不是 object。`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new GithubApiError(`GitHub API 返回的 ${context} 缺少 ${key}。`);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function pullRequest(value: unknown, token: string): { number: number; url: string } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof record.number !== "number" || typeof record.html_url !== "string") {
    throw new GithubApiError(redactToken("GitHub API 返回的 PR 结构缺少 number/html_url。", token));
  }
  return { number: record.number, url: record.html_url };
}

function pullRequestDetail(value: unknown, token: string): GithubPullRequestDetail {
  const record = object(value, "PR");
  const head = object(record.head, "PR.head");
  const base = object(record.base, "PR.base");
  if (typeof record.number !== "number" || typeof record.html_url !== "string") {
    throw new GithubApiError(redactToken("GitHub API 返回的 PR 结构缺少 number/html_url。", token));
  }
  if (record.state !== "open" && record.state !== "closed") {
    throw new GithubApiError("GitHub API 返回的 PR.state 不是 open/closed。");
  }
  if (typeof record.draft !== "boolean" || typeof record.merged !== "boolean") {
    throw new GithubApiError("GitHub API 返回的 PR 缺少 draft/merged。 ");
  }
  if (record.mergeable !== null && typeof record.mergeable !== "boolean") {
    throw new GithubApiError("GitHub API 返回的 PR.mergeable 不是 boolean/null。 ");
  }
  return {
    number: record.number,
    url: record.html_url,
    state: record.state,
    draft: record.draft,
    merged: record.merged,
    mergeable: record.mergeable as boolean | null,
    headSha: requiredString(head, "sha", "PR.head"),
    headRef: requiredString(head, "ref", "PR.head"),
    baseRef: requiredString(base, "ref", "PR.base"),
  };
}

function checkRun(value: unknown): GithubCheckRun {
  const record = object(value, "check run");
  if (typeof record.id !== "number") throw new GithubApiError("GitHub check run 缺少 id。 ");
  const outputRecord = record.output === null || record.output === undefined
    ? null
    : object(record.output, "check run.output");
  return {
    id: record.id,
    name: requiredString(record, "name", "check run"),
    status: requiredString(record, "status", "check run"),
    conclusion: nullableString(record.conclusion),
    detailsUrl: nullableString(record.details_url),
    output: outputRecord
      ? {
          title: nullableString(outputRecord.title),
          summary: nullableString(outputRecord.summary),
          text: nullableString(outputRecord.text),
        }
      : null,
  };
}

function workflowRun(value: unknown): GithubCheckRun {
  const record = object(value, "workflow run");
  if (typeof record.id !== "number") throw new GithubApiError("GitHub workflow run 缺少 id。 ");
  return {
    id: record.id,
    name: requiredString(record, "name", "workflow run"),
    status: requiredString(record, "status", "workflow run"),
    conclusion: nullableString(record.conclusion),
    detailsUrl: nullableString(record.html_url),
    output: null,
  };
}

function commitStatus(value: unknown): GithubCommitStatus {
  const record = object(value, "commit status");
  return {
    context: requiredString(record, "context", "commit status"),
    state: requiredString(record, "state", "commit status"),
    description: nullableString(record.description),
    targetUrl: nullableString(record.target_url),
  };
}

/** 生产实现只用 Node 24 内置 fetch；token 只进入单次请求头，不写配置或环境变量。 */
export function createGithubApi(token: string, fetchImpl: FetchLike = fetch): GithubLifecycleApi {
  const request = async (url: string, init?: RequestInit): Promise<unknown> => {
    try {
      const response = await fetchImpl(url, { ...init, headers: { ...headers(token), ...init?.headers } });
      return await responseJson(response, token);
    } catch (error) {
      if (error instanceof GithubApiError) throw error;
      throw new GithubApiError(
        redactToken(`GitHub API 连接失败：${error instanceof Error ? error.message : String(error)}`, token),
      );
    }
  };

  return {
    async findPullRequest(owner, repo, head, state = "open") {
      const query = new URLSearchParams({ state, head: `${owner}:${head}`, per_page: "1" });
      const value = await request(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query}`,
      );
      if (!Array.isArray(value) || value.length === 0) return null;
      return pullRequest(value[0], token);
    },

    async createPullRequest(args) {
      const value = await request(
        `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`,
        {
          method: "POST",
          body: JSON.stringify({
            head: args.head,
            base: args.base,
            title: args.title,
            body: args.body,
            draft: false,
          }),
        },
      );
      return pullRequest(value, token);
    },

    async getPullRequest(owner, repo, number) {
      const value = await request(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      );
      return pullRequestDetail(value, token);
    },

    async listCheckRuns(owner, repo, ref) {
      try {
        const value = object(await request(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/` +
            `${encodeURIComponent(ref)}/check-runs?per_page=100`,
        ), "check runs response");
        if (!Array.isArray(value.check_runs)) {
          throw new GithubApiError("GitHub API 返回的 check runs 缺少 check_runs array。 ");
        }
        return value.check_runs.map(checkRun);
      } catch (error) {
        if (!(error instanceof GithubApiError) || error.status !== 403) throw error;
        const query = new URLSearchParams({ head_sha: ref, per_page: "100" });
        const value = object(await request(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${query}`,
        ), "workflow runs response");
        if (!Array.isArray(value.workflow_runs)) {
          throw new GithubApiError("GitHub API 返回的 workflow runs 缺少 workflow_runs array。 ");
        }
        return value.workflow_runs.map(workflowRun);
      }
    },

    async listCommitStatuses(owner, repo, ref) {
      const value = await request(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/` +
          `${encodeURIComponent(ref)}/statuses?per_page=100`,
      );
      if (!Array.isArray(value)) throw new GithubApiError("GitHub API 返回的 commit statuses 不是 array。 ");
      return value.map(commitStatus);
    },

    async mergePullRequest(owner, repo, number, expectedHeadSha) {
      const value = object(await request(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`,
        { method: "PUT", body: JSON.stringify({ sha: expectedHeadSha }) },
      ), "merge response");
      if (typeof value.merged !== "boolean" || typeof value.sha !== "string" || typeof value.message !== "string") {
        throw new GithubApiError("GitHub API 返回的 merge 结构缺少 merged/sha/message。 ");
      }
      return { merged: value.merged, sha: value.sha, message: value.message };
    },
  };
}
