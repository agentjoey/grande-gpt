import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginAudit } from "../src/audit.ts";
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
  ws = mkdtempSync(join(tmpdir(), "merge-progress-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "merge-progress-ctrl-"));
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

function succeeded(db: ReturnType<typeof openDb>, tool: string): void {
  const audit = beginAudit(db, { taskId: "task-progress-host", tool, input: {} });
  expect(audit.allowed()).toBe(true);
  expect(audit.executing()).toBe(true);
  expect(audit.succeeded()).toBe(true);
}

describe("host verifier vs merge progress projection", () => {
  it("successful host-verification dispatch keeps merged pending until the real merge audit succeeds", () => {
    const layout = loadLayout();
    const db = openDb(layout);
    const task = createTask(db, {
      taskId: "task-progress-host",
      repoId: "grande-gpt",
      branch: "grande/progress-host-0001",
      baseCommit: "base",
      worktreePath: join(ws, "fake-worktree"),
      state: "READY",
    });

    succeeded(db, "grande_pr_open");
    succeeded(db, "grande_pr_merge_host_verification");

    const beforeMerge = projectTaskProgress(db, task, {
      readHead: () => "head1",
      filesChanged: () => 1,
      workingTreeDirty: () => false,
      worktreeExists: () => true,
      deployConfigured: () => false,
    });
    expect(beforeMerge.stages.pr.state).toBe("done");
    expect(beforeMerge.stages.merged.state).toBe("pending");
    expect(beforeMerge.completed).toBe(false);

    succeeded(db, "grande_pr_merge");
    const afterMerge = projectTaskProgress(db, task, {
      readHead: () => "head1",
      filesChanged: () => 1,
      workingTreeDirty: () => false,
      worktreeExists: () => true,
      deployConfigured: () => false,
    });
    expect(afterMerge.stages.merged.state).toBe("done");

    db.close();
  });
});
