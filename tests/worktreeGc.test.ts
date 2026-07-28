import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { openWorktree, removeWorktree } from "../src/worktree.ts";
import { createTask, getTask, listActiveTasks, type TaskRow } from "../src/tasks.ts";
import { saveRegistry } from "../src/registry.ts";
import { runCli } from "../src/cli.ts";
import { planGc, applyGc, type GcPlan } from "../src/worktreeGc.ts";

let ws: string, ctrl: string, layout: Layout, repo: string;
let savedWs: string | undefined, savedCtrl: string | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "gcgc-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "gcgc-ctl-"));
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

  writeFileSync(join(layout.reposConfig), `repos:\n  - repoId: demo\n    path: ${repo}\n    registered: true\n`, "utf8");
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

/** 列出某个 repo 在 git worktree list --porcelain 中的 worktree 路径集合 */
function gitWorktreePaths(repoRoot: string): Set<string> {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  const paths = new Set<string>();
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.add(line.slice("worktree ".length));
  }
  return paths;
}

describe("planGc()", () => {
  it("孤儿 worktree 被识别：建 worktree → 删 task 行 → planGc 报出它", () => {
    const info = openWorktree(layout, "demo", "fix", "task_orphan");
    expect(existsSync(info.worktreePath)).toBe(true);

    const db = openDb(layout);
    // 删掉 task 行，模拟 schema 迁移清掉 task 表的情况
    db.prepare("DELETE FROM task WHERE taskId = ?").run("task_orphan");
    db.close();

    const db2 = openDb(layout);
    const plan = planGc(db2, layout);
    expect(plan.orphanWorktrees).toHaveLength(1);
    expect(plan.orphanWorktrees[0]!.taskId).toBe("task_orphan");
    expect(plan.orphanWorktrees[0]!.repoId).toBe("demo");
    expect(plan.orphanWorktrees[0]!.path).toBe(info.worktreePath);
    expect(plan.orphanWorktrees[0]!.branch).toBe(info.branch);
    expect(plan.ghostTasks).toEqual([]);
    db2.close();
  });

  it("幽灵 task 被识别：task 行存在但 worktree 目录不在磁盘上", () => {
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_ghost",
      repoId: "demo",
      branch: "grande/fix-ghost",
      baseCommit: "c0ffee",
      worktreePath: join(layout.worktreesRoot, "demo", "task_ghost"),
      state: "READY",
    });
    db.close();

    const db2 = openDb(layout);
    const plan = planGc(db2, layout);
    expect(plan.ghostTasks).toHaveLength(1);
    expect(plan.ghostTasks[0]!.taskId).toBe("task_ghost");
    expect(plan.ghostTasks[0]!.repoId).toBe("demo");
    expect(plan.orphanWorktrees).toEqual([]);
    db2.close();
  });

  it("健康的 task（库与磁盘都在）两个数组都不含它", () => {
    const info = openWorktree(layout, "demo", "fix", "task_healthy");
    expect(existsSync(info.worktreePath)).toBe(true);

    const db = openDb(layout);
    createTask(db, {
      taskId: "task_healthy", repoId: "demo", branch: info.branch,
      baseCommit: info.baseCommit, worktreePath: info.worktreePath,
      state: "READY",
    });
    db.close();

    const db2 = openDb(layout);
    const plan = planGc(db2, layout);
    expect(plan.orphanWorktrees).toEqual([]);
    expect(plan.ghostTasks).toEqual([]);
    db2.close();
  });

  it("planGc 是只读的：调用前后 worktree 目录与 task 行逐一比对无变化", () => {
    const info = openWorktree(layout, "demo", "fix", "task_readonly");

    const db = openDb(layout);
    createTask(db, {
      taskId: "task_readonly", repoId: "demo", branch: info.branch,
      baseCommit: info.baseCommit, worktreePath: info.worktreePath,
      state: "READY",
    });

    const beforeTasks = listActiveTasks(db);
    const beforeTaskMap = new Map(beforeTasks.map((t) => [t.taskId, { ...t }]));

    // 还在跑着的 task 的 worktree 目录内容快照
    const beforeDirContents = existsSync(info.worktreePath)
      ? readdirSync(info.worktreePath)
      : null;

    const plan = planGc(db, layout);

    // 计划里应该不含健康 task
    expect(plan.orphanWorktrees).toEqual([]);
    expect(plan.ghostTasks).toEqual([]);

    // 调用后 task 行无变化
    const afterTasks = listActiveTasks(db);
    expect(afterTasks).toHaveLength(beforeTasks.length);
    for (const at of afterTasks) {
      const bt = beforeTaskMap.get(at.taskId);
      expect(bt).toBeDefined();
      expect(at.state).toBe(bt!.state);
      expect(at.worktreePath).toBe(bt!.worktreePath);
      expect(at.updatedAt).toBe(bt!.updatedAt);
    }

    // 调用后 worktree 目录还在
    expect(existsSync(info.worktreePath)).toBe(true);
    if (beforeDirContents) {
      expect(readdirSync(info.worktreePath).sort()).toEqual(beforeDirContents.sort());
    }
    db.close();
  });

  it("CLOSED 的 task 不被当成幽灵反复处理（幂等）", () => {
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_closed",
      repoId: "demo",
      branch: "grande/fix-cc",
      baseCommit: "c0ffee",
      worktreePath: join(layout.worktreesRoot, "demo", "task_closed"),
      state: "CLOSED",
    });
    db.close();

    const db2 = openDb(layout);
    const plan = planGc(db2, layout);
    expect(plan.ghostTasks).toEqual([]);
    db2.close();
  });
});

