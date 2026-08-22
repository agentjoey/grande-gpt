import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import type { GithubApi, GithubLifecycleApi, GithubPullRequestCreateArgs, GithubPullRequestDetail } from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createPrMergeTool } from "../src/prLifecycle.ts";
import { wrapPrMergeToolD2 } from "../src/prMergeD2.ts";
import { createPrOpenTool } from "../src/prOpen.ts";
import { pushTask } from "../src/push.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask, getTask } from "../src/tasks.ts";
import type { ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

let root: string;
let layout: Layout;
let canonical: string;
let worktree: string;
let deps: ToolDeps;
let baseCommit: string;
let headCommit: string;
const taskId = "task_d2_external";
const branch = "grande/d2-external";
const token = "github_pat_d2_external_abcdefghijklmnopqrstuvwxyz";
const githubUrl = "https://github.com/fake-owner/fake-repo.git";

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
  root = mkdtempSync(join(tmpdir(), "d2-external-"));
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

  canonical = join(workspace, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "base");
  baseCommit = git(canonical, "rev-parse", "HEAD");
  saveRegistry(layout, [{ repoId: "demo", path: canonical, registered: true }]);

  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", branch, worktree, baseCommit);
  writeFileSync(join(worktree, "change.txt"), "D2\n", "utf8");
  git(worktree, "add", "change.txt");
  git(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "D2 change");
  headCommit = git(worktree, "rev-parse", "HEAD");
  git(canonical, "remote", "add", "origin", githubUrl);

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

function pr(overrides: Partial<GithubPullRequestDetail> = {}): GithubPullRequestDetail {
  return {
    number: 51,
    url: "https://github.com/fake-owner/fake-repo/pull/51",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    headSha: headCommit,
    headRef: branch,
    baseRef: "main",
    ...overrides,
  };
}

function lifecycleApi(options: {
  afterMergeError?: GithubPullRequestDetail;
  canonicalMergeSha?: string;
} = {}): GithubLifecycleApi & { readonly mergeCalls: number; readonly getCalls: number } {
  let mergeCalls = 0;
  let getCalls = 0;
  let current = pr();
  return {
    get mergeCalls() { return mergeCalls; },
    get getCalls() { return getCalls; },
    async findPullRequest() { return { number: current.number, url: current.url }; },
    async createPullRequest() { throw new Error("not used"); },
    async getPullRequest() { getCalls += 1; return current; },
    async listCheckRuns() { return []; },
    async listCommitStatuses() { return []; },
    async mergePullRequest() {
      mergeCalls += 1;
      if (options.afterMergeError) {
        current = options.afterMergeError;
        throw new Error("simulated merge response loss");
      }
      const sha = options.canonicalMergeSha ?? "merge-sha";
      current = pr({ state: "closed", merged: true, mergeable: null });
      return { merged: true, sha, message: "merged" };
    },
  };
}

function wrappedMergeTool(
  api: GithubLifecycleApi,
  canonicalRefresher: () => { action: "none" | "fast-forward"; relation: "equal" | "remote_ahead"; branch: string; before: string; after: string; remoteHead: string | null },
) {
  const common = {
    apiFactory: () => api,
    readRemoteUrl: () => githubUrl,
    canonicalRefresher,
  };
  const base = createPrMergeTool(deps, { ...common, readLocalHead: () => headCommit });
  return wrapPrMergeToolD2(deps, base, common);
}

describe("D2 observe-before-retry external writes", () => {
  it("observes the remote branch after a push response loss and never issues a second push", () => {
    const calls: string[][] = [];
    let remoteHead: string | null = null;
    const fakeGit = (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "remote") return githubUrl;
      if (args[0] === "ls-remote" && args.includes("--symref")) {
        return `ref: refs/heads/main HEAD\n${baseCommit}\tHEAD\n`;
      }
      if (args[0] === "push") {
        remoteHead = headCommit;
        throw new Error("simulated push response loss");
      }
      if (args[0] === "ls-remote" && args.includes("--heads")) {
        return remoteHead ? `${remoteHead}\trefs/heads/${branch}\n` : "";
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    };

    expect(pushTask(deps, taskId, fakeGit)).toMatchObject({ branch, commit: headCommit, observedAfterWriteFailure: true });
    expect(calls.filter((args) => args[0] === "push")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "ls-remote" && args.includes("--heads"))).toHaveLength(2);
  });

  it("observes the exact remote ref before a later retry when the first push and its confirmation both lost their response", () => {
    let remoteHead: string | null = null;
    let pushCalls = 0;
    let exactRefReads = 0;
    const fakeGit = (_cwd: string, args: string[]) => {
      if (args[0] === "remote") return githubUrl;
      if (args[0] === "ls-remote" && args.includes("--symref")) {
        return `ref: refs/heads/main HEAD\n${baseCommit}\tHEAD\n`;
      }
      if (args[0] === "ls-remote" && args.includes("--heads")) {
        exactRefReads += 1;
        if (exactRefReads === 2) throw new Error("simulated confirmation response loss");
        return remoteHead ? `${remoteHead}\trefs/heads/${branch}\n` : "";
      }
      if (args[0] === "push") {
        pushCalls += 1;
        remoteHead = headCommit;
        throw new Error("simulated push response loss");
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    };

    expect(() => pushTask(deps, taskId, fakeGit)).toThrow(/response loss|push/i);
    expect(pushCalls).toBe(1);
    const second = pushTask(deps, taskId, fakeGit);
    expect(second).toMatchObject({ branch, commit: headCommit, existingRemote: true });
    expect(pushCalls).toBe(1);
  });

  it("re-reads by head after PR create response loss and returns the observed PR without a duplicate create", async () => {
    let findCalls = 0;
    let createCalls = 0;
    let observed: { number: number; url: string } | null = null;
    const api: GithubApi = {
      async findPullRequest() { findCalls += 1; return observed; },
      async createPullRequest(_args: GithubPullRequestCreateArgs) {
        createCalls += 1;
        observed = { number: 77, url: "https://github.com/fake-owner/fake-repo/pull/77" };
        throw new Error("simulated PR response loss");
      },
    };
    const tool = createPrOpenTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      inspectRemoteState: () => ({ defaultBranch: "main", commit: headCommit }),
    });
    const envelope = (await tool.handler({ taskId, title: "D2", body: "observe" })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ number: 77, existing: true, observedAfterWriteFailure: true });
    expect(createCalls).toBe(1);
    expect(findCalls).toBe(2);
  });

  it("after a confirmed merge with no deploy spec, refreshes once then removes task worktree/branch and closes the task", async () => {
    attest(headCommit);
    const api = lifecycleApi({ canonicalMergeSha: "merge-sha" });
    let refreshCalls = 0;
    const tool = wrappedMergeTool(api, () => {
      refreshCalls += 1;
      return { action: "fast-forward", relation: "remote_ahead", branch: "main", before: baseCommit, after: "merge-sha", remoteHead: "merge-sha" };
    });
    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ merged: true, localState: "clean", cleanedUp: true });
    expect(refreshCalls).toBe(2);
    expect(existsSync(worktree)).toBe(false);
    expect(git(canonical, "branch", "--list", branch)).toBe("");
    expect(getTask(deps.db, taskId)?.state).toBe("CLOSED");
  });

  it("observes a lost merge response before any retry, then performs local reconciliation without a second merge call", async () => {
    attest(headCommit);
    const mergeSha = "observed-merge-sha";
    const api = lifecycleApi({
      afterMergeError: pr({ state: "closed", merged: true, mergeable: null }),
    });
    let refreshCalls = 0;
    const tool = wrappedMergeTool(api, () => {
      refreshCalls += 1;
      return { action: "fast-forward", relation: "remote_ahead", branch: "main", before: baseCommit, after: mergeSha, remoteHead: mergeSha };
    });
    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ merged: true, mergeSha, observedAfterWriteFailure: true, localState: "clean" });
    expect(api.mergeCalls).toBe(1);
    expect(api.getCalls).toBeGreaterThanOrEqual(2);
    expect(refreshCalls).toBe(2);
  });

  it("returns remote merged truth with merged-but-local-stale when post-merge canonical refresh fails", async () => {
    attest(headCommit);
    const api = lifecycleApi({ canonicalMergeSha: "merge-sha" });
    let refreshCalls = 0;
    const tool = wrappedMergeTool(api, () => {
      refreshCalls += 1;
      if (refreshCalls === 1) return { action: "none", relation: "equal", branch: "main", before: baseCommit, after: baseCommit, remoteHead: baseCommit };
      throw new Error("simulated canonical refresh failure");
    });
    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ merged: true, localState: "merged-but-local-stale", cleanedUp: false });
    expect(existsSync(worktree)).toBe(true);
    expect(getTask(deps.db, taskId)?.state).toBe("READY");
    const reconcileAudit = listAudit(deps.db, taskId).find(
      (row) => row.tool === "grande_pr_merge" && row.state === "FAILED" && /merged-but-local-stale/.test(row.reason ?? ""),
    );
    expect(reconcileAudit?.reason).toMatch(/merged-but-local-stale/);
  });
});
