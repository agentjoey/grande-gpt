import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { computeOuterTestPlanDigest } from "../src/outerTestReceipt.ts";
import { loadDepDirs } from "../src/profiles.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let db: ReturnType<typeof openDb>;
let oldWorkspace: string | undefined;
let oldControl: string | undefined;

async function soakModule(): Promise<Record<string, any>> {
  try {
    return await import("../src/hostVerifierSoak.ts");
  } catch {
    return {};
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-verifier-soak-unit-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  const worktree = join(root, "task-worktree");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  oldWorkspace = process.env.GRANDE_WORKSPACE;
  oldControl = process.env.GRANDE_CONTROL;
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  const layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId: "task_soak",
    repoId: "grande-gpt",
    branch: "grande/soak",
    baseCommit: "a".repeat(40),
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  if (oldWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = oldWorkspace;
  if (oldControl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = oldControl;
  rmSync(root, { recursive: true, force: true });
});

function completeAutoRun(index: number, mode: "auto" | "manual" = "auto") {
  const jobId = `job_soak_${index}`;
  const files = ["tests/host/server-auto.host.test.ts", "tests/host/git-hook.host.test.ts"];
  const resourceLimits = { wallTimeoutMs: 120_000, maxRssMb: 1536, maxOutputBytes: 256 * 1024 };
  const loopbackPorts = [41_000 + index];
  const policyVersion = 2;
  const commit = "b".repeat(40);
  const planDigest = computeOuterTestPlanDigest({
    level: "full",
    files,
    policyVersion,
    resourceLimits,
    loopbackPorts,
  });
  const started = Date.now() + index * 10;
  createJob(db, {
    jobId,
    taskId: "task_soak",
    profile: "host-verifier",
    argv: ["trusted-host-verifier", "full", commit],
    pgid: null,
  });
  finishJob(db, jobId, {
    state: "passed",
    exitCode: 0,
    artifactPath: null,
    summary: {
      kind: "host-verifier-v2",
      mode,
      repoId: "grande-gpt",
      commit,
      level: "full",
      files,
      policyVersion,
      resourceLimits,
      loopbackPorts,
      hostToolchain: { node: "v24", pnpm: "10", lockfileSha256: "c".repeat(64) },
    },
  });
  db.prepare(
    `INSERT INTO outer_test_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)
     ON CONFLICT(taskId) DO UPDATE SET receiptJson=excluded.receiptJson, updatedAt=excluded.updatedAt`,
  ).run("task_soak", JSON.stringify({
    version: 2,
    mode,
    taskId: "task_soak",
    repoId: "grande-gpt",
    commit,
    level: "full",
    profile: "host-verifier",
    files,
    planDigest,
    jobId,
    startedAt: started,
    endedAt: started + 5,
    hostToolchain: { node: "v24", pnpm: "10", lockfileSha256: "c".repeat(64) },
  }), started + 5);
  return { jobId, planDigest };
}

describe("20-run Host Verifier soak orchestration", () => {
  it("copies only trusted production depDirs into the isolated soak control plane", async () => {
    const mod = await soakModule();
    expect(typeof mod.copyTrustedSoakDepDirs).toBe("function");
    if (typeof mod.copyTrustedSoakDepDirs !== "function") return;

    const sourceControl = join(root, "trusted-control");
    const targetControl = join(root, "soak-control");
    mkdirSync(sourceControl, { recursive: true });
    mkdirSync(targetControl, { recursive: true });

    process.env.GRANDE_CONTROL = sourceControl;
    const sourceLayout = loadLayout();
    ensureLayout(sourceLayout);
    writeFileSync(join(sourceLayout.configDir, "profiles.yaml"), [
      "repos:",
      "  grande-gpt:",
      "    unit-selfhost:",
      "      argv: [pnpm, vitest, run]",
      "      timeoutSeconds: 60",
      "depDirs:",
      "  grande-gpt:",
      "    - node_modules",
      "",
    ].join("\n"), "utf8");

    process.env.GRANDE_CONTROL = targetControl;
    const targetLayout = loadLayout();
    ensureLayout(targetLayout);

    expect(mod.copyTrustedSoakDepDirs(sourceLayout, targetLayout, "grande-gpt")).toEqual(["node_modules"]);
    expect(loadDepDirs(targetLayout, "grande-gpt")).toEqual(["node_modules"]);
  });

  it("requires unique sequential auto V2 runs and probes Gateway throughout", async () => {
    const mod = await soakModule();
    expect(typeof mod.runSequentialHostVerifierSoak).toBe("function");
    if (typeof mod.runSequentialHostVerifierSoak !== "function") return;

    let launches = 0;
    let probes = 0;
    const staticPlanDigest = "sha256:" + "d".repeat(64);
    const coordinator = {
      start() {
        launches += 1;
        const { jobId } = completeAutoRun(launches);
        return { state: "running", jobId, coalesced: false, staticPlanDigest };
      },
    };
    const summary = await mod.runSequentialHostVerifierSoak({
      db,
      coordinator,
      request: { taskId: "task_soak", repoId: "grande-gpt", commit: "b".repeat(40), level: "full" },
      runs: 3,
      sentinel: "SOAK_SECRET_SENTINEL",
      probeGateway: async () => { probes += 1; },
      pollIntervalMs: 1,
    });

    expect(summary).toMatchObject({ runs: 3, passed: 3, mode: "auto", level: "full", commit: "b".repeat(40) });
    expect(summary.jobIds).toEqual(["job_soak_1", "job_soak_2", "job_soak_3"]);
    expect(summary.staticPlanDigest).toBe(staticPlanDigest);
    expect(launches).toBe(3);
    expect(probes).toBeGreaterThanOrEqual(6);
  });

  it("fails closed if any soak receipt is not auto V2 for the exact job", async () => {
    const mod = await soakModule();
    expect(typeof mod.runSequentialHostVerifierSoak).toBe("function");
    if (typeof mod.runSequentialHostVerifierSoak !== "function") return;

    const coordinator = {
      start() {
        const { jobId } = completeAutoRun(1, "manual");
        return { state: "running", jobId, coalesced: false, staticPlanDigest: "sha256:" + "e".repeat(64) };
      },
    };
    await expect(mod.runSequentialHostVerifierSoak({
      db,
      coordinator,
      request: { taskId: "task_soak", repoId: "grande-gpt", commit: "b".repeat(40), level: "full" },
      runs: 1,
      sentinel: "SOAK_SECRET_SENTINEL",
      probeGateway: async () => {},
      pollIntervalMs: 1,
    })).rejects.toThrow(/auto|receipt/i);
  });
});
