import { describe, expect, it } from "vitest";
import { createGithubApi } from "../src/githubApi.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub CI API fallback", () => {
  it("check-runs 对 fine-grained PAT 返回 403 时回退到 Actions workflow runs", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/check-runs")) {
        return jsonResponse({ message: "Resource not accessible by personal access token" }, 403);
      }
      if (url.includes("/actions/runs")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 11,
              name: "CI",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/fake/repo/actions/runs/11",
            },
            {
              id: 12,
              name: "Lint",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/fake/repo/actions/runs/12",
            },
          ],
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const api = createGithubApi("github_pat_test_abcdefghijklmnopqrstuvwxyz", fetchImpl);
    const runs = await api.listCheckRuns("fake", "repo", "abc123");

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("/commits/abc123/check-runs");
    expect(seen[1]).toContain("/actions/runs?");
    expect(seen[1]).toContain("head_sha=abc123");
    expect(runs).toEqual([
      {
        id: 11,
        name: "CI",
        status: "in_progress",
        conclusion: null,
        detailsUrl: "https://github.com/fake/repo/actions/runs/11",
        output: null,
      },
      {
        id: 12,
        name: "Lint",
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://github.com/fake/repo/actions/runs/12",
        output: null,
      },
    ]);
  });

  it("check-runs 的非 403 错误不回退 Actions", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      seen.push(url);
      return jsonResponse({ message: "server error" }, 500);
    }) as typeof fetch;

    const api = createGithubApi("github_pat_test_abcdefghijklmnopqrstuvwxyz", fetchImpl);
    await expect(api.listCheckRuns("fake", "repo", "abc123")).rejects.toMatchObject({ status: 500 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/check-runs");
  });

  it("Checks 403 后 Actions 也拒绝时继续 fail closed，不伪装 CI=none", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      seen.push(url);
      return jsonResponse({ message: "Resource not accessible by personal access token" }, 403);
    }) as typeof fetch;

    const api = createGithubApi("github_pat_test_abcdefghijklmnopqrstuvwxyz", fetchImpl);
    await expect(api.listCheckRuns("fake", "repo", "abc123")).rejects.toMatchObject({ status: 403 });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("/actions/runs?");
  });
});
