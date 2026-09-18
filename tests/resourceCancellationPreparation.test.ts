import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { captureDependencyBootstrapIdentity, dependencyCacheDir, prepareDependenciesInWorktree } from "../src/dependencyBootstrap.ts";
import { prepareDependencyPrerequisite } from "../src/dependencyBootstrapTools.ts";
import { buildHostVerifierStaticPlan } from "../src/hostVerifier.ts";
import { createHostVerifierLauncher, type HostVerifierPreparedRun, type HostVerifierRuntimeAdapter } from "../src/hostVerifierRuntime.ts";
import { requestJobCancellation } from "../src/jobCancellation.ts";
import { getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { awaitAllJobsSettled } from "../src/runner.ts";
import type { RunOptions, RunResult } from "../src/sandbox.ts";
import { createTask, getTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
let worktree: string;
let release: (() => void) | undefined;
const TASK = "task_cancel_prepare";
const passed: RunResult = { exitCode: 0, stdout: "ok", stderr: "", truncated: false,
  killedBy: null, killSignalSkipped: false, durationMs: 0, peakRssMb: 0 };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cancel-prepare-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace")); vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  mkdirSync(join(layout.workspaceRoot, "grande-gpt", ".git"), { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: grande-gpt\n    registered: true\n");
  writeFileSync(join(layout.configDir, "resource-policy.json"), '{"minFreeBytes":1}');
  writeFileSync(join(layout.configDir, "profiles.yaml"), 'depDirs:\n  grande-gpt: ["node_modules"]\nrepos:\n  grande-gpt:\n    test: { argv: ["npm", "test"], timeoutSeconds: 30 }\n');
  worktree = join(layout.worktreesRoot, "grande-gpt", TASK); mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "package.json"), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(join(worktree, "package-lock.json"), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{}}');
  createTask(db, { taskId: TASK, repoId: "grande-gpt", branch: "grande/cancel-prepare", baseCommit: "1".repeat(40), worktreePath: worktree, state: "READY" });
  release = undefined;
});
afterEach(async () => { release?.(); await awaitAllJobsSettled(2000); db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("B2-2 preparation cancellation", () => {
  it("does not start a pre-cancelled dependency installation", async () => {
    const controller = new AbortController(); controller.abort();
    const sandboxRunner = vi.fn(async () => passed);
    const input = { layout, repoId: "grande-gpt", worktreePath: worktree, jobTmp: join(root, "job"),
      sandboxRunner, signal: controller.signal };
    await expect(prepareDependenciesInWorktree(input)).rejects.toThrow();
    expect(sandboxRunner).not.toHaveBeenCalled();
    expect(existsSync(join(root, "job"))).toBe(false);
  });

  it("accepts bootstrap cancellation but cannot publish its cache or mark it passed", async () => {
    let signal: AbortSignal | undefined;
    const prerequisite = prepareDependencyPrerequisite({ db, layout, dependencyBootstrapSandboxRunner: (options) => {
      signal = (options as RunOptions & { signal?: AbortSignal }).signal;
      options.onSpawn?.(2_000_001);
      return new Promise<RunResult>((resolve) => { release = () => resolve(passed); });
    } }, getTask(db, TASK)!, "test")!;
    const jobId = prerequisite.data.jobId as string;
    expect(signal).toBeInstanceOf(AbortSignal);
    requestJobCancellation(db, TASK, jobId);
    expect(getJob(db, jobId)?.state).toBe("running");
    release!(); await awaitAllJobsSettled(2000);
    expect(getJob(db, jobId)?.state).toBe("cancelled");
    const identity = captureDependencyBootstrapIdentity("grande-gpt", worktree);
    expect(existsSync(dependencyCacheDir(layout, identity))).toBe(false);
  });

  it("cancels verifier preparation before any test execution or success receipt", async () => {
    let signal: AbortSignal | undefined;
    const adapter: HostVerifierRuntimeAdapter = {
      prepare: async (input) => {
        signal = (input as typeof input & { signal?: AbortSignal }).signal;
        const prepared: HostVerifierPreparedRun = { disposableRoot: input.disposableRoot,
          sourceRoot: join(input.disposableRoot, "source"), jobTmp: join(input.disposableRoot, "job"),
          loopbackPorts: [], hostToolchain: { node: "v24", pnpm: "10", lockfileSha256: "lock" } };
        await new Promise<void>((resolve) => { release = resolve; });
        return prepared;
      },
      execute: vi.fn(async () => passed),
      readCurrentHeads: vi.fn(async () => ({ taskHead: "1".repeat(40), prHead: "1".repeat(40) })),
      cleanup: vi.fn(async (prepared) => { rmSync(prepared.disposableRoot, { recursive: true, force: true }); }),
    };
    const launched = createHostVerifierLauncher({ db, layout }, adapter)({ taskId: TASK,
      repoId: "grande-gpt", commit: "1".repeat(40), level: "full" }, buildHostVerifierStaticPlan("full"));
    expect(signal).toBeInstanceOf(AbortSignal);
    requestJobCancellation(db, TASK, launched.jobId);
    release!(); await launched.settled;
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapter.readCurrentHeads).not.toHaveBeenCalled();
    expect(getJob(db, launched.jobId)?.state).toBe("cancelled");
    expect(adapter.cleanup).toHaveBeenCalledTimes(1);
  });
});
