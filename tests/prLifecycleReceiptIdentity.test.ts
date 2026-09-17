import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import type { GithubLifecycleApi, GithubPullRequestDetail } from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createPrMergeTool } from "../src/prLifecycle.ts";
import { recordTaskPrOpened } from "../src/taskPrReceipt.ts";
import { createTask } from "../src/tasks.ts";
import type { ToolDeps } from "../src/toolsCore.ts";

const TASK = "task_pr_receipt_identity";
const BRANCH = "grande/pr-receipt-identity";
const TOKEN = "github_pat_receipt_identity_abcdefghijklmnopqrstuvwxyz";
const REMOTE = "https://github.com/fake-owner/fake-repo.git";
const OLD_PR_URL = "https://github.com/fake-owner/fake-repo/pull/41";
const NEW_PR_URL = "https://github.com/fake-owner/fake-repo/pull/99";

const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null", "-c", "user.name=GrandeGPT Test", "-c", "user.email=grande-test@example.com", ...args,
], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string;
let layout: Layout;
let deps: ToolDeps;
let worktree: string;
let headSha: string;

function attest(commit: string): void {
  const now = Date.now();
  const jobId = `job_${commit.slice(0, 8)}`;
  const toolchain = JSON.stringify({ node: "v24.0.0", pnpm: "10.0.0", lockfileSha256: "lock" });
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, TASK, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", toolchain);
  deps.db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`att_${commit.slice(0, 8)}`, TASK, commit, "unit-selfhost", jobId, 0, now - 10, now, toolchain);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-receipt-identity-"));
  mkdirSync(join(root, "workspace"), { recursive: true });
  mkdirSync(join(root, "control"), { recursive: true });
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(join(layout.controlRoot, "secrets", "github-token"), `${TOKEN}\n`, { mode: 0o600 });

  worktree = join(layout.worktreesRoot, "demo", TASK);
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "-q", "-b", BRANCH);
  git(worktree, "commit", "--allow-empty", "-q", "-m", "base");
  headSha = git(worktree, "rev-parse", "HEAD");
  git(worktree, "remote", "add", "origin", REMOTE);

  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  createTask(deps.db, {
    taskId: TASK,
    repoId: "demo",
    branch: BRANCH,
    baseCommit: headSha,
    worktreePath: worktree,
    state: "READY",
  });
  attest(headSha);
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
});

function currentPr(): GithubPullRequestDetail {
  return {
    number: 99,
    url: NEW_PR_URL,
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    headSha,
    headRef: BRANCH,
    baseRef: "main",
  };
}

describe("durable task↔PR identity before merge mutation", () => {
  it("refuses a different current PR for the same task branch before mergePullRequest", async () => {
    recordTaskPrOpened(deps.db, {
      taskId: TASK,
      prNumber: 41,
      prUrl: OLD_PR_URL,
      headSha,
      baseRef: "main",
      baseSha: null,
    });

    let mergeCalls = 0;
    const pr = currentPr();
    const api: GithubLifecycleApi = {
      async findPullRequest() { return { number: pr.number, url: pr.url }; },
      async createPullRequest() { throw new Error("not used"); },
      async getPullRequest() { return pr; },
      async listCheckRuns() { return []; },
      async listCommitStatuses() { return []; },
      async mergePullRequest() {
        mergeCalls += 1;
        return { merged: true, sha: "a".repeat(40), message: "merged" };
      },
    };

    const tool = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => REMOTE,
      readLocalHead: () => headSha,
      canonicalRefresher: () => ({
        action: "none",
        relation: "no_remote",
        branch: "main",
        before: headSha,
        after: headSha,
        remoteHead: null,
      }),
    });

    const envelope = (await tool.handler({ taskId: TASK })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/identity|durable|PR/i);
    expect(mergeCalls).toBe(0);
  });
});
