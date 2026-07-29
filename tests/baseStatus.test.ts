import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let ws: string;
let ctrl: string;
let layout: Layout;
let canonical: string;
let worktree: string;
let deps: ToolDeps;
let baseCommit: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content, "utf8");
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "base-status-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "base-status-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);

  canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  commit(canonical, "base.txt", "base\n", "base");
  baseCommit = git(canonical, "rev-parse", "HEAD").trim();
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  worktree = join(layout.worktreesRoot, "demo", "task_status");
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/status-test", worktree, baseCommit);
  const db = openDb(layout);
  createTask(db, {
    taskId: "task_status",
    repoId: "demo",
    branch: "grande/status-test",
    baseCommit,
    worktreePath: worktree,
    state: "READY",
  });
  deps = { db, layout, defaultRepoId: "demo" };
});

afterEach(() => {
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

async function status(): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_task_status");
  if (!tool) throw new Error("grande_task_status 未注册");
  const result = await tool.handler({ taskId: "task_status" });
  return result.structuredContent as Record<string, any>;
}

describe("grande_task_status base 分歧", () => {
  it("AC-S2-9：canonical 线性前进 3 个 commit，behind 精确等于 3", async () => {
    commit(canonical, "one.txt", "1\n", "one");
    commit(canonical, "two.txt", "2\n", "two");
    commit(canonical, "three.txt", "3\n", "three");

    const result = await status();

    expect(result.ok).toBe(true);
    expect(result.data.base).toEqual({ baseCommit, behind: 3, diverged: false });
  });

  it("merge 历史按 baseCommit..canonical HEAD 的真实可达提交数计数，不用 HEAD~N 猜", async () => {
    git(canonical, "checkout", "-q", "-b", "side", baseCommit);
    commit(canonical, "side-a.txt", "a\n", "side a");
    commit(canonical, "side-b.txt", "b\n", "side b");
    git(canonical, "checkout", "-q", "main");
    commit(canonical, "main-a.txt", "m\n", "main a");
    git(canonical, "-c", "user.name=T", "-c", "user.email=t@example.com", "merge", "--no-ff", "-q", "-m", "merge side", "side");

    const result = await status();

    // base..HEAD 可达：side 两个 + main 一个 + merge 一个 = 4。
    expect(result.data.base.behind).toBe(4);
  });

  it("canonical 与任务分支都产生新提交时 diverged=true", async () => {
    commit(canonical, "canonical.txt", "c\n", "canonical");
    commit(worktree, "task.txt", "t\n", "task");

    const result = await status();

    expect(result.data.base.behind).toBe(1);
    expect(result.data.base.diverged).toBe(true);
  });

  it("没有分歧时 behind=0 且 diverged=false", async () => {
    const result = await status();
    expect(result.data.base).toEqual({ baseCommit, behind: 0, diverged: false });
  });

  it("canonical detached HEAD 时不崩，诚实返回 unknown", async () => {
    git(canonical, "checkout", "--detach", "-q", "HEAD");
    const result = await status();
    expect(result.ok).toBe(true);
    expect(result.data.base).toEqual({ baseCommit, behind: null, diverged: null });
  });
});
