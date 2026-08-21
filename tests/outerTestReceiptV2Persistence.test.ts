import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createJob, finishJob, getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { getOuterTestReceipt, persistTrustedOuterTestPassV2 } from "../src/outerTestReceipt.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let db: ReturnType<typeof openDb>;
const taskId = "task-v2-persist";
const jobId = "job-v2-persist";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "outer-v2-persist-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  const worktree = join(root, "worktree");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  const layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch: "grande/v2-persist",
    baseCommit: "a".repeat(40),
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function trustedSummary() {
  return {
    kind: "host-verifier-v2",
    mode: "auto",
    repoId: "grande-gpt",
    commit: "a".repeat(40),
    level: "full",
    files: ["tests/host/server.host.test.ts", "tests/host/git-hook.host.test.ts"],
    policyVersion: 2,
    resourceLimits: { wallTimeoutMs: 120_000, maxRssMb: 1536, maxOutputBytes: 262_144 },
    loopbackPorts: [49174, 49173],
    hostToolchain: {
      node: "v24.14.0",
      pnpm: "10.33.0",
      lockfileSha256: "b".repeat(64),
    },
  };
}

function createPassedVerifier(summary: Record<string, unknown> = trustedSummary()) {
  createJob(db, { jobId, taskId, profile: "host-verifier", argv: ["trusted-fixed-entry"], pgid: 12345 });
  finishJob(db, jobId, { state: "passed", exitCode: 0, artifactPath: null, summary });
  return getJob(db, jobId)!;
}

describe("OuterTestReceipt V2 persistence", () => {
  it("persists V2 only by rebuilding it from a trusted passed DB job", () => {
    const job = createPassedVerifier();
    const receipt = persistTrustedOuterTestPassV2(db, taskId, jobId);
    expect(receipt).toMatchObject({
      version: 2,
      mode: "auto",
      taskId,
      repoId: "grande-gpt",
      commit: "a".repeat(40),
      level: "full",
      profile: "host-verifier",
      jobId,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    });
    expect(getOuterTestReceipt(db, taskId)).toEqual(receipt);
  });

  it("rejects running/failed verifier jobs and writes no receipt", () => {
    createJob(db, { jobId, taskId, profile: "host-verifier", argv: ["trusted-fixed-entry"], pgid: 12345 });
    expect(() => persistTrustedOuterTestPassV2(db, taskId, jobId)).toThrow(/passed|terminal|running/i);
    expect(getOuterTestReceipt(db, taskId)).toBeNull();
  });

  it("fails closed on forged/corrupt trusted summary or wrong task binding", () => {
    createPassedVerifier({ ...trustedSummary(), kind: "candidate-output" });
    expect(() => persistTrustedOuterTestPassV2(db, taskId, jobId)).toThrow(/trusted|summary|verifier/i);
    expect(() => persistTrustedOuterTestPassV2(db, "task-other", jobId)).toThrow(/task|binding|mismatch|不存在/i);
    expect(getOuterTestReceipt(db, taskId)).toBeNull();
  });
});
