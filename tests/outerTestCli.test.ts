import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { TRUSTED_HOST_MANIFEST } from "../src/hostVerification.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;
let lines: string[];

function syncCli(argv: string[]): number {
  const result = runCli(argv, (line) => lines.push(line));
  if (typeof result !== "number") throw new Error("outer-test 应同步返回退出码");
  return result;
}

type TestOuterSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: "inherit"; encoding: "utf8" },
) => { status: number | null; error?: Error };

function syncCliWithOuterTestSpawn(argv: string[], spawn: TestOuterSpawn): number {
  const callable = runCli as unknown as (
    argv: string[],
    out: (line: string) => void,
    options: { outerTestSpawn: TestOuterSpawn },
  ) => number | Promise<number>;
  const result = callable(argv, (line) => lines.push(line), { outerTestSpawn: spawn });
  if (typeof result !== "number") throw new Error("outer-test 应同步返回退出码");
  return result;
}

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

function prepareRunnableTask(taskId: string): { worktreePath: string; head: string } {
  const layout = loadLayout();
  const worktreePath = join(ws, ".grande-work", "worktrees", "grande-gpt", taskId);
  mkdirSync(worktreePath, { recursive: true });
  git(worktreePath, "init", "-q", "-b", "grande/s18");
  git(
    worktreePath,
    "-c", "user.name=GrandeGPT",
    "-c", "user.email=grande@example.com",
    "commit", "--allow-empty", "-q", "-m", "base",
  );
  const head = git(worktreePath, "rev-parse", "HEAD").trim();

  const db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch: "grande/s18",
    baseCommit: head,
    worktreePath,
    state: "READY",
  });
  db.close();
  return { worktreePath, head };
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "ot-cli-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "ot-cli-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  lines = [];

  const layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(ws, "grande-gpt"), { recursive: true });
  const excludes = [
    "tests/sandbox.test.ts",
    "tests/runner.test.ts",
    "tests/server.test.ts",
    "tests/tools.test.ts",
    "tests/e2e.test.ts",
  ].flatMap((file) => ["--exclude", file]);
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos:\n  grande-gpt:\n" +
      `    unit-selfhost: { argv: ${JSON.stringify(["npx", "vitest", "run", ...excludes])}, timeoutSeconds: 600 }\n`,
    "utf8",
  );
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("grande outer-test --task", () => {
  it("显式 taskId 时把验收目标锁定到 task.worktreePath，而不是 canonical checkout", () => {
    const layout = loadLayout();
    const db = openDb(layout);
    const worktreePath = join(ws, ".grande-work", "worktrees", "grande-gpt", "task_phase4");
    createTask(db, {
      taskId: "task_phase4",
      repoId: "grande-gpt",
      branch: "grande/phase4",
      baseCommit: "abc123",
      worktreePath,
      state: "READY",
    });
    db.close();

    expect(syncCli(["outer-test", "--task", "task_phase4"])).toBe(0);
    expect(lines.join("\n")).toContain(worktreePath);
  });

  it("--task 后没有值时 fail closed，不退化成验收 canonical", () => {
    expect(syncCli(["outer-test", "--task"])).not.toBe(0);
    expect(lines.join("\n")).toContain("--task");
  });

  it("--run uses the dedicated host config and manifest-selected files", () => {
    prepareRunnableTask("task_host_plan");
    let seenArgs: readonly string[] = [];
    expect(syncCliWithOuterTestSpawn(
      ["outer-test", "--task", "task_host_plan", "--run"],
      (_command, args) => {
        seenArgs = args;
        return { status: 0 };
      },
    )).toBe(0);
    expect(seenArgs).toEqual([
      "vitest", "run", "--config", "vitest.host.config.ts",
      ...TRUSTED_HOST_MANIFEST.map((entry) => entry.file),
    ]);
  });

  it("--run 成功后把 host outer-test receipt 绑定到运行前锁定的 task HEAD", () => {
    const { head } = prepareRunnableTask("task_s18_receipt");

    expect(syncCliWithOuterTestSpawn(
      ["outer-test", "--task", "task_s18_receipt", "--run"],
      () => ({ status: 0 }),
    )).toBe(0);

    const db = openDb(loadLayout());
    const row = db.prepare("SELECT receiptJson FROM outer_test_receipt WHERE taskId=?").get("task_s18_receipt") as
      | { receiptJson: string }
      | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(JSON.parse(row!.receiptJson)).toMatchObject({
      taskId: "task_s18_receipt",
      commit: head,
      profile: "unit-selfhost",
      files: TRUSTED_HOST_MANIFEST.map((entry) => entry.file),
    });
    expect(lines.join("\n")).toMatch(/receipt|凭据|验证记录/i);
  });

  it("--run 期间 task HEAD 改变时即使测试进程 exit 0 也不签发 receipt", () => {
    const { worktreePath } = prepareRunnableTask("task_s18_drift");

    const code = syncCliWithOuterTestSpawn(
      ["outer-test", "--task", "task_s18_drift", "--run"],
      () => {
        git(
          worktreePath,
          "-c", "user.name=Other",
          "-c", "user.email=other@example.com",
          "commit", "--allow-empty", "-q", "-m", "concurrent change",
        );
        return { status: 0 };
      },
    );

    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/receipt.*失败|HEAD.*变化|不要合并/i);
    const db = openDb(loadLayout());
    const row = db.prepare("SELECT receiptJson FROM outer_test_receipt WHERE taskId=?").get("task_s18_drift");
    db.close();
    expect(row).toBeUndefined();
  });
});
