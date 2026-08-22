import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import type { GithubLifecycleApi, GithubPullRequestDetail } from "../src/githubApi.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import type { HostVerifierRequest } from "../src/hostVerifier.ts";

let root: string;
let worktree: string;
let db: ReturnType<typeof openDb>;
let layout: ReturnType<typeof loadLayout>;
const taskId = "task_activation_runtime";
const branch = "grande/activation-runtime";
const commit = "a".repeat(40);

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

async function productionModule(): Promise<Record<string, any>> {
  try {
    return await import("../src/hostVerificationProduction.ts");
  } catch {
    return {};
  }
}

function request(): HostVerifierRequest {
  return { taskId, repoId: "grande-gpt", commit, level: "smoke" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-verification-production-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(join(layout.controlRoot, "secrets", "github-token"), "github_pat_activation_runtime_secret\n", { mode: 0o600 });
  db = openDb(layout);

  worktree = join(root, "task-worktree");
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "-q", "-b", branch);
  writeFileSync(join(worktree, "README.md"), "runtime\n", "utf8");
  git(worktree, "add", "README.md");
  git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "runtime");
  git(worktree, "remote", "add", "origin", "https://github.com/fake-owner/grande-gpt.git");
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch,
    baseCommit: git(worktree, "rev-parse", "HEAD"),
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  delete process.env.GRANDE_WORKSPACE;
  delete process.env.GRANDE_CONTROL;
  rmSync(root, { recursive: true, force: true });
});

describe("production Host Verifier runtime factory", () => {
  it("keeps manual mode inert and does not construct a coordinator", async () => {
    const mod = await productionModule();
    expect(typeof mod.createProductionHostVerification).toBe("function");
    if (typeof mod.createProductionHostVerification !== "function") return;

    let constructions = 0;
    const result = mod.createProductionHostVerification(
      { db, layout },
      { mode: "manual", concurrency: 1 },
      { coordinatorFactory: () => { constructions += 1; throw new Error("manual must not construct coordinator"); } },
    );

    expect(result).toEqual({ hostVerificationMode: "manual", hostVerifierCoordinator: undefined });
    expect(constructions).toBe(0);
  });

  it("constructs exactly one shared coordinator for auto mode", async () => {
    const mod = await productionModule();
    expect(typeof mod.createProductionHostVerification).toBe("function");
    if (typeof mod.createProductionHostVerification !== "function") return;

    let constructions = 0;
    const fakeCoordinator = { marker: "shared" };
    const result = mod.createProductionHostVerification(
      { db, layout },
      { mode: "auto", concurrency: 1 },
      { coordinatorFactory: () => { constructions += 1; return fakeCoordinator; } },
    );

    expect(result.hostVerificationMode).toBe("auto");
    expect(result.hostVerifierCoordinator).toBe(fakeCoordinator);
    expect(constructions).toBe(1);
  });

  it("reads the current PR head only from the task branch on the trusted GitHub remote", async () => {
    const mod = await productionModule();
    expect(typeof mod.createTrustedPrHeadReader).toBe("function");
    if (typeof mod.createTrustedPrHeadReader !== "function") return;

    const calls: Array<Record<string, unknown>> = [];
    const detail: GithubPullRequestDetail = {
      number: 17,
      url: "https://github.com/fake-owner/grande-gpt/pull/17",
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      headSha: commit,
      headRef: branch,
      baseRef: "main",
    };
    const api: GithubLifecycleApi = {
      async findPullRequest(owner, repo, head, state) {
        calls.push({ op: "find", owner, repo, head, state });
        return { number: 17, url: detail.url };
      },
      async createPullRequest() { throw new Error("not used"); },
      async getPullRequest(owner, repo, number) {
        calls.push({ op: "get", owner, repo, number });
        return detail;
      },
      async listCheckRuns() { return []; },
      async listCommitStatuses() { return []; },
      async mergePullRequest() { throw new Error("not used"); },
    };

    const reader = mod.createTrustedPrHeadReader({ db, layout }, { apiFactory: () => api });
    await expect(reader(request())).resolves.toBe(commit);
    expect(calls).toEqual([
      { op: "find", owner: "fake-owner", repo: "grande-gpt", head: branch, state: "all" },
      { op: "get", owner: "fake-owner", repo: "grande-gpt", number: 17 },
    ]);

    detail.headRef = "other-branch";
    await expect(reader(request())).resolves.toBeNull();
  });
});
