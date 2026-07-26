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
    expect(done).toBeDefined();
    expect(done?.state).toBe("failed");
    expect(done?.endedAt).not.toBeNull();
    expect(getJob(db, "job_1")?.summary).toEqual({ failedTests: ["x"] });
  });

  it("对同一个 job 连续两次 finishJob——第二次是 no-op，终态不会被二次改写", () => {
    createJob(db, { jobId: "job_double", taskId: "task_1", profile: "unit", argv: [], pgid: 1 });
    const first = finishJob(db, "job_double", {
      state: "passed", exitCode: 0, artifactPath: null, summary: null,
    });
    expect(first?.state).toBe("passed");

    const second = finishJob(db, "job_double", {
      state: "cancelled", exitCode: null, artifactPath: null, summary: null,
    });
    expect(second).toBeUndefined();
    expect(getJob(db, "job_double")?.state).toBe("passed");
    expect(getJob(db, "job_double")?.exitCode).toBe(0);
  });

  it("listJobs 可按 taskId 过滤，且按开始时间倒序", () => {
    createJob(db, { jobId: "job_1", taskId: "task_1", profile: "unit", argv: [], pgid: null });
    createJob(db, { jobId: "job_2", taskId: "task_1", profile: "lint", argv: [], pgid: null });
    // 两个 job 都挂在同一个 taskId 下不足以证明「过滤」——即使 listJobs 完全
    // 忽略 taskId 参数、把所有 job 都列出来，上面两行断言也会看起来通过，因为
    // job_1/job_2 反正都在结果里。这里现造一个第二任务和它自己的 job，只有
    // 过滤真的排除了别的任务，job_other 才不会出现（同一缺陷类型，参见
    // tests/cli.test.ts 的 "--task 过滤"）。
    createTask(db, {
      taskId: "task_other", repoId: "demo", branch: "b2", baseCommit: "c",
      worktreePath: "/w2", state: "READY",
    });
    createJob(db, { jobId: "job_other", taskId: "task_other", profile: "unit", argv: [], pgid: null });

    expect(listJobs(db, "task_1").map((j) => j.jobId)).toEqual(["job_2", "job_1"]);
    expect(listJobs(db, "task_1").map((j) => j.jobId)).not.toContain("job_other");
    expect(listJobs(db).length).toBe(3);
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

  it("探活的瞬间 job 自己已经跑完并写入真实结果——reconcile 不得覆盖", () => {
    createJob(db, { jobId: "job_race", taskId: "task_1", profile: "unit", argv: [], pgid: 555 });
    // 模拟 reconcileRunningJobs 的 read（listJobs 快照）与 write（finishJob）之间
    // 没有原子性这件事的真实后果：isAlive(pgid) 被调用的那一刻，进程其实已经
    // 正常退出，且退出处理路径抢先一步把真实结果写进了库——然后 isAlive 才告诉
    // reconcile「进程组已经不在了」。
    const isAlive = (_pgid: number) => {
      finishJob(db, "job_race", {
        state: "passed", exitCode: 0, artifactPath: null, summary: { real: true },
      });
      return false;
    };
    expect(reconcileRunningJobs(db, isAlive)).toBe(0);
    const after = getJob(db, "job_race");
    expect(after?.state).toBe("passed");
    expect(after?.exitCode).toBe(0);
    expect(after?.summary).toEqual({ real: true });
  });
});
