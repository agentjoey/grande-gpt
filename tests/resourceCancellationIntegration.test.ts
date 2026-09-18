import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAudit, listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { awaitAllJobsSettled, startJob, type RunnerDeps } from "../src/runner.ts";
import type { RunOptions, RunResult } from "../src/sandbox.ts";
import { createTask } from "../src/tasks.ts";

const TASK = "task_cancel_owned";
let root: string;
let deps: RunnerDeps;
let worktree: string;
let signal: AbortSignal | undefined;
let release: (() => void) | undefined;
const passed: RunResult = { exitCode: 0, stdout: "done", stderr: "", truncated: false,
  killedBy: null, killSignalSkipped: false, durationMs: 1, peakRssMb: 0 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-cancel-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace")); vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  const layout = loadLayout(); ensureLayout(layout);
  mkdirSync(join(layout.workspaceRoot, "demo", ".git"), { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n");
  writeFileSync(join(layout.configDir, "profiles.yaml"), 'repos:\n  demo:\n    test: { argv: ["/bin/echo", "ok"], timeoutSeconds: 30 }\n');
  writeFileSync(join(layout.configDir, "resource-policy.json"), '{"minFreeBytes":1}');
  worktree = join(layout.worktreesRoot, "demo", TASK); mkdirSync(worktree, { recursive: true });
  signal = undefined; release = undefined;
  deps = { db: openDb(layout), layout, jobSandboxRunner: (options) => {
    signal = (options as RunOptions & { signal?: AbortSignal }).signal;
    options.onSpawn?.(2_000_001);
    return new Promise<RunResult>((resolve) => { release = () => resolve(passed); });
  } };
  createTask(deps.db, { taskId: TASK, repoId: "demo", branch: "grande/cancel-owned", baseCommit: "1".repeat(40), worktreePath: worktree, state: "READY" });
});
afterEach(async () => { release?.(); await awaitAllJobsSettled(2000); deps.db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function launch() {
  const audit = beginAudit(deps.db, { taskId: TASK, tool: "grande_run", input: {} }); audit.allowed();
  return startJob(deps, { taskId: TASK, repoId: "demo", worktreePath: worktree, profileName: "test" }, audit);
}

async function cancel(jobId: string, taskId = TASK) {
  const { requestJobCancellation } = await import("../src/jobCancellation.ts");
  return requestJobCancellation(deps.db, taskId, jobId);
}

describe("B2-2 owned cancellation through the real runner", () => {
  it("registers a cancellation signal before execution and holds capacity until settlement", async () => {
    const started = launch();
    expect(signal).toBeInstanceOf(AbortSignal);
    const result = await cancel(started.jobId);
    expect(result).toMatchObject({ jobId: started.jobId, requested: true, state: "running" });
    expect(signal!.aborted).toBe(true);
    expect(getJob(deps.db, started.jobId)?.state).toBe("running");
    expect(() => launch()).toThrow(/已有|capacity/);
    release!(); await awaitAllJobsSettled(2000);
    expect(getJob(deps.db, started.jobId)?.state).toBe("cancelled");
  });

  it("repeated cancellation records one request and cannot overwrite the terminal outcome", async () => {
    const started = launch();
    expect(signal).toBeInstanceOf(AbortSignal);
    await cancel(started.jobId); await cancel(started.jobId);
    expect(listAudit(deps.db, TASK, 100).filter((audit) => audit.tool === "grande_job_cancel")).toHaveLength(1);
    release!(); await awaitAllJobsSettled(2000);
    const before = getJob(deps.db, started.jobId);
    expect(await cancel(started.jobId)).toMatchObject({ state: "cancelled", requested: false });
    expect(getJob(deps.db, started.jobId)).toEqual(before);
  });

  it("natural completion wins over a later cancellation request", async () => {
    const started = launch();
    expect(signal).toBeInstanceOf(AbortSignal);
    release!(); await awaitAllJobsSettled(2000);
    expect(await cancel(started.jobId)).toMatchObject({ state: "passed", requested: false });
    expect(signal!.aborted).toBe(false);
    expect(listAudit(deps.db, TASK, 100).filter((audit) => audit.tool === "grande_job_cancel")).toHaveLength(0);
  });
});
