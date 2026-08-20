import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import type { GithubLifecycleApi, GithubPullRequestDetail } from "../src/githubApi.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createPrMergeTool } from "../src/prLifecycle.ts";
import { createTask } from "../src/tasks.ts";
import type { ToolDeps } from "../src/toolsCore.ts";

const taskId = "task_s18_verification";
const branch = "grande/s18-verification";
let headSha: string;
const token = "github_pat_s18_abcdefghijklmnopqrstuvwxyz";

let root: string;
let deps: ToolDeps;

function prDetail(): GithubPullRequestDetail {
  return {
    number: 18,
    url: "https://github.com/fake-owner/grande-gpt/pull/18",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    headSha,
    headRef: branch,
    baseRef: "main",
  };
}

function fakeApi(): GithubLifecycleApi & { mergeCalls: string[] } {
  const mergeCalls: string[] = [];
  return {
    mergeCalls,
    async findPullRequest() {
      return { number: 18, url: "https://github.com/fake-owner/grande-gpt/pull/18" };
    },
    async createPullRequest() {
      throw new Error("not used");
    },
    async getPullRequest() {
      return prDetail();
    },
    async listCheckRuns() {
      return [{
        id: 1,
        name: "unit",
        status: "completed",
        conclusion: "success",
        detailsUrl: null,
        output: null,
      }];
    },
    async listCommitStatuses() {
      return [];
    },
    async mergePullRequest(_owner, _repo, _number, sha) {
      mergeCalls.push(sha);
      return { merged: true, sha: "merge-sha", message: "merged" };
    },
  };
}

function attestCurrentHead(): void {
  const now = Date.now();
  const toolchain = JSON.stringify({ node: "v24.0.0", pnpm: "10.0.0", lockfileSha256: "lock" });
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run("job_s18", taskId, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", toolchain);
  deps.db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("att_s18", taskId, headSha, "unit-selfhost", "job_s18", 0, now - 10, now, toolchain);
}

function writeOuterTestReceipt(commit: string): void {
  const now = Date.now();
  deps.db.prepare(
    `INSERT INTO outer_test_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)
     ON CONFLICT(taskId) DO UPDATE SET receiptJson=excluded.receiptJson, updatedAt=excluded.updatedAt`,
  ).run(taskId, JSON.stringify({
    taskId,
    commit,
    profile: "unit-selfhost",
    files: ["tests/sandbox.test.ts"],
    passedAt: now,
  }), now);
}

function mergeTool(api: ReturnType<typeof fakeApi>) {
  return createPrMergeTool(deps, {
    apiFactory: () => api,
    readRemoteUrl: () => "https://github.com/fake-owner/grande-gpt.git",
    readLocalHead: () => headSha,
    canonicalRefresher: () => ({
      action: "none",
      relation: "equal",
      branch: "main",
      before: "base",
      after: "base",
      remoteHead: null,
    }),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "s18-verification-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  const layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(join(layout.controlRoot, "secrets", "github-token"), `${token}\n`, { mode: 0o600 });
  deps = { db: openDb(layout), layout, defaultRepoId: "grande-gpt" };
  const worktreePath = join(root, "worktree");
  mkdirSync(worktreePath, { recursive: true });
  execFileSync("git", ["init", "-b", branch], { cwd: worktreePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: worktreePath });
  execFileSync("git", ["config", "user.name", "Grande Test"], { cwd: worktreePath });
  writeFileSync(join(worktreePath, "README.md"), "verification fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: worktreePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: worktreePath, stdio: "ignore" });
  headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
  createTask(deps.db, {
    taskId,
    repoId: "grande-gpt",
    branch,
    baseCommit: "base",
    worktreePath,
    state: "READY",
  });
  attestCurrentHead();
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("S18 Verification Integrity", () => {
  it("current SHA attestation + green CI 仍不能替代 host outer-test receipt", async () => {
    const api = fakeApi();
    const envelope = (await mergeTool(api).handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/outer-test|外层测试|receipt/i);
    expect(api.mergeCalls).toEqual([]);
  });

  it("旧 SHA 的 outer-test receipt 不能给当前 PR head 背书", async () => {
    writeOuterTestReceipt("1111111111111111111111111111111111111111");
    const api = fakeApi();
    const envelope = (await mergeTool(api).handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/outer-test|receipt/i);
    expect(api.mergeCalls).toEqual([]);
  });

  it("current SHA attestation + green CI + current SHA outer-test receipt 才允许 merge", async () => {
    writeOuterTestReceipt(headSha);
    const api = fakeApi();
    const envelope = (await mergeTool(api).handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ merged: true, headSha });
    expect(api.mergeCalls).toEqual([headSha]);
  });
});
