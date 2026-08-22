import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { buildHostVerifierStaticPlan, type HostVerifierRequest } from "../src/hostVerifier.ts";
import {
  createHostVerifierLauncher,
  type HostVerifierExecutionResult,
  type HostVerifierPreparedRun,
  type HostVerifierRuntimeAdapter,
} from "../src/hostVerifierRuntime.ts";
import { getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { getOuterTestReceipt } from "../src/outerTestReceipt.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
const taskId = "task-host-runtime";
const commit = "a".repeat(40);

function request(overrides: Partial<HostVerifierRequest> = {}): HostVerifierRequest {
  return { taskId, repoId: "grande-gpt", commit, level: "full", ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-verifier-runtime-unit-"));
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
    branch: "grande/runtime",
    baseCommit: "0".repeat(40),
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function prepared(disposableRoot: string): HostVerifierPreparedRun {
  return {
    disposableRoot,
    sourceRoot: join(disposableRoot, "source"),
    jobTmp: join(disposableRoot, "job"),
    loopbackPorts: [49173],
    hostToolchain: {
      node: "v24.14.0",
      pnpm: "10.33.0",
      lockfileSha256: "b".repeat(64),
    },
  };
}

function passedResult(): HostVerifierExecutionResult {
  return {
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    truncated: false,
    killedBy: null,
    durationMs: 25,
    peakRssMb: 32,
  };
}

function adapter(overrides: Partial<HostVerifierRuntimeAdapter> = {}): HostVerifierRuntimeAdapter {
  return {
    prepare: async ({ disposableRoot }) => prepared(disposableRoot),
    execute: async (_run, onSpawn) => {
      onSpawn(43210);
      return passedResult();
    },
    readCurrentHeads: async () => ({ taskHead: commit, prHead: commit }),
    cleanup: async () => {},
    ...overrides,
  };
}

describe("host verifier trusted launcher", () => {
  it("returns a running job immediately and attaches the real pgid after async spawn", async () => {
    let release!: (result: HostVerifierExecutionResult) => void;
    const execution = new Promise<HostVerifierExecutionResult>((resolve) => { release = resolve; });
    let preparedRoot = "";
    const launch = createHostVerifierLauncher({ db, layout }, adapter({
      prepare: async ({ disposableRoot }) => {
        preparedRoot = disposableRoot;
        return prepared(disposableRoot);
      },
      execute: async (_run, onSpawn) => {
        onSpawn(43210);
        return execution;
      },
    }));

    const started = launch(request(), buildHostVerifierStaticPlan("full"));
    expect(started.jobId).toMatch(/^job_/);
    expect(getJob(db, started.jobId)).toMatchObject({ state: "running", pgid: null, profile: "host-verifier" });
    await Promise.resolve();
    await Promise.resolve();
    expect(getJob(db, started.jobId)?.pgid).toBe(43210);
    expect(preparedRoot).toContain("grande-host-verifier-");
    expect(preparedRoot).not.toBe(db.prepare("SELECT worktreePath FROM task WHERE taskId=?").get(taskId)?.worktreePath);

    release(passedResult());
    await started.settled;
    expect(getJob(db, started.jobId)?.state).toBe("passed");
  });

  it("issues V2 only after a passed exact-SHA run whose task and PR heads still match", async () => {
    const launch = createHostVerifierLauncher({ db, layout }, adapter());
    const started = launch(request(), buildHostVerifierStaticPlan("full"));
    await started.settled;

    const job = getJob(db, started.jobId)!;
    expect(job.state).toBe("passed");
    expect(job.exitCode).toBe(0);
    expect(job.summary).toMatchObject({
      kind: "host-verifier-v2",
      mode: "auto",
      repoId: "grande-gpt",
      commit,
      level: "full",
      loopbackPorts: [49173],
    });
    expect(getOuterTestReceipt(db, taskId)).toMatchObject({
      version: 2,
      mode: "auto",
      taskId,
      repoId: "grande-gpt",
      commit,
      jobId: started.jobId,
    });
  });

  it("manual trusted launcher issues V2 manual receipt without requiring a PR head", async () => {
    const launch = createHostVerifierLauncher(
      { db, layout },
      adapter({ readCurrentHeads: async () => ({ taskHead: commit, prHead: null }) }),
      { receiptMode: "manual", requirePrHead: false },
    );
    const started = launch(request(), buildHostVerifierStaticPlan("full"));
    await started.settled;

    expect(getJob(db, started.jobId)?.summary).toMatchObject({ kind: "host-verifier-v2", mode: "manual", commit });
    expect(getOuterTestReceipt(db, taskId)).toMatchObject({
      version: 2,
      mode: "manual",
      taskId,
      commit,
      jobId: started.jobId,
    });
  });

  it("keeps a successful test result but issues no reusable receipt when task or PR SHA drifts", async () => {
    const launch = createHostVerifierLauncher({ db, layout }, adapter({
      readCurrentHeads: async () => ({ taskHead: "c".repeat(40), prHead: commit }),
    }));
    const started = launch(request(), buildHostVerifierStaticPlan("full"));
    await started.settled;

    const job = getJob(db, started.jobId)!;
    expect(job.state).toBe("passed");
    expect(job.summary).toMatchObject({ kind: "host-verifier-v2-stale", commit });
    expect(getOuterTestReceipt(db, taskId)).toBeNull();
  });

  it("fails closed on test or cleanup failure and never writes a receipt", async () => {
    let cleaned = 0;
    const failed = createHostVerifierLauncher({ db, layout }, adapter({
      execute: async (_run, onSpawn) => {
        onSpawn(11111);
        return { ...passedResult(), exitCode: 1, stderr: "test failed" };
      },
      cleanup: async () => { cleaned++; },
    }));
    const first = failed(request(), buildHostVerifierStaticPlan("full"));
    await first.settled;
    expect(getJob(db, first.jobId)).toMatchObject({
      state: "failed",
      summary: { failureClass: "candidate", reason: "test_failed" },
    });
    expect(cleaned).toBe(1);
    expect(getOuterTestReceipt(db, taskId)).toBeNull();

    const cleanupFails = createHostVerifierLauncher({ db, layout }, adapter({
      cleanup: async () => { throw new Error("cleanup failed"); },
    }));
    const second = cleanupFails(request(), buildHostVerifierStaticPlan("full"));
    await second.settled;
    expect(getJob(db, second.jobId)).toMatchObject({
      state: "failed",
      exitCode: 0,
      summary: { failureClass: "infrastructure", reason: "cleanup_failed" },
    });
    expect(getOuterTestReceipt(db, taskId)).toBeNull();
  });

  it("rejects non-grande-gpt and task/repo mismatches before creating a verifier job", () => {
    const launch = createHostVerifierLauncher({ db, layout }, adapter());
    expect(() => launch(request({ repoId: "other" }), buildHostVerifierStaticPlan("full"))).toThrow(/grande-gpt|repo/i);
    expect(db.prepare("SELECT count(*) AS n FROM job").get()).toEqual({ n: 0 });
  });
});
