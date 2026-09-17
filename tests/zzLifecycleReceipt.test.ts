import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { resolveDeliveryTarget } from "../src/deliveryTarget.ts";
import type { GithubLifecycleApi, GithubPullRequestDetail } from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { reconcileMergedTaskFromRefresh } from "../src/mergeReconcile.ts";
import { createPrMergeTool } from "../src/prLifecycle.ts";
import { wrapPrMergeToolD2 } from "../src/prMergeD2.ts";
import { projectTaskProgress } from "../src/taskProgress.ts";
import { readTaskPrReceipt, recordTaskPrMerged, recordTaskPrOpened } from "../src/taskPrReceipt.ts";
import { createTask } from "../src/tasks.ts";
import type { ToolDeps } from "../src/toolsCore.ts";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

let root: string;
let layout: Layout;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lifecycle-receipt-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("durable PR lifecycle projection", () => {
  it("keeps PR/merged state after audit history churns past the old 500-row window", () => {
    const db = openDb(layout);
    const task = createTask(db, {
      taskId: "task_projection",
      repoId: "demo",
      branch: "grande/projection",
      baseCommit: "0".repeat(40),
      worktreePath: join(layout.worktreesRoot, "demo", "task_projection"),
      state: "READY",
    });
    recordTaskPrMerged(db, {
      taskId: task.taskId,
      prNumber: 12,
      prUrl: "https://github.com/example/demo/pull/12",
      headSha: "1".repeat(40),
      baseRef: "main",
      baseSha: "2".repeat(40),
      mergeSha: "3".repeat(40),
    });
    for (let i = 0; i < 520; i += 1) {
      const audit = beginAudit(db, { taskId: task.taskId, tool: `noise_${i}`, input: { i } });
      audit.allowed();
      audit.executing();
      audit.succeeded();
    }

    const progress = projectTaskProgress(db, task, {
      readHead: () => "1".repeat(40),
      filesChanged: () => 1,
      workingTreeDirty: () => false,
      worktreeExists: () => true,
      deployConfigured: () => false,
    });
    expect(progress.stages.pr.state).toBe("done");
    expect(progress.stages.merged.state).toBe("done");
    expect(progress.completed).toBe(true);
    expect(progress.cleanupRequired).toBe(true);
    expect(resolveDeliveryTarget(db, task, { readOrigin: () => null })).toBe("pr");
    db.close();
  });

  it("automatic cleanup refuses confirmed-merged state without an exact merge SHA", () => {
    const db = openDb(layout);
    const task = createTask(db, {
      taskId: "task_no_merge_sha",
      repoId: "demo",
      branch: "grande/no-merge-sha",
      baseCommit: "0".repeat(40),
      worktreePath: join(layout.worktreesRoot, "demo", "task_no_merge_sha"),
      state: "READY",
    });
    const result = reconcileMergedTaskFromRefresh(
      { db, layout, defaultRepoId: "demo" },
      task,
      {
        action: "none",
        relation: "equal",
        branch: "main",
        before: "2".repeat(40),
        after: "2".repeat(40),
        remoteHead: "2".repeat(40),
      },
      null,
      "1".repeat(40),
    );
    expect(result.localState).toBe("merged-but-local-stale");
    expect(result.error).toMatch(/exact|merge SHA/i);
    db.close();
  });
});

describe("external merge reconciliation", () => {
  it("persists exact external merge evidence before returning merged", async () => {
    const db = openDb(layout);
    const taskId = "task_external_merge";
    const branch = "grande/external-merge";
    const worktree = join(layout.worktreesRoot, "demo", taskId);
    mkdirSync(worktree, { recursive: true });
    git(worktree, "init", "-q", "-b", branch);
    git(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "--allow-empty", "-q", "-m", "head");
    const headSha = git(worktree, "rev-parse", "HEAD").trim();
    const mergeSha = "3".repeat(40);
    const baseSha = "2".repeat(40);
    const token = "github_pat_lifecycle_receipt_abcdefghijklmnopqrstuvwxyz";
    mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
    writeFileSync(join(layout.controlRoot, "secrets", "github-token"), `${token}\n`, { mode: 0o600 });
    createTask(db, {
      taskId,
      repoId: "demo",
      branch,
      baseCommit: baseSha,
      worktreePath: worktree,
      state: "READY",
    });
    recordTaskPrOpened(db, {
      taskId,
      prNumber: 77,
      prUrl: "https://github.com/example/demo/pull/77",
      headSha,
      baseRef: "main",
      baseSha,
    });

    const pr: GithubPullRequestDetail = {
      number: 77,
      url: "https://github.com/example/demo/pull/77",
      state: "closed",
      draft: false,
      merged: true,
      mergeable: null,
      headSha,
      headRef: branch,
      baseRef: "main",
      baseSha,
      mergeCommitSha: mergeSha,
    };
    const api: GithubLifecycleApi = {
      async findPullRequest() { return { number: 77, url: pr.url }; },
      async createPullRequest() { throw new Error("not used"); },
      async getPullRequest() { return pr; },
      async listCheckRuns() { return []; },
      async listCommitStatuses() { return []; },
      async mergePullRequest() { throw new Error("external merge path must not call merge"); },
    };
    const deps: ToolDeps = { db, layout, defaultRepoId: "demo" };
    const options = {
      apiFactory: () => api,
      readRemoteUrl: () => "https://github.com/example/demo.git",
      canonicalRefresher: () => ({
        action: "fast-forward" as const,
        relation: "remote_ahead" as const,
        branch: "main",
        before: baseSha,
        after: mergeSha,
        remoteHead: mergeSha,
      }),
    };
    const base = createPrMergeTool(deps, {
      ...options,
      readLocalHead: () => headSha,
    });
    const tool = wrapPrMergeToolD2(deps, base, options);

    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.mergeSha).toBe(mergeSha);
    expect(readTaskPrReceipt(db, taskId)).toMatchObject({
      prNumber: 77,
      headSha,
      baseRef: "main",
      baseSha,
      mergeSha,
    });
    db.close();
  });
});
