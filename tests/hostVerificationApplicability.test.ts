import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { projectTaskProgress } from "../src/taskProgress.ts";
import { createTask } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "host-applicability-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "host-applicability-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  ensureLayout(loadLayout());
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("host verification applicability", () => {
  it("projects mathmagics as not-required without inspecting host verification", () => {
    const db = openDb(loadLayout());
    const task = createTask(db, {
      taskId: "task-mathmagics-applicability",
      repoId: "mathmagics",
      branch: "grande/mathmagics-applicability-0001",
      baseCommit: "base",
      worktreePath: join(ws, "mathmagics-worktree"),
      state: "READY",
    });
    let inspectorCalls = 0;

    const progress = projectTaskProgress(db, task, {
      readHead: () => "head1",
      filesChanged: () => 3,
      workingTreeDirty: () => false,
      deployConfigured: () => false,
      worktreeExists: () => true,
      hostVerificationMode: "auto",
      inspectHostVerification: () => {
        inspectorCalls += 1;
        throw new Error("non-self-host repo must not inspect host verification");
      },
    });

    expect(inspectorCalls).toBe(0);
    expect(progress.hostVerification).toMatchObject({
      requiredLevel: "none",
      state: "not-required",
      receiptEligible: true,
    });
    expect(progress.phase).not.toBe("host-verification");
    db.close();
  });
});
