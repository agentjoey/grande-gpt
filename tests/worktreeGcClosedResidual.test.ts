import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask, getTask, updateTaskState } from "../src/tasks.ts";
import { applyGc, planGc } from "../src/worktreeGc.ts";
import { openWorktree } from "../src/worktree.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
let repo: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

function gitWorktreePaths(repoRoot: string): Set<string> {
  const out = git(repoRoot, "worktree", "list", "--porcelain");
  return new Set(
    out.split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length)),
  );
}

function syncCli(argv: string[]): { code: number; text: string } {
  const lines: string[] = [];
  const result = runCli(argv, (line) => lines.push(line));
  if (typeof result !== "number") throw new Error(`grande ${argv[0]} unexpectedly returned Promise`);
  return { code: result, text: lines.join("\n") };
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "gc-closed-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "gc-closed-ctrl-"));
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
  saveRegistry(layout, [{ repoId: "demo", path: repo, registered: true }]);
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("GG-BL-005 CLOSED residual reconciliation", () => {
  it("CLOSED + residual managed worktree 会作为第三类 GC 项被发现，而不是 orphan/ghost", () => {
    const info = openWorktree(layout, "demo", "closed", "task_closed_residual");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_closed_residual",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "CLOSED",
    });

    const plan = planGc(db, layout);
    expect(plan.orphanWorktrees).toEqual([]);
    expect(plan.ghostTasks).toEqual([]);
    expect(plan.closedResidualWorktrees).toEqual([
      {
        taskId: "task_closed_residual",
        repoId: "demo",
        worktreePath: info.worktreePath,
        branch: info.branch,
      },
    ]);
    db.close();
  });

  it("apply 后目录与 git worktree 注册都消失，task 保持 CLOSED，二次对账幂等", () => {
    const info = openWorktree(layout, "demo", "closed", "task_closed_apply");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_closed_apply",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "CLOSED",
    });

    const firstPlan = planGc(db, layout);
    const result = applyGc(db, layout, firstPlan);
    expect(result.reconciledClosedResiduals).toBe(1);
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(gitWorktreePaths(repo).has(info.worktreePath)).toBe(false);
    expect(getTask(db, "task_closed_apply")?.state).toBe("CLOSED");

    const secondPlan = planGc(db, layout);
    expect(secondPlan.closedResidualWorktrees).toEqual([]);
    const second = applyGc(db, layout, secondPlan);
    expect(second.reconciledClosedResiduals).toBe(0);
    db.close();
  });

  it("READY 活跃 task 即使 worktree 存在也绝不进入 CLOSED residual 清理路径", () => {
    const info = openWorktree(layout, "demo", "active", "task_active_safe");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_active_safe",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "READY",
    });

    const plan = planGc(db, layout);
    expect(plan.closedResidualWorktrees).toEqual([]);
    applyGc(db, layout, plan);
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(gitWorktreePaths(repo).has(info.worktreePath)).toBe(true);
    expect(getTask(db, "task_active_safe")?.state).toBe("READY");
    db.close();
  });

  it("dry-run 后 CLOSED task 若变回 active，apply-time recheck 会拒绝 stale plan", () => {
    const info = openWorktree(layout, "demo", "stale", "task_closed_stale");
    const db = openDb(layout);
    const closed = createTask(db, {
      taskId: "task_closed_stale",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "CLOSED",
    });
    const stalePlan = planGc(db, layout);
    expect(stalePlan.closedResidualWorktrees).toHaveLength(1);

    updateTaskState(db, closed.taskId, "READY", closed.stateVersion);
    const result = applyGc(db, layout, stalePlan);
    expect(result.reconciledClosedResiduals).toBe(0);
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(gitWorktreePaths(repo).has(info.worktreePath)).toBe(true);
    expect(getTask(db, closed.taskId)?.state).toBe("READY");
    db.close();
  });

  it("CLOSED 行的 stored path 不等于受管 expected path 时 fail-closed，不进入删除计划", () => {
    const outside = join(ws, "outside-do-not-delete");
    mkdirSync(outside, { recursive: true });
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_closed_badpath",
      repoId: "demo",
      branch: "grande/closed-badpath",
      baseCommit: "deadbeef",
      worktreePath: outside,
      state: "CLOSED",
    });

    const plan = planGc(db, layout);
    expect(plan.closedResidualWorktrees).toEqual([]);
    applyGc(db, layout, plan);
    expect(existsSync(outside)).toBe(true);
    db.close();
  });

  it("CLI dry-run 单独发现 CLOSED residual，不再误报一切干净", () => {
    const info = openWorktree(layout, "demo", "cli", "task_closed_cli_dry");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_closed_cli_dry",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "CLOSED",
    });
    db.close();

    const result = syncCli(["gc"]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("CLOSED task 残留 worktree");
    expect(result.text).toContain("task_closed_cli_dry");
    expect(result.text).toContain("dry-run");
    expect(result.text).not.toContain("一切干净");
    expect(existsSync(info.worktreePath)).toBe(true);
  });

  it("CLI --apply 在只有 CLOSED residual 时也会执行清理并报告数量", () => {
    const info = openWorktree(layout, "demo", "cli", "task_closed_cli_apply");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_closed_cli_apply",
      repoId: "demo",
      branch: info.branch,
      baseCommit: info.baseCommit,
      worktreePath: info.worktreePath,
      state: "CLOSED",
    });
    db.close();

    const result = syncCli(["gc", "--apply"]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("CLOSED task 残留 worktree");
    expect(result.text).toContain("清理 CLOSED residual worktree：1 条");
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(gitWorktreePaths(repo).has(info.worktreePath)).toBe(false);
  });
});
