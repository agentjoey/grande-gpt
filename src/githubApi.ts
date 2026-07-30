import { redactToken } from "./githubAuth.ts";

export interface GithubPullRequestCreateArgs {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  /** 字面量 true：类型层也不允许调用方传 false。 */
  draft: true;
}

export interface GithubApi {
  /** 按 head 分支查现有 open PR。返回 null 表示没有。 */
  findPullRequest(owner: string, repo: string, head: string): Promise<{ number: number; url: string } | null>;
  /** 开一个 draft PR；draft 在参数类型上恒为 true。 */
  createPullRequest(args: GithubPullRequestCreateArgs): Promise<{ number: number; url: string }>;
}

export class GithubApiError extends Error {
  readonly code = "GITHUB_API_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "GithubApiError";
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
      ? "GitHub PAT 已失效、过期或权限不足；请在控制平面更换专用 PAT。"
      : "GitHub API 请求失败。";
    throw new GithubApiError(`${credentialHint} HTTP ${response.status}：${detail}`);
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

function pullRequest(value: unknown, token: string): { number: number; url: string } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof record.number !== "number" || typeof record.html_url !== "string") {
    throw new GithubApiError(redactToken("GitHub API 返回的 PR 结构缺少 number/html_url。", token));
  }
  return { number: record.number, url: record.html_url };
}

/** 生产实现只用 Node 24 内置 fetch；token 只进入单次请求头，不写配置或环境变量。 */
export function createGithubApi(token: string, fetchImpl: FetchLike = fetch): GithubApi {
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
    async findPullRequest(owner, repo, head) {
      const query = new URLSearchParams({ state: "open", head: `${owner}:${head}`, per_page: "1" });
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
            draft: true,
          }),
        },
      );
      return pullRequest(value, token);
    },
  };
}
