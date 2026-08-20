import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import type {
  GithubCheckRun,
  GithubCommitStatus,
  GithubLifecycleApi,
  GithubPullRequestDetail,
} from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import {
  createPrMergeTool,
  createPrStatusTool,
  summarizeCi,
} from "../src/prLifecycle.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

let root: string;
let layout: Layout;
let deps: ToolDeps;
let worktree: string;
let currentCommit: string;
const taskId = "task_pr_lifecycle";
const branch = "grande/pr-lifecycle";
const token = "github_pat_lifecycle_abcdefghijklmnopqrstuvwxyz";
const githubUrl = "https://github.com/fake-owner/fake-repo.git";

function detail(overrides: Partial<GithubPullRequestDetail> = {}): GithubPullRequestDetail {
  return {
    number: 41,
    url: "https://github.com/fake-owner/fake-repo/pull/41",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    headSha: currentCommit,
    headRef: branch,
    baseRef: "main",
    ...overrides,
  };
}

function fakeApi(options: {
  pr?: GithubPullRequestDetail;
  checks?: GithubCheckRun[];
  statuses?: GithubCommitStatus[];
  mergeResult?: { merged: boolean; sha: string; message: string };
} = {}): GithubLifecycleApi & { mergeCalls: Array<{ number: number; sha: string }> } {
  const mergeCalls: Array<{ number: number; sha: string }> = [];
  const pr = options.pr ?? detail();
  return {
    mergeCalls,
    async findPullRequest() {
      return { number: pr.number, url: pr.url };
    },
    async createPullRequest() {
      throw new Error("not used");
    },
    async getPullRequest() {
      return pr;
    },
    async listCheckRuns() {
      return options.checks ?? [];
    },
    async listCommitStatuses() {
      return options.statuses ?? [];
    },
    async mergePullRequest(_owner, _repo, number, sha) {
      mergeCalls.push({ number, sha });
      return options.mergeResult ?? { merged: true, sha: "merge-sha", message: "merged" };
    },
  };
}

