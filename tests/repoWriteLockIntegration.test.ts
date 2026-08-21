import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockProbe = vi.hoisted(() => ({
  entered: [] as string[],
  waiters: [] as Array<{ repoId: string; resolve: () => void }>,
}));

vi.mock("../src/repoWriteLock.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repoWriteLock.ts")>();
  return {
    ...actual,
    withRepoWriteLock: <T>(repoId: string, operation: () => Promise<T> | T): Promise<T> =>
      actual.withRepoWriteLock(repoId, async () => {
        lockProbe.entered.push(repoId);
        await new Promise<void>((resolve) => lockProbe.waiters.push({ repoId, resolve }));
        return operation();
      }),
  };
});

import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let ws: string;
let ctrl: string;
let layout: Layout;
let deps: ToolDeps;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

function addRepo(repoId: string): string {
  const canonical = join(layout.workspaceRoot, repoId);
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-q", "-m", "init");
  return canonical;
}

function addTask(repoId: string, canonical: string, taskId: string, branch: string): void {
  const worktree = join(layout.worktreesRoot, repoId, taskId);
  mkdirSync(join(layout.worktreesRoot, repoId), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");
  writeFileSync(join(worktree, `${taskId}.txt`), "change\n", "utf8");
  createTask(deps.db, {
    taskId,
    repoId,
    branch,
    baseCommit: git(canonical, "rev-parse", "HEAD").trim(),
    worktreePath: worktree,
    state: "READY",
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true");
}

function release(repoId: string): void {
  const index = lockProbe.waiters.findIndex((waiter) => waiter.repoId === repoId);
  if (index < 0) throw new Error(`no waiter for ${repoId}`);
  const [waiter] = lockProbe.waiters.splice(index, 1);
  waiter!.resolve();
}

function commitTool() {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_commit");
  if (!tool) throw new Error("grande_commit missing");
  return tool;
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "repo-lock-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "repo-lock-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  writeFileSync(join(layout.configDir, "identity.yaml"), "commit:\n  name: GrandeGPT\n  email: grande@example.com\n", "utf8");
  deps = { db: openDb(layout), layout };
  lockProbe.entered.length = 0;
  lockProbe.waiters.length = 0;
});

afterEach(() => {
  for (const waiter of lockProbe.waiters.splice(0)) waiter.resolve();
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

describe("repo write lock tool integration", () => {
  it("two same-repo grande_commit calls cannot enter the write critical section together", async () => {
    const canonical = addRepo("demo");
    writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
    addTask("demo", canonical, "task_lock_a", "grande/lock-a");
    addTask("demo", canonical, "task_lock_b", "grande/lock-b");
    const tool = commitTool();

    const first = tool.handler({ taskId: "task_lock_a", message: "first" });
    const second = tool.handler({ taskId: "task_lock_b", message: "second" });

    await waitFor(() => lockProbe.entered.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lockProbe.entered).toEqual(["demo"]);

    release("demo");
    await waitFor(() => lockProbe.entered.length === 2);
    release("demo");
    const results = await Promise.all([first, second]);
    expect(results.every((result) => (result.structuredContent as { ok?: unknown }).ok === true)).toBe(true);
  });

  it("grande_commit calls for different repos can enter concurrently", async () => {
    const a = addRepo("repo-a");
    const b = addRepo("repo-b");
    writeFileSync(layout.reposConfig, "repos:\n  - repoId: repo-a\n    registered: true\n  - repoId: repo-b\n    registered: true\n", "utf8");
    addTask("repo-a", a, "task_lock_a", "grande/lock-a");
    addTask("repo-b", b, "task_lock_b", "grande/lock-b");
    const tool = commitTool();

    const first = tool.handler({ taskId: "task_lock_a", message: "first" });
    const second = tool.handler({ taskId: "task_lock_b", message: "second" });

    await waitFor(() => lockProbe.entered.length === 2);
    expect([...lockProbe.entered].sort()).toEqual(["repo-a", "repo-b"]);
    release("repo-a");
    release("repo-b");
    const results = await Promise.all([first, second]);
    expect(results.every((result) => (result.structuredContent as { ok?: unknown }).ok === true)).toBe(true);
  });
});
