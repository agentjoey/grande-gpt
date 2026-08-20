import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import type { GithubLifecycleApi, GithubPullRequestDetail } from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createPrMergeTool } from "../src/prLifecycle.ts";
import { createTask } from "../src/tasks.ts";
import type { ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

const taskId = "task_pr_refresh";
const branch = "grande/pr-refresh";
const githubUrl = "https://github.com/fake-owner/fake-repo.git";
const token = "github_pat_refresh_abcdefghijklmnopqrstuvwxyz";
let root: string;
let layout: Layout;
let deps: ToolDeps;
let origin: string;
let canonical: string;
let taskRepo: string;
let baseCommit: string;
let taskHead: string;
let mergeCalls: number;

function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content, "utf8");
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

function attest(commitSha: string): void {
  const now = Date.now();
  const jobId = `job_${commitSha.slice(0, 8)}`;
  const toolchain = JSON.stringify({ node: "v24.0.0", pnpm: "10.0.0", lockfileSha256: "lock" });
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, taskId, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", toolchain);
  deps.db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`att_${commitSha.slice(0, 8)}`, taskId, commitSha, "unit-selfhost", jobId, 0, now - 10, now, toolchain);
}

function api(mergedInitially = false): GithubLifecycleApi {
  const pr = (): GithubPullRequestDetail => ({
    number: 51,
    url: "https://github.com/fake-owner/fake-repo/pull/51",
    state: mergedInitially ? "closed" : "open",
    draft: false,
    merged: mergedInitially,
    mergeable: true,
    headSha: taskHead,
    headRef: branch,
    baseRef: "main",
  });
  return {
    async findPullRequest() { return { number: 51, url: pr().url }; },
    async createPullRequest() { throw new Error("not used"); },
    async getPullRequest() { return pr(); },
    async listCheckRuns() { return []; },
    async listCommitStatuses() { return []; },
    async mergePullRequest() {
      mergeCalls += 1;
      git(origin, "update-ref", "refs/heads/main", taskHead, baseCommit);
      return { merged: true, sha: taskHead, message: "merged" };
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-merge-refresh-"));
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

  origin = join(root, "origin.git");
  git(root, "init", "--bare", "-q", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  baseCommit = commit(seed, "base.txt", "base\n", "base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "-u", "origin", "main");

  canonical = join(layout.workspaceRoot, "demo");
  git(layout.workspaceRoot, "clone", "-q", origin, canonical);
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  taskRepo = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(root, "clone", "-q", origin, taskRepo);
  git(taskRepo, "checkout", "-q", "-b", branch);
  taskHead = commit(taskRepo, "change.txt", "change\n", "task change");
  // GitHub PR head 对象当然已经存在于 remote；夹具也必须满足这一事实，否则
  // bare origin 无法把 main 更新到 taskHead，测试会在 fake merge 内部提前失败。
  git(taskRepo, "push", "-q", "origin", branch);

  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  createTask(deps.db, {
    taskId,
    repoId: "demo",
    branch,
    baseCommit,
    worktreePath: taskRepo,
    state: "READY",
  });
  attest(taskHead);
  mergeCalls = 0;
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("S16 grande_pr_merge canonical refresh", () => {
  it("merge 成功后立即 fetch+ff local canonical 到 remote main 的新 SHA", async () => {
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api(false),
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => taskHead,
    });

    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(true);
    expect(mergeCalls).toBe(1);
    expect(git(canonical, "rev-parse", "HEAD").trim()).toBe(taskHead);
    expect(envelope.data.canonicalRefresh).toMatchObject({
      branch: "main",
      relation: "remote_ahead",
      action: "fast-forward",
      after: taskHead,
    });
  });

  it("canonical dirty 时在发 GitHub merge 请求前 fail closed", async () => {
    writeFileSync(join(canonical, "base.txt"), "human dirty\n", "utf8");
    const remoteBefore = git(origin, "rev-parse", "refs/heads/main").trim();
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api(false),
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => taskHead,
    });

    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("CANONICAL_DIRTY");
    expect(mergeCalls).toBe(0);
    expect(git(origin, "rev-parse", "refs/heads/main").trim()).toBe(remoteBefore);
  });

  it("PR 已 merged 的幂等重试也会 refresh canonical，而不是直接返回 stale success", async () => {
    git(origin, "update-ref", "refs/heads/main", taskHead, baseCommit);
    expect(git(canonical, "rev-parse", "HEAD").trim()).toBe(baseCommit);
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api(true),
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => taskHead,
    });

    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(true);
    expect(envelope.data.existing).toBe(true);
    expect(envelope.data.canonicalRefresh.after).toBe(taskHead);
    expect(git(canonical, "rev-parse", "HEAD").trim()).toBe(taskHead);
    expect(mergeCalls).toBe(0);
  });
});
