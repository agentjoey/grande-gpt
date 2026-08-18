import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
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
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos:\n  grande-gpt:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","tests/sandbox.test.ts"], timeoutSeconds: 600 }\n',
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
});
