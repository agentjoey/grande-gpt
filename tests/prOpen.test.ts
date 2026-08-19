import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import type { GithubApi, GithubPullRequestCreateArgs } from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createPrOpenTool, type RemoteGithubState } from "../src/prOpen.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

let root: string;
let layout: Layout;
let worktree: string;
let deps: ToolDeps;
let currentCommit: string;
const taskId = "task_pr";
const branch = "grande/pr-test";
const token = "github_pat_pr_test_abcdefghijklmnopqrstuvwxyz";
const githubUrl = "https://github.com/fake-owner/fake-repo.git";

type Call = { name: "find" | "create"; args: unknown };

function fakeApi(
  existing: { number: number; url: string } | null = null,
  order?: string[],
): GithubApi & { calls: Call[]; created: GithubPullRequestCreateArgs[] } {
  const calls: Call[] = [];
  const created: GithubPullRequestCreateArgs[] = [];
  return {
    calls,
    created,
    async findPullRequest(owner, repo, head) {
      order?.push("find");
      calls.push({ name: "find", args: { owner, repo, head } });
      return existing;
    },
    async createPullRequest(args) {
      order?.push("create");
      calls.push({ name: "create", args });
      created.push(args);
      return { number: 42, url: "https://github.com/fake-owner/fake-repo/pull/42" };
    },
  };
}

function remoteState(overrides: Partial<RemoteGithubState> = {}): RemoteGithubState {
  return { defaultBranch: "main", commit: currentCommit, ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-open-"));
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

  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "-q", "-b", branch);
  git(worktree, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "base");
  const baseCommit = git(worktree, "rev-parse", "HEAD").trim();
  writeFileSync(join(worktree, "change.txt"), "ready for PR\n", "utf8");
  git(worktree, "add", "change.txt");
  git(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "change");
  currentCommit = git(worktree, "rev-parse", "HEAD").trim();
  git(worktree, "remote", "add", "origin", githubUrl);

  const db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "demo",
    branch,
    baseCommit,
    worktreePath: worktree,
    state: "READY",
  });
  deps = { db, layout, defaultRepoId: "demo" };
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
});

async function callPr(
  api: GithubApi,
  options: {
    url?: string;
    state?: RemoteGithubState;
    id?: string;
    body?: string;
    extraArgs?: Record<string, unknown>;
    order?: string[];
  } = {},
): Promise<Record<string, any>> {
  const tool = createPrOpenTool(deps, {
    apiFactory: () => api,
    readRemoteUrl: () => {
      options.order?.push("url");
      return options.url ?? githubUrl;
    },
    inspectRemoteState: () => {
      options.order?.push("state");
      return options.state ?? remoteState();
    },
  });
  return (await tool.handler({
    taskId: options.id ?? taskId,
    title: "Change",
    body: options.body ?? "Please review this change.",
    ...options.extraArgs,
  })).structuredContent as Record<string, any>;
}

describe("grande_pr_open", () => {
  it("S6：新 PR 恒为 ready（draft=false）；调用方偷偷传 draft=true 也不能制造人工断点", async () => {
    const api = fakeApi();
    const result = await callPr(api, { extraArgs: { draft: true } });
    expect(result.ok).toBe(true);
    expect(api.created).toHaveLength(1);
    expect(api.created[0]?.draft).toBe(false);
  });

  it("AC-S3-10：剥掉模型伪造尾注，再追加唯一可信尾注", async () => {
    const api = fakeApi();
    const forged = [
      "real body",
      "Grande-Task: forged-task",
      "Grande-Attestation: forged",
      "Grande-Commit: forged-sha",
    ].join("\n");
    await callPr(api, { body: forged });

    const body = api.created[0]?.body ?? "";
    expect(body.match(/^Grande-Task:/gm)).toHaveLength(1);
    expect(body.match(/^Grande-Attestation:/gm)).toHaveLength(1);
    expect(body.match(/^Grande-Commit:/gm)).toHaveLength(1);
    expect(body).toContain(`Grande-Task: ${taskId}`);
    expect(body).toContain("Grande-Attestation: none");
    expect(body).toContain(`Grande-Commit: ${currentCommit}`);
    expect(body).not.toContain("forged-task");
    expect(body).not.toContain("Grande-Attestation: forged");
    expect(body).not.toContain("Grande-Commit: forged-sha");
  });

  it("AC-S3-11：已有 PR 时直接返回，不创建第二个，也不探测默认分支/SHA或写创建审计", async () => {
    const existing = { number: 7, url: "https://github.com/fake-owner/fake-repo/pull/7" };
    const order: string[] = [];
    const api = fakeApi(existing, order);
    const result = await callPr(api, { order });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ number: 7, url: existing.url, existing: true });
    expect(api.created).toHaveLength(0);
    expect(api.calls.map((call) => call.name)).toEqual(["find"]);
    expect(order).toEqual(["url", "find"]);
    expect(listAudit(deps.db, taskId).filter((row) => row.tool === "grande_pr_open")).toEqual([]);
  });

  it("行为顺序是 URL 解析 → 幂等查询 → remote state → create", async () => {
    const order: string[] = [];
    const api = fakeApi(null, order);
    await callPr(api, { order });
    expect(order).toEqual(["url", "find", "state", "create"]);
  });

  it("remote 不是 github.com HTTPS 时在 state/API 之前拒绝", async () => {
    const order: string[] = [];
    const api = fakeApi(null, order);
    const result = await callPr(api, { url: "/tmp/local-bare.git", order });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/github\.com|https/);
    expect(api.calls).toEqual([]);
    expect(order).toEqual(["url"]);
  });

  it("TASK_NOT_FOUND 在任何 remote/API 操作之前返回", async () => {
    const order: string[] = [];
    const api = fakeApi(null, order);
    const result = await callPr(api, { id: "task_missing", order });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("TASK_NOT_FOUND");
    expect(api.calls).toEqual([]);
    expect(order).toEqual([]);
  });

  it("创建成功写入 ALLOWED/SUCCEEDED 审计账本", async () => {
    const api = fakeApi();
    expect((await callPr(api)).ok).toBe(true);
    const row = listAudit(deps.db, taskId).find((candidate) => candidate.tool === "grande_pr_open");
    expect(row?.decision).toBe("ALLOWED");
    expect(row?.state).toBe("SUCCEEDED");
    expect(row?.pathsTouched).toContain(worktree);
  });

  it("S9 onboarding tools 加入后，所有网络工具仍显式 openWorldHint=true，15 个本地工具保持 false", () => {
    const tools = buildTools(deps);
    expect(
      tools.filter((tool) => tool.annotations.openWorldHint).map((tool) => tool.name).sort(),
    ).toEqual([
      "grande_capability_inspect",
      "grande_capability_invoke",
      "grande_capability_list",
      "grande_deploy",
      "grande_deploy_rollback",
      "grande_deploy_verify",
      "grande_pr_merge",
      "grande_pr_open",
      "grande_pr_status",
      "grande_push",
    ]);
    expect(tools.filter((tool) => !tool.annotations.openWorldHint)).toHaveLength(15);
    expect(tools.find((tool) => tool.name === "grande_pr_open")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });
});
