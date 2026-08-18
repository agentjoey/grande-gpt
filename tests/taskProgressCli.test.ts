import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;
let lines: string[];

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "progress-cli-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "progress-cli-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  lines = [];
  const layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(ws, "demo", ".git"), { recursive: true });
  saveRegistry(layout, [{ repoId: "demo", path: join(ws, "demo"), registered: true }]);
  const db = openDb(layout);
  createTask(db, {
    taskId: "task-cli-progress",
    repoId: "demo",
    branch: "grande/progress-0001",
    baseCommit: "base",
    worktreePath: join(ws, "missing-worktree"),
    state: "READY",
  });
  db.close();
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("grande status progress UX", () => {
  it("一屏显示 Code/Tests/PR/CI/Merged/Deploy/Verify 和下一步，不再只显示最近 job", () => {
    const result = runCli(["status"], (line) => lines.push(line));
    expect(typeof result).toBe("number");
    expect(result).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Code");
    expect(text).toContain("Tests");
    expect(text).toContain("PR");
    expect(text).toContain("CI");
    expect(text).toContain("Merged");
    expect(text).toContain("Deploy");
    expect(text).toContain("Verify");
    expect(text).toContain("下一步");
  });
});