function attest(commit: string): void {
  const jobId = `job_${commit.slice(0, 8)}`;
  const now = Date.now();
  const toolchain = JSON.stringify({ node: "v24.0.0", pnpm: "10.0.0", lockfileSha256: "lock" });
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, taskId, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", toolchain);
  deps.db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`att_${commit.slice(0, 8)}`, taskId, commit, "unit-selfhost", jobId, 0, now - 10, now, toolchain);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-lifecycle-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(join(layout.controlRoot, "secrets", "github-token"), `${token}\n`, { mode: 0o600 });

  // S16 后 merge 会 preflight canonical。旧 S6 夹具原本只建 task worktree，没有
  // canonical repo；补一个无 remote 的本地 canonical，让这些测试仍只关注 PR/CI 门禁。
  // 真正 fetch+ff 行为由 prMergeCanonicalRefresh.test.ts 的 bare-origin 夹具承重。
  const canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "canonical base");
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "-q", "-b", branch);
  git(worktree, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "base");
  const baseCommit = git(worktree, "rev-parse", "HEAD").trim();
  writeFileSync(join(worktree, "change.txt"), "phase 4\n", "utf8");
  git(worktree, "add", "change.txt");
  git(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "change");
  currentCommit = git(worktree, "rev-parse", "HEAD").trim();
  git(worktree, "remote", "add", "origin", githubUrl);

  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  createTask(deps.db, {
    taskId,
    repoId: "demo",
    branch,
    baseCommit,
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("summarizeCi", () => {
  it("没有远端 CI 时明确返回 none，而不是伪装 passed", () => {
    expect(summarizeCi([], [])).toMatchObject({ state: "none", failed: [] });
  });

  it("pending 优先于 success；失败 check 输出被收敛成可诊断 logExcerpt", () => {
    const pending = summarizeCi(
      [{ id: 1, name: "unit", status: "in_progress", conclusion: null, detailsUrl: null, output: null }],
      [{ context: "lint", state: "success", description: null, targetUrl: null }],
    );
    expect(pending.state).toBe("pending");

    const failed = summarizeCi(
      [{
        id: 2,
        name: "unit",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://github.com/fake/run/2",
        output: { title: "Tests failed", summary: "2 failed", text: "expected true, received false" },
      }],
      [],
    );
    expect(failed.state).toBe("failed");
    expect(failed.failed[0]).toMatchObject({ name: "unit", conclusion: "failure" });
    expect(failed.failed[0]?.logExcerpt).toContain("expected true");
  });
});

describe("S6 PR lifecycle", () => {
  it("只新增 task-bound pr_status / pr_merge；不接受 repo/prNumber 作为调用参数", () => {
    const tools = buildTools(deps);
    const status = tools.find((tool) => tool.name === "grande_pr_status")!;
    const merge = tools.find((tool) => tool.name === "grande_pr_merge")!;
    expect(status).toBeDefined();
    expect(merge).toBeDefined();
    expect(status.inputSchema.properties).toEqual({ taskId: expect.any(Object) });
    expect(merge.inputSchema.properties).toEqual({ taskId: expect.any(Object) });
    expect(status.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(merge.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("pr_status 绑定 task.branch 与当前 head SHA，返回失败 CI 诊断", async () => {
    const api = fakeApi({
      checks: [{
        id: 9,
        name: "unit",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://github.com/fake/run/9",
        output: { title: "unit", summary: "failed", text: "stack tail" },
      }],
    });
    const tool = createPrStatusTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => currentCommit,
    });
    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.pr).toMatchObject({ number: 41, headRef: branch, headSha: currentCommit });
    expect(envelope.data.headMatchesTask).toBe(true);
    expect(envelope.data.ci.state).toBe("failed");
    expect(envelope.data.ci.failed[0].logExcerpt).toContain("stack tail");
  });

  it("pr_status 在 worktree 分支漂移时于任何 GitHub API 调用前拒绝", async () => {
    git(worktree, "switch", "-q", "-c", "grande/wrong-lifecycle-branch");
    let apiCreated = false;
    const tool = createPrStatusTool(deps, {
      apiFactory: () => {
        apiCreated = true;
        return fakeApi();
      },
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => currentCommit,
    });

    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toMatch(/grande\/pr-lifecycle|分支|branch/);
    expect(apiCreated).toBe(false);
  });

  it("CI failed/pending 或 PR head 已不是本地当前 HEAD 时 merge 必须拒绝，且不发 merge 请求", async () => {
    attest(currentCommit);
    for (const api of [
      fakeApi({ checks: [{ id: 1, name: "unit", status: "completed", conclusion: "failure", detailsUrl: null, output: null }] }),
      fakeApi({ checks: [{ id: 2, name: "unit", status: "in_progress", conclusion: null, detailsUrl: null, output: null }] }),
      fakeApi({ pr: detail({ headSha: "deadbeef" }), checks: [{ id: 3, name: "unit", status: "completed", conclusion: "success", detailsUrl: null, output: null }] }),
    ]) {
      const tool = createPrMergeTool(deps, {
        apiFactory: () => api,
        readRemoteUrl: () => githubUrl,
        readLocalHead: () => currentCommit,
      });
      const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
      expect(envelope.ok).toBe(false);
      expect(api.mergeCalls).toEqual([]);
    }
  });

  it("CI green 也必须有当前 SHA 的本机 attestation；旧 SHA 的验证不能替新 SHA 背书", async () => {
    attest("1111111111111111111111111111111111111111");
    const api = fakeApi({
      checks: [{ id: 1, name: "unit", status: "completed", conclusion: "success", detailsUrl: null, output: null }],
    });
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => currentCommit,
    });
    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/attestation|验证/i);
    expect(api.mergeCalls).toEqual([]);
  });

  it("CI green + 当前 SHA attestation 时用 expected sha 合并；none CI 也可在 attestation 门禁下合并", async () => {
    attest(currentCommit);
    for (const api of [
      fakeApi({ checks: [{ id: 1, name: "unit", status: "completed", conclusion: "success", detailsUrl: null, output: null }] }),
      fakeApi(),
    ]) {
      const tool = createPrMergeTool(deps, {
        apiFactory: () => api,
        readRemoteUrl: () => githubUrl,
        readLocalHead: () => currentCommit,
      });
      const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toMatchObject({ merged: true, prNumber: 41, headSha: currentCommit });
      expect(api.mergeCalls).toEqual([{ number: 41, sha: currentCommit }]);
      const audit = listAudit(deps.db, taskId).filter((row) => row.tool === "grande_pr_merge").at(-1);
      expect(audit?.decision).toBe("ALLOWED");
      expect(audit?.state).toBe("SUCCEEDED");
    }
  });

  it("draft / mergeable=false / mergeable=null 均不越过 GitHub 合并门槛", async () => {
    attest(currentCommit);
    for (const pr of [
      detail({ draft: true }),
      detail({ mergeable: false }),
      detail({ mergeable: null }),
    ]) {
      const api = fakeApi({ pr });
      const tool = createPrMergeTool(deps, {
        apiFactory: () => api,
        readRemoteUrl: () => githubUrl,
        readLocalHead: () => currentCommit,
      });
      const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
      expect(envelope.ok).toBe(false);
      expect(api.mergeCalls).toEqual([]);
    }
  });
});