describe("applyGc()", () => {
  it("applyGc 之后 worktree 目录消失，且 git worktree list 里也没了", () => {
    const info = openWorktree(layout, "demo", "fix", "task_applydel");

    const db = openDb(layout);
    db.prepare("DELETE FROM task WHERE taskId = ?").run("task_applydel");
    db.close();

    const db2 = openDb(layout);
    const plan = planGc(db2, layout);
    expect(plan.orphanWorktrees).toHaveLength(1);
    expect(plan.orphanWorktrees[0]!.branch).toBe(info.branch);

    const result = applyGc(db2, layout, plan);
    expect(result.removed).toBe(1);
    expect(result.closed).toBe(0);
    db2.close();

    // 目录消失
    expect(existsSync(info.worktreePath)).toBe(false);

    // git worktree list 里也没了这个 worktree
    const paths = gitWorktreePaths(repo);
    expect(paths.has(info.worktreePath)).toBe(false);
  });

  it("幽灵 task 被置 CLOSED，且没有任何文件系统写操作", () => {
    const ghostPath = join(layout.worktreesRoot, "demo", "task_ghostclose");
    const db = openDb(layout);
    createTask(db, {
      taskId: "task_ghostclose",
      repoId: "demo",
      branch: "grande/fix-ghc",
      baseCommit: "c0ffee",
      worktreePath: ghostPath,
      state: "READY",
    });
    db.close();

    const db2 = openDb(layout);
    const plan = planGc(db2, layout);
    expect(plan.ghostTasks).toHaveLength(1);

    // 确保 worktree 目录确实不存在
    expect(existsSync(ghostPath)).toBe(false);

    // 记录 apply 前的磁盘状态 —— worktreesRoot 下 demo 子目录的内容
    const demoDir = join(layout.worktreesRoot, "demo");
    const beforeFiles = existsSync(demoDir)
      ? (readdirSync(demoDir, { recursive: true }) as string[])
      : [];

    const result = applyGc(db2, layout, plan);
    expect(result.closed).toBe(1);

    // 验证 task 已 CLOSED
    const t = getTask(db2, "task_ghostclose");
    expect(t).toBeDefined();
    expect(t!.state).toBe("CLOSED");

    // 没有任何文件系统写操作 —— demo 目录内容不变
    const afterFiles = existsSync(demoDir)
      ? (readdirSync(demoDir, { recursive: true }) as string[])
      : [];
    expect(afterFiles.sort()).toEqual(beforeFiles.sort());
    db2.close();
  });

  it("没有 branch 信息的孤儿 worktree，applyGc 时跳过", () => {
    // 建一个 orphan worktree，但刻意不提供分支信息
    const info = openWorktree(layout, "demo", "fix", "task_nobranch");

    const db = openDb(layout);
    db.prepare("DELETE FROM task WHERE taskId = ?").run("task_nobranch");
    db.close();

    const db2 = openDb(layout);
    let plan = planGc(db2, layout);
    expect(plan.orphanWorktrees).toHaveLength(1);
    // 篡改 plan 中的 branch 为 null
    plan = { ...plan, orphanWorktrees: plan.orphanWorktrees.map((o) => ({ ...o, branch: null })) };

    const result = applyGc(db2, layout, plan);
    // branch 为 null 时跳过 removeWorktree，但仍计入 removed
    expect(result.removed).toBe(1);
    db2.close();
  });
});

