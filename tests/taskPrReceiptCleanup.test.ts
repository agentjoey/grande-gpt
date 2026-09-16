import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRefreshResult } from "../src/canonicalRefresh.ts";
import { openDb } from "../src/db.ts";
import { safeGit } from "../src/gitExec.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { reconcileMergedTaskFromRefresh } from "../src/mergeReconcile.ts";
import { saveRegistry } from "../src/registry.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { recordTaskPrMerged } from "../src/taskPrReceipt.ts";
import { createTask, getTask, type TaskRow } from "../src/tasks.ts";

const TASK = "task_receipt_cleanup";
const BRANCH = "grande/receipt-cleanup";
const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null", "-c", "user.name=GrandeGPT Test", "-c", "user.email=grande-test@example.com", ...args,
], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
let canonical: string;
let worktree: string;
let task: TaskRow;
let baseSha: string;
let headSha: string;

function commit(cwd: string, name: string): string {
  writeFileSync(join(cwd, name), name + "\n");
  git(cwd, "add", name);
  git(cwd, "commit", "-q", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "receipt-cleanup-"));
  mkdirSync(join(root, "workspace"));
  mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout();
  ensureLayout(layout);
  canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical);
  git(canonical, "init", "-q", "-b", "main");
  baseSha = commit(canonical, "base.txt");
  saveRegistry(layout, [{ repoId: "demo", path: canonical, registered: true }]);
  worktree = join(layout.worktreesRoot, "demo", TASK);
  git(canonical, "worktree", "add", "-q", "-b", BRANCH, worktree, baseSha);
  headSha = commit(worktree, "feature.txt");
  db = openDb(layout);
  task = createTask(db, { taskId: TASK, repoId: "demo", branch: BRANCH, baseCommit: baseSha, worktreePath: worktree, state: "READY" });
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function record(mergeSha: string): void {
  recordTaskPrMerged(db, { taskId: TASK, prNumber: 17, prUrl: "https://github.com/example/demo/pull/17", headSha, baseRef: "main", baseSha, mergeSha });
}

function merge(): string {
  git(canonical, "merge", "--no-ff", "-q", "-m", "merge feature", headSha);
  const mergeSha = git(canonical, "rev-parse", "HEAD");
  record(mergeSha);
  return mergeSha;
}

function refresh(): CanonicalRefreshResult {
  const after = git(canonical, "rev-parse", "HEAD");
  return { action: "none", relation: "equal", branch: "main", before: after, after, remoteHead: after };
}

function reconcile(mergeSha: string, snapshot = refresh()) {
  return reconcileMergedTaskFromRefresh({ db, layout, defaultRepoId: "demo" }, task, snapshot, mergeSha, headSha);
}

function expectRetained(): void {
  expect(existsSync(worktree)).toBe(true);
  expect(git(canonical, "rev-parse", BRANCH)).toBe(headSha);
  expect(getTask(db, TASK)?.state).toBe("READY");
}

describe("exact merge evidence before automatic cleanup", () => {
  it("closes a clean task whose exact head is included in the published merge", () => {
    const result = reconcile(merge());
    expect(result).toMatchObject({ localState: "clean", cleanedUp: true });
    expect(existsSync(worktree)).toBe(false);
    expect(getTask(db, TASK)?.state).toBe("CLOSED");
    expect(git(canonical, "branch", "--list", BRANCH)).toBe("");
  });

  it("allows canonical to advance beyond the exact merge without losing its identity", () => {
    const mergeSha = merge();
    commit(canonical, "later.txt");
    const result = reconcile(mergeSha);
    expect(result).toMatchObject({ localState: "clean", cleanedUp: true });
    expect(git(canonical, "rev-parse", "HEAD")).not.toBe(mergeSha);
    expect(getTask(db, TASK)?.state).toBe("CLOSED");
  });

  it("does not delete an unmerged task even if a supplied merge SHA equals canonical HEAD", () => {
    const unrelated = commit(canonical, "unrelated.txt");
    record(unrelated);
    const result = reconcile(unrelated);
    expect(result.cleanedUp).toBe(false);
    expectRetained();
  });

  it("requires published remote evidence even when local canonical contains the merge", () => {
    const mergeSha = merge();
    const result = reconcile(mergeSha, { ...refresh(), relation: "no_remote", remoteHead: null });
    expect(result.cleanedUp).toBe(false);
    expectRetained();
  });

  it("retains a worktree switched to a different branch at the same HEAD", () => {
    const mergeSha = merge();
    git(worktree, "switch", "-q", "-c", "human/other-work");
    const result = reconcile(mergeSha);
    expect(result.cleanedUp).toBe(false);
    expectRetained();
    expect(git(worktree, "symbolic-ref", "--short", "HEAD")).toBe("human/other-work");
  });

  it("retains uncommitted content after merge", () => {
    const mergeSha = merge();
    writeFileSync(join(worktree, "human-notes.txt"), "keep this\n");
    expect(reconcile(mergeSha).cleanedUp).toBe(false);
    expectRetained();
  });

  it("does not force-delete content created between the clean check and Git removal", () => {
    const mergeSha = merge();
    const local = safeGit.local;
    vi.spyOn(safeGit, "local").mockImplementation((cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        writeFileSync(join(worktree, "human-race.txt"), "preserve concurrent work\n");
      }
      return local(cwd, args, options);
    });
    expect(reconcile(mergeSha).cleanedUp).toBe(false);
    expectRetained();
    expect(existsSync(join(worktree, "human-race.txt"))).toBe(true);
  });

  it("retains an unresolved explicit deployment", () => {
    const mergeSha = merge();
    saveExplicitDeliveryTarget(db, TASK, "deploy");
    expect(reconcile(mergeSha)).toMatchObject({ localState: "deploy-pending", cleanedUp: false });
    expectRetained();
  });

  it("rejects a stale canonical refresh snapshot before cleanup", () => {
    const mergeSha = merge();
    const snapshot = refresh();
    commit(canonical, "changed-after-refresh.txt");
    expect(reconcile(mergeSha, snapshot).cleanedUp).toBe(false);
    expectRetained();
  });
});
