import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask, getTask } from "../src/tasks.ts";
import { buildTools } from "../src/tools.ts";
import { openWorktree } from "../src/worktree.ts";
import { reconcileTaskLifecycleWithRepoWriteLocks } from "../src/taskLifecycleRecovery.ts";
import { openTaskWithCreating, prepareTaskCloseIntent } from "../src/taskLifecycleOps.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let ws: string;
let ctrl: string;
let layout: Layout;
let repo: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "task-crash-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "task-crash-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);

  repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.ts"), "v1\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  writeFileSync(
    layout.reposConfig,
    `repos:\n  - repoId: demo\n    path: ${repo}\n    registered: true\n`,
    "utf8",
  );
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

function branchExists(branch: string): boolean {
  try {
    git(repo, "show-ref", "--verify", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

describe("task create / close crash recovery", () => {
  it("persists a dedicated durable close intent table", async () => {
    const db = openDb(layout);
    await reconcileTaskLifecycleWithRepoWriteLocks(db, layout);
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_close_intent'",
    ).get() as { name: string } | undefined;
    expect(row?.name).toBe("task_close_intent");
    db.close();
  });

  it("writes CREATING before worktree materialization and leaves it durable on failure", () => {
    const db = openDb(layout);
    expect(() => openTaskWithCreating(
      { db, layout },
      { taskId: "task_create_window", repoId: "demo", slug: "create-window" },
      () => { throw new Error("simulated process failure during materialization"); },
    )).toThrow(/simulated process failure/);

    const task = getTask(db, "task_create_window");
    expect(task?.state).toBe("CREATING");
    expect(existsSync(task!.worktreePath)).toBe(false);
    db.close();
  });

  it("does not close an arbitrary READY ghost without durable close intent", async () => {
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_ready_ghost",
      repoId: "demo",
      branch: "grande/ready-ghost",
      baseCommit: git(repo, "rev-parse", "HEAD"),
      worktreePath: join(layout.worktreesRoot, "demo", "task_ready_ghost"),
      state: "READY",
    });

    const result = await reconcileTaskLifecycleWithRepoWriteLocks(db, layout);
    expect(result.closingClosed).toBe(0);
    expect(getTask(db, "task_ready_ghost")?.state).toBe("READY");
    db.close();
  });

  it("promotes an exact clean CREATING worktree to READY after restart reconciliation", async () => {
    const info = openWorktree(layout, "demo", "create-recover", "task_create_recover");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_create_recover",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "CREATING",
    });

    const result = await reconcileTaskLifecycleWithRepoWriteLocks(db, layout);
    expect(result.creatingReady).toBe(1);
    expect(getTask(db, "task_create_recover")?.state).toBe("READY");
    expect(existsSync(info.worktreePath)).toBe(true);
    db.close();
  });

  it("recovers remove-success / DB-before-CLOSED crash from durable close intent", async () => {
    const info = openWorktree(layout, "demo", "close-recover", "task_close_recover");
    const db = openDb(layout);
    const task = createTask(db, {
      taskId: "task_close_recover",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "READY",
    });
    const intent = prepareTaskCloseIntent(db, task);
    expect(intent.headSha).toBe(git(info.worktreePath, "rev-parse", "HEAD"));

    // Exact crash window: Git removal succeeded, process died before CLOSED.
    git(repo, "worktree", "remove", "--force", info.worktreePath);
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(branchExists(info.branch)).toBe(true);

    const result = await reconcileTaskLifecycleWithRepoWriteLocks(db, layout);
    expect(result.closingClosed).toBe(1);
    expect(getTask(db, task.taskId)?.state).toBe("CLOSED");
    expect(branchExists(info.branch)).toBe(false);
    db.close();
  });

  it("real task_close leaves durable intent when DB CLOSED write crashes after Git removal", async () => {
    const info = openWorktree(layout, "demo", "tool-close", "task_tool_close");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_tool_close",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "READY",
    });
    db.exec(`
      CREATE TRIGGER crash_task_close
      BEFORE UPDATE OF state ON task
      WHEN NEW.taskId = 'task_tool_close' AND NEW.state = 'CLOSED'
      BEGIN
        SELECT RAISE(ABORT, 'simulated close DB crash');
      END
    `);

    const close = buildTools({ db, layout, defaultRepoId: "demo" })
      .find((tool) => tool.name === "grande_task_close")!;
    const response = await close.handler({ taskId: "task_tool_close" });
    expect((response.structuredContent as { ok: boolean }).ok).toBe(false);
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(getTask(db, "task_tool_close")?.state).toBe("READY");
    const intent = db.prepare("SELECT headSha FROM task_close_intent WHERE taskId=?")
      .get("task_tool_close") as { headSha: string } | undefined;
    expect(intent?.headSha).toMatch(/^[0-9a-f]{40}$/);

    db.exec("DROP TRIGGER crash_task_close");
    const recovery = await reconcileTaskLifecycleWithRepoWriteLocks(db, layout);
    expect(recovery.closingClosed).toBe(1);
    expect(getTask(db, "task_tool_close")?.state).toBe("CLOSED");
    db.close();
  });

  it("fails closed when a CREATING worktree is dirty instead of promoting it", async () => {
    const info = openWorktree(layout, "demo", "dirty-create", "task_dirty_create");
    writeFileSync(join(info.worktreePath, "a.ts"), "dirty\n", "utf8");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_dirty_create",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "CREATING",
    });

    const result = await reconcileTaskLifecycleWithRepoWriteLocks(db, layout);
    expect(result.unresolved).toBe(1);
    expect(getTask(db, "task_dirty_create")?.state).toBe("CREATING");
    expect(existsSync(info.worktreePath)).toBe(true);
    db.close();
  });

  it("fails closed when close intent exists but the surviving worktree changed after intent", async () => {
    const info = openWorktree(layout, "demo", "dirty-close", "task_dirty_close");
    const db = openDb(layout);
    const task = createTask(db, {
      taskId: "task_dirty_close",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "READY",
    });
    prepareTaskCloseIntent(db, task);
    writeFileSync(join(info.worktreePath, "a.ts"), "changed after intent\n", "utf8");

    const result = await reconcileTaskLifecycleWithRepoWriteLocks(db, layout);
    expect(result.unresolved).toBe(1);
    expect(getTask(db, task.taskId)?.state).toBe("READY");
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(branchExists(info.branch)).toBe(true);
    db.close();
  });
});
