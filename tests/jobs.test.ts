import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createJob, finishJob, getJob, listJobs, reconcileRunningJobs } from "../src/jobs.ts";
import { createTask } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let db: DatabaseSync;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  const l = loadLayout();
  ensureLayout(l);
  db = openDb(l);
  createTask(db, {
    taskId: "task_1", repoId: "demo", branch: "b", baseCommit: "c",
    worktreePath: "/w", state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("job 读写", () => {
  it("创建后状态为 running，argv 往返保持数组", () => {
    const j = createJob(db, { jobId: "job_1", taskId: "task_1", profile: "unit", argv: ["npm", "test"], pgid: 4242 });
    expect(j.state).toBe("running");
    expect(getJob(db, "job_1")?.argv).toEqual(["npm", "test"]);
  });

  it("finishJob 写入终态与 summary", () => {
    createJob(db, { jobId: "job_1", taskId: "task_1", profile: "unit", argv: [], pgid: 1 });
    const done = finishJob(db, "job_1", {
      state: "failed", exitCode: 1, artifactPath: "/a/1", summary: { failedTests: ["x"] },
    });
    expect(done.state).toBe("failed");
    expect(done.endedAt).not.toBeNull();
    expect(getJob(db, "job_1")?.summary).toEqual({ failedTests: ["x"] });
  });

  it("listJobs 可按 taskId 过滤，且按开始时间倒序", () => {
    createJob(db, { jobId: "job_1", taskId: "task_1", profile: "unit", argv: [], pgid: null });
    createJob(db, { jobId: "job_2", taskId: "task_1", profile: "lint", argv: [], pgid: null });
    expect(listJobs(db, "task_1").map((j) => j.jobId)).toEqual(["job_2", "job_1"]);
    expect(listJobs(db).length).toBe(2);
  });
});

describe("reconcileRunningJobs()", () => {
  it("进程组已消失的 running job 被标记为 killed", () => {
    createJob(db, { jobId: "job_dead", taskId: "task_1", profile: "unit", argv: [], pgid: 99999 });
    expect(reconcileRunningJobs(db, () => false)).toBe(1);
    expect(getJob(db, "job_dead")?.state).toBe("killed");
  });

  it("进程组仍存活的 running job 保持不动——重启后可重新接管监控", () => {
    createJob(db, { jobId: "job_alive", taskId: "task_1", profile: "unit", argv: [], pgid: 4242 });
    expect(reconcileRunningJobs(db, () => true)).toBe(0);
    expect(getJob(db, "job_alive")?.state).toBe("running");
  });

  it("没有 pgid 的 running job 无法探活，直接标记 killed 而不是永远挂着", () => {
    createJob(db, { jobId: "job_nopgid", taskId: "task_1", profile: "unit", argv: [], pgid: null });
    expect(reconcileRunningJobs(db, () => true)).toBe(1);
    expect(getJob(db, "job_nopgid")?.state).toBe("killed");
  });

  it("已到终态的 job 不受影响", () => {
    createJob(db, { jobId: "job_done", taskId: "task_1", profile: "unit", argv: [], pgid: 1 });
    finishJob(db, "job_done", { state: "passed", exitCode: 0, artifactPath: null, summary: null });
    reconcileRunningJobs(db, () => false);
    expect(getJob(db, "job_done")?.state).toBe("passed");
  });
});
