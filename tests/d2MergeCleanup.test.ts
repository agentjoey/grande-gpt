import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { reconcileMergedTaskFromRefresh } from "../src/mergeReconcile.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask, getTask } from "../src/tasks.ts";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("D2 post-merge cleanup safety", () => {
  it("preserves the task worktree and reports merged-but-local-stale if uncommitted content appears before cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "d2-cleanup-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const control = join(root, "control");
    const canonical = join(workspace, "demo");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(control, { recursive: true });
    process.env.GRANDE_WORKSPACE = workspace;
    process.env.GRANDE_CONTROL = control;
    git(canonical, "init", "-q", "-b", "main");
    git(canonical, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "base");
    const base = git(canonical, "rev-parse", "HEAD");

    const layout = loadLayout();
    ensureLayout(layout);
    saveRegistry(layout, [{ repoId: "demo", path: canonical, registered: true }]);
    const taskId = "task_d2_cleanup";
    const branch = "grande/d2-cleanup";
    const worktree = join(layout.worktreesRoot, "demo", taskId);
    mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
    git(canonical, "worktree", "add", "-q", "-b", branch, worktree, base);
    writeFileSync(join(worktree, "tracked.txt"), "merged\n", "utf8");
    git(worktree, "add", "tracked.txt");
    git(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "task");
    const head = git(worktree, "rev-parse", "HEAD");

    const db = openDb(layout);
    try {
      createTask(db, { taskId, repoId: "demo", branch, baseCommit: base, worktreePath: worktree, state: "READY" });
      writeFileSync(join(worktree, "human-uncommitted.txt"), "do not delete\n", "utf8");
      const result = reconcileMergedTaskFromRefresh(
        { db, layout, defaultRepoId: "demo" },
        getTask(db, taskId)!,
        { action: "fast-forward", relation: "remote_ahead", branch: "main", before: base, after: head, remoteHead: head },
        head,
        head,
      );

      expect(result).toMatchObject({ localState: "merged-but-local-stale", cleanedUp: false });
      expect(result.error).toMatch(/dirty|uncommitted|未提交/i);
      expect(existsSync(worktree)).toBe(true);
      expect(existsSync(join(worktree, "human-uncommitted.txt"))).toBe(true);
      expect(getTask(db, taskId)?.state).toBe("READY");
    } finally {
      db.close();
    }
  });
});
