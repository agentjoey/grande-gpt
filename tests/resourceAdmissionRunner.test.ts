import { mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { createJob, getJob, listJobs } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { awaitAllJobsSettled, startJob, type RunnerDeps } from "../src/runner.ts";
import type { RunResult } from "../src/sandbox.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let deps: RunnerDeps;
let release: Array<() => void>;
const result: RunResult = { exitCode: 0, stdout: "ok", stderr: "", truncated: false,
  killedBy: null, killSignalSkipped: false, durationMs: 1, peakRssMb: 0 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-admission-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout);
  mkdirSync(join(layout.workspaceRoot, "demo", ".git"), { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n");
  writeFileSync(join(layout.configDir, "profiles.yaml"),
    'repos:\n  demo:\n    test: { argv: ["/bin/echo", "ok"], timeoutSeconds: 30 }\n');
  writeFileSync(join(layout.configDir, "resource-policy.json"), JSON.stringify({
    globalJobs: 2, perTaskJobs: 1, minFreeBytes: 1,
  }));
  deps = { db: openDb(layout), layout }; release = [];
  for (const taskId of ["task_one", "task_two", "task_three"]) {
    const worktreePath = join(layout.worktreesRoot, "demo", taskId);
    mkdirSync(worktreePath, { recursive: true });
    createTask(deps.db, { taskId, repoId: "demo", branch: `grande/${taskId}`,
      baseCommit: "1".repeat(40), worktreePath, state: "READY" });
  }
  deps.jobSandboxRunner = (options) => {
    options.onSpawn?.(2_000_000 + release.length);
    return new Promise<RunResult>((resolve) => release.push(() => resolve(result)));
  };
});

afterEach(async () => {
  for (const done of release) done();
  await awaitAllJobsSettled(2000);
  deps.db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

function launch(taskId = "task_one") {
  const audit = beginAudit(deps.db, { taskId, tool: "grande_run", input: { profile: "test" } });
  audit.allowed();
  return startJob(deps, { taskId, repoId: "demo", profileName: "test",
    worktreePath: join(layout.worktreesRoot, "demo", taskId) }, audit);
}

describe("B2-1 ordinary job admission", () => {
  it("persists the running reservation before the sandbox can spawn", async () => {
    let visibleAtSpawn = false;
    deps.jobSandboxRunner = async (options) => {
      visibleAtSpawn = listJobs(deps.db, "task_one").some((job) => job.state === "running");
      options.onSpawn?.(2_000_001);
      return result;
    };
    const job = launch();
    expect(visibleAtSpawn).toBe(true);
    await awaitAllJobsSettled(2000);
    expect(getJob(deps.db, job.jobId)?.state).toBe("passed");
  });

  it("rejects a second task-local execution before another spawn", () => {
    launch();
    expect(() => launch()).toThrow(/JOB_RUNNING|已有|capacity|准入/i);
    expect(release).toHaveLength(1);
    expect(listJobs(deps.db, "task_one")).toHaveLength(1);
  });

  it("enforces the global capacity across different tasks", () => {
    launch(); launch("task_two");
    expect(() => launch("task_three")).toThrow(/capacity|全局|准入/i);
    expect(release).toHaveLength(2);
    expect(listJobs(deps.db, "task_three")).toHaveLength(0);
  });

  it("counts a preparing bootstrap even before its pgid is assigned", () => {
    createJob(deps.db, { taskId: "task_one", jobId: "job_preparing", profile: "dependency-bootstrap", argv: [], pgid: null });
    expect(() => launch()).toThrow(/JOB_RUNNING|已有|capacity|准入/i);
    expect(release).toHaveLength(0);
  });

  it("rejects low disk before resource allocation and leaves results readable", () => {
    writeFileSync(join(layout.configDir, "resource-policy.json"), JSON.stringify({ minFreeBytes: Number.MAX_SAFE_INTEGER }));
    expect(() => launch()).toThrow(/disk|磁盘|空间/i);
    expect(release).toHaveLength(0);
    expect(listJobs(deps.db)).toHaveLength(0);
  });

  it("fails closed for malformed trusted resource policy", () => {
    writeFileSync(join(layout.configDir, "resource-policy.json"), '{"globalJobs":0}');
    expect(() => launch()).toThrow(/policy|配置|globalJobs/i);
    expect(release).toHaveLength(0);
  });

  it("releases capacity only after the job settlement has completed", async () => {
    const first = launch(); release[0]!();
    await awaitAllJobsSettled(2000);
    expect(getJob(deps.db, first.jobId)?.state).toBe("passed");
    expect(() => launch()).not.toThrow();
    expect(release).toHaveLength(2);
  });

  it("records the actual test-host free-space observation without a performance promise", () => {
    const disk = statfsSync(root, { bigint: true });
    expect(disk.bavail).toBeGreaterThan(0n);
    console.info(`[B2 baseline] fixture volume available bytes=${disk.bavail * disk.bsize}`);
  });
});
