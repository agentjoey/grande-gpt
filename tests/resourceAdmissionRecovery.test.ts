import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { getJob, listJobs, reconcileRunningJobs, setRunningJobSummary } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { markManagedJobLaunching, reserveManagedJob } from "../src/resourceAdmission.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
const TASK = "task_reservation";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-recovery-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  writeFileSync(join(layout.configDir, "resource-policy.json"), '{"minFreeBytes":1}');
  createTask(db, { taskId: TASK, repoId: "demo", branch: "grande/reservation",
    baseCommit: "1".repeat(40), worktreePath: join(layout.worktreesRoot, "demo", TASK), state: "READY" });
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const reserve = () => reserveManagedJob(db, layout, {
  jobId: "job_reserved", taskId: TASK, profile: "test", argv: [], kind: "sandbox",
});

describe("B2-1 durable reservation and recovery", () => {
  it("does not kill a live owner's pgid-less preparation during reconciliation", () => {
    reserve();
    expect(reconcileRunningJobs(db, () => false)).toBe(0);
    expect(getJob(db, "job_reserved")?.state).toBe("running");
  });

  it("preserves reservation ownership across domain summary replacement", () => {
    const before = reserve().summary?.resourceOwner;
    setRunningJobSummary(db, "job_reserved", { kind: "host-verifier-preparing" });
    expect(getJob(db, "job_reserved")?.summary?.resourceOwner).toEqual(before);
    expect(() => markManagedJobLaunching(db, "job_reserved")).not.toThrow();
  });

  it("does not release a launch-window reservation just because no pgid was recorded", () => {
    reserve(); markManagedJobLaunching(db, "job_reserved");
    db.prepare("UPDATE job SET summary=json_set(summary,'$.resourceOwner.pid',2147483647) WHERE jobId='job_reserved'").run();
    expect(reconcileRunningJobs(db, () => false)).toBe(0);
    expect(getJob(db, "job_reserved")?.state).toBe("running");
  });

  it("recovers an abandoned pre-launch reservation without guessing a process identity", () => {
    reserve();
    db.prepare("UPDATE job SET summary=json_set(summary,'$.resourceOwner.pid',2147483647) WHERE jobId='job_reserved'").run();
    expect(reconcileRunningJobs(db, () => false)).toBe(1);
    expect(getJob(db, "job_reserved")?.state).toBe("killed");
  });

  it("preserves the single-verifier limit across separate launchers", () => {
    reserveManagedJob(db, layout, { jobId: "job_host_one", taskId: TASK,
      profile: "host-verifier", argv: [], kind: "host-verifier" });
    createTask(db, { taskId: "task_other", repoId: "demo", branch: "grande/other",
      baseCommit: "1".repeat(40), worktreePath: join(layout.worktreesRoot, "demo", "task_other"), state: "READY" });
    expect(() => reserveManagedJob(db, layout, { jobId: "job_host_two", taskId: "task_other",
      profile: "host-verifier", argv: [], kind: "host-verifier" })).toThrow(/verifier|已有|capacity/);
    expect(listJobs(db)).toHaveLength(1);
  });

  it("serializes competing reservations from two real SQLite connections", async () => {
    const gate = new SharedArrayBuffer(4);
    const workers: Worker[] = [];
    let ready = 0;
    const launch = (jobId: string) => new Promise<string>((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        (async () => {
          const { reserveManagedJob } = await import(workerData.module);
          const db = new DatabaseSync(workerData.layout.stateDb);
          db.exec('PRAGMA busy_timeout=5000');
          parentPort.postMessage({ ready: true });
          const gate = new Int32Array(workerData.gate);
          if (Atomics.wait(gate, 0, 0, 5000) === 'timed-out') throw new Error('barrier timeout');
          let result;
          try {
            reserveManagedJob(db, workerData.layout, {
              jobId: workerData.jobId, taskId: workerData.taskId, profile: 'test', argv: [], kind: 'sandbox',
            });
            result = 'reserved';
          } catch (error) { result = error.code; }
          finally { db.close(); }
          parentPort.postMessage({ result });
        })().catch((error) => { throw error; });
      `, { eval: true, workerData: { gate, layout, taskId: TASK, jobId,
        module: new URL('../src/resourceAdmission.ts', import.meta.url).href } });
      workers.push(worker);
      let finished = false;
      worker.on('message', (message: { ready?: boolean; result?: string }) => {
        if (message.ready && ++ready === 2) {
          Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
        }
        if (message.result) { finished = true; resolve(message.result); }
      });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (!finished) reject(new Error(`worker exited ${code}`)); });
    });
    try {
      expect((await Promise.all([launch('job_a'), launch('job_b')])).sort()).toEqual(['JOB_RUNNING', 'reserved']);
      expect(listJobs(db, TASK)).toHaveLength(1);
    } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
  }, 15_000);
});