describe("CLI: grande gc", () => {
  let cliLines: string[];
  const cliOut = (l: string): void => void cliLines.push(l);
  const cliText = (): string => cliLines.join("\n");

  beforeEach(() => {
    cliLines = [];
  });

  it("grande gc 默认 dry-run 不删任何东西", () => {
    const info = openWorktree(layout, "demo", "fix", "task_dryrun");
    const db = openDb(layout);
    db.prepare("DELETE FROM task WHERE taskId = ?").run("task_dryrun");
    db.close();

    // 记录当前文件系统状态
    const beforeExists = existsSync(info.worktreePath);
    expect(beforeExists).toBe(true);

    const oldBranch = info.branch;
    // 确认分支存在
    expect(() => git(repo, "show-ref", "--verify", `refs/heads/${oldBranch}`)).not.toThrow();

    const code = runCli(["gc"], cliOut);
    expect(code).toBe(0);

    const t = cliText();
    expect(t).toContain("孤儿 worktree");
    expect(t).toContain("task_dryrun");
    expect(t).toContain("dry-run");

    // dry-run 后目录仍存在
    expect(existsSync(info.worktreePath)).toBe(true);

    // 分支也未删除
    expect(() => git(repo, "show-ref", "--verify", `refs/heads/${oldBranch}`)).not.toThrow();
  });

  it("grande gc --apply 真正执行删除", () => {
    const info = openWorktree(layout, "demo", "fix", "task_applycli");
    const db = openDb(layout);
    db.prepare("DELETE FROM task WHERE taskId = ?").run("task_applycli");
    db.close();

    expect(existsSync(info.worktreePath)).toBe(true);

    const code = runCli(["gc", "--apply"], cliOut);
    expect(code).toBe(0);

    const t = cliText();
    expect(t).toContain("孤儿 worktree");
    expect(t).toContain("task_applycli");
    expect(t).toContain("回收孤儿 worktree");
    expect(t).toContain("完成");

    // --apply 后目录消失
    expect(existsSync(info.worktreePath)).toBe(false);

    // git worktree list 里也没了
    const paths = gitWorktreePaths(repo);
    expect(paths.has(info.worktreePath)).toBe(false);
  });

  it("输出分「孤儿 worktree」与「幽灵 task」两段，各自列出条目与合计", () => {
    // 建一个孤儿 worktree
    const info = openWorktree(layout, "demo", "fix", "task_mixed");
    const db = openDb(layout);
    db.prepare("DELETE FROM task WHERE taskId = ?").run("task_mixed");

    // 建一个幽灵 task
    createTask(db, {
      taskId: "task_mixed_ghost",
      repoId: "demo",
      branch: "grande/fix-mghost",
      baseCommit: "c0ffee",
      worktreePath: join(layout.worktreesRoot, "demo", "task_mixed_ghost"),
      state: "READY",
    });
    db.close();

    const code = runCli(["gc"], cliOut);
    expect(code).toBe(0);

    const t = cliText();
    // 两段标题
    expect(t).toContain("孤儿 worktree");
    expect(t).toContain("幽灵 task");
    // 计数值
    expect(t).toContain("1 条"); // 至少有一个计数含 "1 条"
    // 具体条目
    expect(t).toContain("task_mixed");
    expect(t).toContain("task_mixed_ghost");
  });
});
