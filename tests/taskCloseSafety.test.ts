import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask, getTask } from "../src/tasks.ts";
import { buildTools } from "../src/tools.ts";
import { openWorktree } from "../src/worktree.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let ws: string;
let ctrl: string;
let layout: Layout;
let repo: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "task-close-safety-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "task-close-safety-ctl-"));
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
  writeFileSync(layout.reposConfig, `repos:\n  - repoId: demo\n    path: ${repo}\n    registered: true\n`, "utf8");
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

function makeReadyTask(db: ReturnType<typeof openDb>, taskId: string, slug: string) {
  const info = openWorktree(layout, "demo", slug, taskId);
  const task = createTask(db, {
    taskId,
    repoId: "demo",
    branch: info.branch,
    baseCommit: info.baseCommit,
    worktreePath: info.worktreePath,
    state: "READY",
  });
  return { info, task };
}

describe("task_close fail-closed safety", () => {
  it("rejects a durable running job without touching worktree or task state", async () => {
    const db = openDb(layout);
    const { info, task } = makeReadyTask(db, "task_running_close", "running-close");
    createJob(db, {
      jobId: "job_running_close",
      taskId: task.taskId,
      profile: "unit",
      argv: ["sleep", "60"],
      pgid: 12345,
    });

    const close = buildTools({ db, layout, defaultRepoId: "demo" })
      .find((tool) => tool.name === "grande_task_close")!;
    const response = await close.handler({ taskId: task.taskId });
    const body = response.structuredContent as { ok: boolean; error?: { code?: string } };

    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("INVALID_INPUT");
    expect(getTask(db, task.taskId)?.state).toBe("READY");
    expect(existsSync(info.worktreePath)).toBe(true);
    db.close();
  });

  it("rejects dirty/uncommitted worktree and preserves its data", async () => {
    const db = openDb(layout);
    const { info, task } = makeReadyTask(db, "task_dirty_tool_close", "dirty-tool-close");
    writeFileSync(join(info.worktreePath, "a.ts"), "unsaved work\n", "utf8");

    const close = buildTools({ db, layout, defaultRepoId: "demo" })
      .find((tool) => tool.name === "grande_task_close")!;
    const response = await close.handler({ taskId: task.taskId });
    const body = response.structuredContent as { ok: boolean };

    expect(body.ok).toBe(false);
    expect(getTask(db, task.taskId)?.state).toBe("READY");
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(writeFileSync).toBeDefined();
    expect(git(info.worktreePath, "status", "--porcelain")).not.toBe("");
    db.close();
  });
});
