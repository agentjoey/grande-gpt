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
  ws = mkdtempSync(join(tmpdir(), "progress-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "progress-ctrl-"));
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

function task(db: ReturnType<typeof openDb>) {
  return createTask(db, {
    taskId: "task-progress",
    repoId: "demo",
    branch: "grande/progress-0001",
    baseCommit: "base",
    worktreePath: join(ws, "fake-worktree"),
    state: "READY",
  });
}

function addPassedAttestation(db: ReturnType<typeof openDb>, commit = "head1"): void {
  db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,pgid,exitCode,startedAt,endedAt,artifactPath,summary,workspaceDigest,hostToolchain)
     VALUES ('job-pass','task-progress','typecheck','[]','passed',NULL,0,1,2,NULL,NULL,'digest',?)`,
  ).run(JSON.stringify({ node: "v24", pnpm: "10", lockfileSha256: "abc" }));
  db.prepare(
    `INSERT INTO attestation (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES ('att-pass','task-progress',?,'typecheck','job-pass',0,1,2,?)`,
  ).run(commit, JSON.stringify({ node: "v24", pnpm: "10", lockfileSha256: "abc" }));
}

function succeeded(db: ReturnType<typeof openDb>, tool: string): void {
  const audit = beginAudit(db, { taskId: "task-progress", tool, input: {} });
  expect(audit.allowed()).toBe(true);
  expect(audit.executing()).toBe(true);
  expect(audit.succeeded()).toBe(true);
}

const baseOptions = {
  readHead: () => "head1",
  filesChanged: () => 3,
  workingTreeDirty: () => false,
  worktreeExists: () => true,
};

describe("task lifecycle projection", () => {
  it("无 deploy 配置时，merge gate + 当前 SHA attestation 足以投影 DONE，但 cleanup 仍必须显式 task_close", () => {
    const layout = loadLayout();
    const db = openDb(layout);
    const t = task(db);
    addPassedAttestation(db);
    succeeded(db, "grande_pr_open");
    succeeded(db, "grande_pr_merge");

    const progress = projectTaskProgress(db, t, {
      ...baseOptions,
      deployConfigured: () => false,
    });

    expect(progress.stages).toMatchObject({
      code: { state: "done" },
      tests: { state: "done" },
      pr: { state: "done" },
      ci: { state: "done" },
      merged: { state: "done" },
      deploy: { state: "not-applicable" },
      verify: { state: "not-applicable" },
    });
    expect(progress.completed).toBe(true);
    expect(progress.cleanupRequired).toBe(true);
    expect(progress.nextAction).toContain("grande_task_close");
    db.close();
  });

  it("有 deploy spec 且 deploy job 已失败时明确投影为 blocked，不把 receipt 存在误报成 deployed", () => {
    const layout = loadLayout();
    const db = openDb(layout);
    const t = task(db);
    addPassedAttestation(db);
    succeeded(db, "grande_pr_open");
    succeeded(db, "grande_pr_merge");
    db.prepare(
      `INSERT INTO job (jobId,taskId,profile,argv,state,pgid,exitCode,startedAt,endedAt,artifactPath,summary,workspaceDigest,hostToolchain)
       VALUES ('job-deploy','task-progress','deploy-production','[]','failed',NULL,1,3,4,NULL,NULL,NULL,NULL)`,
    ).run();
    db.prepare("INSERT INTO deployment_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)").run(
      "task-progress",
      JSON.stringify({
        taskId: "task-progress",
        specDigest: "spec",
        deployRef: "profile:deploy-production",
        verifyRef: "profile:verify-production",
        deployComplete: false,
        deployJobId: "job-deploy",
        verifyComplete: false,
      }),
      4,
    );

    const progress = projectTaskProgress(db, t, {
      ...baseOptions,
      deployConfigured: () => true,
    });
    expect(progress.stages.deploy.state).toBe("blocked");
    expect(progress.stages.verify.state).toBe("pending");
    expect(progress.completed).toBe(false);
    expect(progress.blocker).toContain("deploy");
    db.close();
  });

  it("当前 HEAD 虽有旧 attestation，但 worktree 又变脏时 Tests 回到 pending，不能复用旧验证", () => {
    const layout = loadLayout();
    const db = openDb(layout);
    const t = task(db);
    addPassedAttestation(db);

    const progress = projectTaskProgress(db, t, {
      ...baseOptions,
      workingTreeDirty: () => true,
      deployConfigured: () => false,
    });
    expect(progress.stages.tests.state).toBe("pending");
    expect(progress.stages.tests.detail).toContain("未提交");
    expect(progress.completed).toBe(false);
    db.close();
  });
});
