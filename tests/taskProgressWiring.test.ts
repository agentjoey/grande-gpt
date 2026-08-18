import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools } from "../src/tools.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "progress-wire-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "progress-wire-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  const layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(ws, "demo", ".git"), { recursive: true });
  saveRegistry(layout, [{ repoId: "demo", path: join(ws, "demo"), registered: true }]);
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("grande_task_status S10 progress wiring", () => {
  it("单 task 状态附带 7-stage projection + nextAction，不要求用户翻 SQLite", async () => {
    const layout = loadLayout();
    const db = openDb(layout);
    createTask(db, {
      taskId: "task-wire",
      repoId: "demo",
      branch: "grande/wire-0001",
      baseCommit: "base",
      worktreePath: join(ws, "missing-worktree"),
      state: "READY",
    });
    const status = buildTools({ db, layout }).find((tool) => tool.name === "grande_task_status")!;
    const result = await status.handler({ taskId: "task-wire" });
    const envelope = result.structuredContent as { ok: boolean; data?: Record<string, any>; hint?: string };

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.progress?.stages).toHaveProperty("code");
    expect(envelope.data?.progress?.stages).toHaveProperty("tests");
    expect(envelope.data?.progress?.stages).toHaveProperty("pr");
    expect(envelope.data?.progress?.stages).toHaveProperty("ci");
    expect(envelope.data?.progress?.stages).toHaveProperty("merged");
    expect(envelope.data?.progress?.stages).toHaveProperty("deploy");
    expect(envelope.data?.progress?.stages).toHaveProperty("verify");
    expect(typeof envelope.data?.progress?.nextAction).toBe("string");
    expect(envelope.hint).toContain("grande gc");
    db.close();
  });

  it("总览也给每个 active task 附带 projection，便于一眼区分运行/完成/待 cleanup", async () => {
    const layout = loadLayout();
    const db = openDb(layout);
    createTask(db, {
      taskId: "task-wire",
      repoId: "demo",
      branch: "grande/wire-0001",
      baseCommit: "base",
      worktreePath: join(ws, "missing-worktree"),
      state: "READY",
    });
    const status = buildTools({ db, layout }).find((tool) => tool.name === "grande_task_status")!;
    const result = await status.handler({});
    const envelope = result.structuredContent as { ok: boolean; data?: { activeTasks?: Array<Record<string, any>> } };

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.activeTasks?.[0]?.progress?.stages).toHaveProperty("deploy");
    expect(envelope.data?.activeTasks?.[0]?.progress).toHaveProperty("cleanupRequired");
    db.close();
  });
});
