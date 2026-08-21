import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { reconcileHostVerifierJobsAtStartup } from "../src/hostVerifierRecovery.ts";
import { createJob, finishJob, getJob, setRunningJobSummary } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
const taskId = "task_recovery";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-verifier-recovery-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  const worktree = join(root, "task-worktree");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch: "grande/recovery",
    baseCommit: "0".repeat(40),
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function verifier(jobId: string, pgid: number | null, disposableRoot: string): void {
  createJob(db, {
    jobId,
    taskId,
    profile: "host-verifier",
    argv: ["trusted-host-verifier", "smoke", "a".repeat(40)],
    pgid,
  });
  setRunningJobSummary(db, jobId, {
    kind: "host-verifier-running",
    repoId: "grande-gpt",
    commit: "a".repeat(40),
    level: "smoke",
    disposableRoot,
  });
}

describe("D1 host verifier startup reconciliation", () => {
  it("kills only the recorded live verifier process group, cleans its disposable root, and records restart interruption", async () => {
    const disposableRoot = mkdtempSync(join(tmpdir(), "grande-host-verifier-"));
    verifier("job_live_verifier", 43210, disposableRoot);
    const killed: number[] = [];
    const cleaned: string[] = [];

    const count = await reconcileHostVerifierJobsAtStartup(
      { db, layout },
      {
        isAlive: (pgid) => pgid === 43210,
        killGroup: async (pgid) => { killed.push(pgid); },
        cleanupDisposable: async (job, path) => { cleaned.push(`${job.jobId}:${path}`); return { cleaned: true }; },
      },
    );

    expect(count).toBe(1);
    expect(killed).toEqual([43210]);
    expect(cleaned).toEqual([`job_live_verifier:${disposableRoot}`]);
    expect(getJob(db, "job_live_verifier")).toMatchObject({
      state: "killed",
      summary: {
        kind: "host-verifier-failure",
        infrastructureFailure: true,
        reason: "interrupted_by_gateway_restart",
        cleaned: true,
      },
    });
  });

  it("converges a verifier with no pgid instead of leaving it permanently running", async () => {
    const disposableRoot = mkdtempSync(join(tmpdir(), "grande-host-verifier-"));
    verifier("job_no_pgid", null, disposableRoot);
    let killCalls = 0;

    const count = await reconcileHostVerifierJobsAtStartup(
      { db, layout },
      {
        isAlive: () => true,
        killGroup: async () => { killCalls += 1; },
        cleanupDisposable: async () => ({ cleaned: true }),
      },
    );

    expect(count).toBe(1);
    expect(killCalls).toBe(0);
    expect(getJob(db, "job_no_pgid")?.state).toBe("killed");
    expect(getJob(db, "job_no_pgid")?.summary?.reason).toBe("interrupted_by_gateway_restart");
  });

  it("does not touch ordinary running jobs or overwrite a verifier that already reached a real terminal result", async () => {
    createJob(db, { jobId: "job_unit", taskId, profile: "unit-selfhost", argv: [], pgid: 9876 });
    const terminalRoot = mkdtempSync(join(tmpdir(), "grande-host-verifier-"));
    verifier("job_done", 1111, terminalRoot);
    finishJob(db, "job_done", {
      state: "passed",
      exitCode: 0,
      artifactPath: null,
      summary: { kind: "host-verifier-v2", commit: "a".repeat(40) },
    });
    let killCalls = 0;
    let cleanupCalls = 0;

    const count = await reconcileHostVerifierJobsAtStartup(
      { db, layout },
      {
        isAlive: () => true,
        killGroup: async () => { killCalls += 1; },
        cleanupDisposable: async () => { cleanupCalls += 1; return { cleaned: true }; },
      },
    );

    expect(count).toBe(0);
    expect(killCalls).toBe(0);
    expect(cleanupCalls).toBe(0);
    expect(getJob(db, "job_unit")?.state).toBe("running");
    expect(getJob(db, "job_done")?.state).toBe("passed");
  });
});
