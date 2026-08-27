import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import {
  captureDependencyBootstrapIdentity,
  DependencyBootstrapFailure,
  DependencyBootstrapIdentityDrift,
  prepareDependenciesInWorktree,
  publishPreparedDependencies,
} from "../src/dependencyBootstrap.ts";
import type { RunResult } from "../src/sandbox.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createJob, finishJob, getJob, listJobs, setRunningJobSummary, TERMINAL } from "../src/jobs.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";
import { buildTools as buildCoreTools } from "../src/toolsCore.ts";
import { awaitAllJobsSettled } from "../src/runner.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps | undefined;
let worktree: string;
let savedWorkspace: string | undefined;
let savedControl: string | undefined;
let sandboxRunnerCalls: number;

function sandboxResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    killedBy: null,
    killSignalSkipped: false,
    durationMs: 1,
    peakRssMb: 0,
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitTerminal(jobId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!TERMINAL.has(getJob(deps!.db, jobId)!.state)) {
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function bootstrapFailureContext(jobId: string): string {
  const job = getJob(deps!.db, jobId);
  if (!job) return `missing bootstrap job ${jobId}`;
  const artifact = job.artifactPath && existsSync(job.artifactPath)
    ? readFileSync(job.artifactPath, "utf8")
    : "<no bootstrap artifact>";
  return `bootstrap job ${jobId}: ${JSON.stringify(job, null, 2)}\n${artifact}`;
}

async function callRun(profile = "ok"): Promise<any> {
  const tool = buildTools(deps!).find((candidate) => candidate.name === "grande_run")!;
  const response = await tool.handler({ taskId: "task_bootstrap", profile });
  return response.structuredContent as any;
}

async function callResult(jobId: string): Promise<any> {
  const tool = buildTools(deps!).find((candidate) => candidate.name === "grande_run_result")!;
  const response = await tool.handler({ jobId });
  return response.structuredContent as any;
}

async function callCoreRun(profile = "ok"): Promise<any> {
  const tool = buildCoreTools(deps!).find((candidate) => candidate.name === "grande_run")!;
  const response = await tool.handler({ taskId: "task_bootstrap", profile });
  return response.structuredContent as any;
}

beforeEach(() => {
  sandboxRunnerCalls = 0;
  savedWorkspace = process.env.GRANDE_WORKSPACE;
  savedControl = process.env.GRANDE_CONTROL;
  root = mkdtempSync(join(tmpdir(), "dependency-bootstrap-tools-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);

  const canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "config", "user.email", "bootstrap@example.invalid");
  git(canonical, "config", "user.name", "Bootstrap Test");
  writeFileSync(join(canonical, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }) + "\n", "utf8");
  writeFileSync(
    join(canonical, "package-lock.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "demo", version: "1.0.0" } },
    }, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(join(canonical, "a.txt"), "tracked\n", "utf8");
  git(canonical, "add", ".");
  git(canonical, "commit", "-q", "-m", "fixture");

  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "depDirs:\n  demo: [\"node_modules\"]\nrepos:\n  demo:\n" +
      '    ok: { argv: ["/bin/sh", "-c", "test -d node_modules && echo product-profile"], timeoutSeconds: 30 }\n',
    "utf8",
  );

  worktree = join(layout.worktreesRoot, "demo", "task_bootstrap");
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/bootstrap", worktree, git(canonical, "rev-parse", "HEAD"));

  const db = openDb(layout);
  createTask(db, {
    taskId: "task_bootstrap",
    repoId: "demo",
    branch: "grande/bootstrap",
    baseCommit: git(canonical, "rev-parse", "HEAD"),
    worktreePath: worktree,
    state: "READY",
  });
  deps = {
    db,
    layout,
    dependencyBootstrapSandboxRunner: async (options) => {
      sandboxRunnerCalls += 1;
      options.onSpawn?.(12_345);
      return sandboxResult();
    },
    jobSandboxRunner: async (options) => {
      options.onSpawn?.(23_456);
      return sandboxResult({ stdout: "product-profile\n" });
    },
  };
});

afterEach(() => {
  deps?.db.close();
  deps = undefined;
  rmSync(root, { recursive: true, force: true });
  if (savedWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = savedWorkspace;
  if (savedControl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = savedControl;
});

describe("GG-BL-031 grande_run dependency prerequisite", () => {
  it("returns a dependency-bootstrap job on a fresh cache miss, then runs the requested product profile after bootstrap", async () => {
    const first = await callRun();
    expect(first.ok).toBe(true);
    expect(first.data.jobId).toMatch(/^job_/);
    const bootstrapJob = getJob(deps!.db, first.data.jobId)!;
    expect(bootstrapJob.profile).toBe("dependency-bootstrap");
    expect(bootstrapJob.argv).toEqual(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);

    await waitTerminal(first.data.jobId);
    expect(sandboxRunnerCalls).toBe(1);
    expect(getJob(deps!.db, first.data.jobId), bootstrapFailureContext(first.data.jobId)).toMatchObject({
      state: "passed",
      summary: {
        kind: "dependency-bootstrap",
        repoId: "demo",
        packageManager: "npm",
      },
    });

    const second = await callRun();
    expect(second.ok).toBe(true);
    const productJob = getJob(deps!.db, second.data.jobId)!;
    expect(productJob.profile).toBe("ok");
    await waitTerminal(second.data.jobId);
    expect(getJob(deps!.db, second.data.jobId)?.state).toBe("passed");
  }, 30_000);

  it("validates the requested profile before bootstrap causes filesystem, cache, job, or network side effects", async () => {
    const result = await callRun("missing");
    if (result.ok && result.data?.jobId) await waitTerminal(result.data.jobId);

    expect(result).toMatchObject({ ok: false, error: { code: "PROFILE_NOT_FOUND" } });
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(join(layout.derivedRoot, "dependency-cache"))).toBe(false);
    expect(listJobs(deps!.db, "task_bootstrap")).toEqual([]);
  });

  it("projects dependency-bootstrap failure classification through grande_run_result", async () => {
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: { missing: "1.0.0" } }) + "\n",
      "utf8",
    );
    deps!.dependencyBootstrapSandboxRunner = async (options) => {
      options.onSpawn?.(12_345);
      return sandboxResult({ exitCode: 1, stderr: "fixture install failure" });
    };

    const started = await callCoreRun();
    expect(started.ok).toBe(true);
    await waitTerminal(started.data.jobId);
    const result = await callResult(started.data.jobId);

    expect(result).toMatchObject({
      ok: true,
      data: {
        state: "failed",
        profile: "dependency-bootstrap",
        kind: "dependency-bootstrap",
        failureClass: "dependency-bootstrap",
        reason: "install_failed",
        requestedProfile: "ok",
      },
    });
  }, 30_000);

  it("registers dependency bootstrap with the shared job settlement lifecycle", async () => {
    const started = await callCoreRun();
    expect(started.ok).toBe(true);

    const waited = await awaitAllJobsSettled(10_000);
    if (!TERMINAL.has(getJob(deps!.db, started.data.jobId)!.state)) await waitTerminal(started.data.jobId);

    expect(waited).toBeGreaterThanOrEqual(1);
    expect(getJob(deps!.db, started.data.jobId)?.state, bootstrapFailureContext(started.data.jobId)).toBe("passed");
  }, 30_000);

  it("settles successfully when the optional bootstrap artifact cannot be written", async () => {
    rmSync(layout.artifactsDir, { recursive: true, force: true });
    writeFileSync(layout.artifactsDir, "artifact path intentionally blocked\n", "utf8");

    const started = await callCoreRun();
    expect(started.ok).toBe(true);
    expect(await awaitAllJobsSettled(10_000)).toBeGreaterThanOrEqual(1);

    expect(getJob(deps!.db, started.data.jobId), bootstrapFailureContext(started.data.jobId)).toMatchObject({
      state: "passed",
      artifactPath: null,
      summary: { kind: "dependency-bootstrap", phase: "ready" },
    });
  }, 30_000);

  it("does not start the product profile while a matching bootstrap is still terminalizing", async () => {
    const identity = captureDependencyBootstrapIdentity("demo", worktree);
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    publishPreparedDependencies(layout, identity, worktree);
    createJob(deps!.db, {
      jobId: "job_matching_bootstrap",
      taskId: "task_bootstrap",
      profile: "dependency-bootstrap",
      argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      pgid: null,
    });
    setRunningJobSummary(deps!.db, "job_matching_bootstrap", {
      kind: "dependency-bootstrap",
      dependencyIdentityKey: identity.key,
    });

    const result = await callCoreRun();
    finishJob(deps!.db, "job_matching_bootstrap", {
      state: "cancelled", exitCode: null, artifactPath: null, summary: null,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { jobId: "job_matching_bootstrap", state: "running", reused: true },
    });
    expect(listJobs(deps!.db, "task_bootstrap")).toHaveLength(1);
  }, 15_000);

  it("does not reuse or overlap a running bootstrap captured for a stale dependency identity", async () => {
    const before = captureDependencyBootstrapIdentity("demo", worktree);
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    publishPreparedDependencies(layout, before, worktree);
    rmSync(join(worktree, "node_modules"), { recursive: true, force: true });
    createJob(deps!.db, {
      jobId: "job_stale_bootstrap",
      taskId: "task_bootstrap",
      profile: "dependency-bootstrap",
      argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      pgid: null,
    });
    setRunningJobSummary(deps!.db, "job_stale_bootstrap", {
      kind: "dependency-bootstrap",
      dependencyIdentityKey: before.key,
    });
    const lock = JSON.parse(readFileSync(join(worktree, "package-lock.json"), "utf8"));
    writeFileSync(join(worktree, "package-lock.json"), JSON.stringify({ ...lock, drift: true }, null, 2) + "\n", "utf8");

    const result = await callCoreRun();
    finishJob(deps!.db, "job_stale_bootstrap", {
      state: "cancelled", exitCode: null, artifactPath: null, summary: null,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", retryable: true } });
    expect(listJobs(deps!.db, "task_bootstrap")).toHaveLength(1);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  }, 15_000);

  it("discards a successful install when the lockfile identity drifts before cache publication", async () => {
    const lockfile = join(worktree, "package-lock.json");
    const original = JSON.parse(readFileSync(lockfile, "utf8"));

    let failure: unknown;
    try {
      await prepareDependenciesInWorktree({
        layout,
        repoId: "demo",
        worktreePath: worktree,
        jobTmp: join(root, "identity-drift-job"),
        onSpawn: () => {
          writeFileSync(lockfile, JSON.stringify({ ...original, drift: true }, null, 2) + "\n", "utf8");
        },
        sandboxRunner: async (options) => {
          options.onSpawn?.(12_345);
          return sandboxResult();
        },
      });
    } catch (error) {
      failure = error;
    }
    const failureContext = failure instanceof DependencyBootstrapFailure
      ? JSON.stringify(failure.result, null, 2)
      : String(failure);
    expect(failure, failureContext).toBeInstanceOf(DependencyBootstrapIdentityDrift);

    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(join(layout.derivedRoot, "dependency-cache"))).toBe(false);
  }, 30_000);
});
