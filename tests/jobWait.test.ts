import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { createJob, finishJob, getJob } from "../src/jobs.ts";
import { waitForTerminalJob } from "../src/jobWait.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let db: DatabaseSync;
let savedWorkspace: string | undefined;
let savedControl: string | undefined;
let monotonicMs: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-21T00:00:00Z"));
  monotonicMs = 0;
  savedWorkspace = process.env.GRANDE_WORKSPACE;
  savedControl = process.env.GRANDE_CONTROL;
  root = mkdtempSync(join(tmpdir(), "job-wait-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  const layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId: "task_wait", repoId: "demo", branch: "grande/wait",
    baseCommit: "abc123", worktreePath: join(root, "worktree"), state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWorkspace;
  process.env.GRANDE_CONTROL = savedControl;
  vi.useRealTimers();
});

function runningJob(jobId: string): void {
  createJob(db, {
    jobId, taskId: "task_wait", profile: "ok", argv: ["true"], pgid: 123,
  });
}

describe("waitForTerminalJob", () => {
  it("returns at once when the job is already terminal", async () => {
    runningJob("job_terminal");
    finishJob(db, "job_terminal", {
      state: "passed", exitCode: 0, artifactPath: null, summary: null,
    });
    const startedAt = Date.now();

    await waitForTerminalJob(db, "job_terminal", {
      sleep: async () => { throw new Error("terminal jobs must not sleep"); },
    });

    expect(Date.now() - startedAt).toBe(0);
  });

  it("returns after a running job transitions to terminal", async () => {
    runningJob("job_transition");
    const startedAt = Date.now();

    await waitForTerminalJob(db, "job_transition", {
      timeoutMs: 15,
      intervalMs: 5,
      now: () => monotonicMs,
      sleep: async (ms) => {
        monotonicMs += ms;
        vi.advanceTimersByTime(ms);
        finishJob(db, "job_transition", {
          state: "passed", exitCode: 0, artifactPath: null, summary: null,
        });
      },
    });

    expect(getJob(db, "job_transition")!.state).toBe("passed");
    expect(monotonicMs).toBe(5);
    expect(Date.now() - startedAt).toBe(5);
  });

  it("returns at the deadline while a job remains running", async () => {
    runningJob("job_deadline");
    const startedAt = Date.now();

    await waitForTerminalJob(db, "job_deadline", {
      intervalMs: 5_000,
      now: () => monotonicMs,
      sleep: async (ms) => {
        monotonicMs += ms;
        vi.advanceTimersByTime(ms);
      },
    });

    expect(getJob(db, "job_deadline")!.state).toBe("running");
    expect(monotonicMs).toBe(15_000);
    expect(Date.now() - startedAt).toBe(15_000);
  });

  it("uses monotonic elapsed time when the wall clock rolls backward", async () => {
    runningJob("job_clock_rollback");
    const wallStartedAt = Date.now();
    const monotonicStartedAt = performance.now();

    await waitForTerminalJob(db, "job_clock_rollback", {
      intervalMs: 5_000,
      sleep: async (ms) => {
        vi.advanceTimersByTime(ms);
        vi.setSystemTime(Date.now() - 60_000);
        if (performance.now() - monotonicStartedAt > 15_000) {
          throw new Error("wait exceeded the 15-second monotonic deadline");
        }
      },
    });

    expect(getJob(db, "job_clock_rollback")!.state).toBe("running");
    expect(performance.now() - monotonicStartedAt).toBe(15_000);
    expect(Date.now()).toBeLessThan(wallStartedAt);
  });

  it("returns at once when the job is missing", async () => {
    const startedAt = Date.now();

    await waitForTerminalJob(db, "job_missing", {
      sleep: async () => { throw new Error("missing jobs must not sleep"); },
    });

    expect(Date.now() - startedAt).toBe(0);
  });
});
