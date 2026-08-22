import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { buildHostVerifierStaticPlan } from "../src/hostVerifier.ts";
import { createJob, finishJob, getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import {
  computeOuterTestPlanDigest,
  getOuterTestReceipt,
  persistTrustedOuterTestPassV2,
  type HostVerifierResourceLimits,
  type OuterTestReceiptV2,
} from "../src/outerTestReceipt.ts";
import { inspectCurrentHostVerification } from "../src/prHostVerification.ts";
import { createTask, getTask } from "../src/tasks.ts";

let root: string;
let db: ReturnType<typeof openDb>;
let taskId: string;
let worktree: string;
let head: string;

interface TamperSummary extends Record<string, unknown> {
  files: string[];
  policyVersion: number;
  resourceLimits: HostVerifierResourceLimits;
  loopbackPorts: number[];
}

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-host-verification-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  const layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);

  taskId = "task_receipt_tamper";
  worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "-q", "-b", "grande/receipt-tamper");
  git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "--allow-empty", "-q", "-m", "base");
  const base = git(worktree, "rev-parse", "HEAD");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "feature.ts"), "export const x = 1;\n", "utf8");
  git(worktree, "add", "src/feature.ts");
  git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "feature");
  head = git(worktree, "rev-parse", "HEAD");
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch: "grande/receipt-tamper",
    baseCommit: base,
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function writeReceipt(): { jobId: string; receipt: OuterTestReceiptV2 } {
  const plan = buildHostVerifierStaticPlan("smoke");
  const jobId = "job_receipt_tamper";
  createJob(db, { jobId, taskId, profile: "host-verifier", argv: ["trusted-host-verifier"], pgid: 9876 });
  finishJob(db, jobId, {
    state: "passed",
    exitCode: 0,
    artifactPath: null,
    summary: {
      kind: "host-verifier-v2",
      mode: "auto",
      repoId: "grande-gpt",
      commit: head,
      level: "smoke",
      files: plan.files,
      policyVersion: plan.policyVersion,
      resourceLimits: plan.resourceLimits,
      loopbackPorts: [49173],
      hostToolchain: { node: "v24.14.0", pnpm: "10.33.0", lockfileSha256: "c".repeat(64) },
    },
  });
  persistTrustedOuterTestPassV2(db, taskId, jobId);
  return { jobId, receipt: getOuterTestReceipt(db, taskId) as OuterTestReceiptV2 };
}

function persistReceipt(receipt: OuterTestReceiptV2): void {
  db.prepare("UPDATE outer_test_receipt SET receiptJson=?, updatedAt=? WHERE taskId=?")
    .run(JSON.stringify(receipt), Date.now(), taskId);
}

function inspection(commit = head) {
  const task = getTask(db, taskId)!;
  return inspectCurrentHostVerification(db, task, commit);
}

function eligible(): boolean {
  return inspection().receiptEligible;
}

describe("C3 V2 receipt tamper resistance", () => {
  it("accepts the untouched trusted terminal job receipt", () => {
    writeReceipt();
    expect(eligible()).toBe(true);
    expect(inspection().integrityFailure).toBeNull();
  });

  it("classifies a current-SHA receipt whose jobId no longer binds as integrity failure", () => {
    const { receipt } = writeReceipt();
    persistReceipt({ ...receipt, jobId: "job_missing" });
    const current = inspection();
    expect(current.receiptEligible).toBe(false);
    expect(current.integrityFailure).toMatchObject({
      failureClass: "integrity",
      reason: "receipt_result_binding_mismatch",
    });
  });

  it("classifies final planDigest tampering as integrity failure when SHA still matches", () => {
    const { receipt } = writeReceipt();
    persistReceipt({ ...receipt, planDigest: `sha256:${"0".repeat(64)}` });
    const current = inspection();
    expect(current.receiptEligible).toBe(false);
    expect(current.integrityFailure).toMatchObject({
      failureClass: "integrity",
      reason: "receipt_result_binding_mismatch",
    });
  });

  it("classifies a trusted-job summary that includes the production loopback port as policy integrity failure", () => {
    const { jobId, receipt } = writeReceipt();
    const job = getJob(db, jobId)!;
    const original = job.summary as TamperSummary;
    const summary: TamperSummary = { ...original, loopbackPorts: [8787] };
    db.prepare("UPDATE job SET summary=? WHERE jobId=?").run(JSON.stringify(summary), jobId);
    const digest = computeOuterTestPlanDigest({
      level: "smoke",
      files: summary.files,
      policyVersion: summary.policyVersion,
      resourceLimits: summary.resourceLimits,
      loopbackPorts: summary.loopbackPorts,
    });
    persistReceipt({ ...receipt, planDigest: digest });
    const current = inspection();
    expect(current.receiptEligible).toBe(false);
    expect(current.integrityFailure).toMatchObject({ failureClass: "integrity", reason: "policy_rejection" });
  });

  it("classifies policy-version drift as verifier identity integrity failure", () => {
    const { jobId, receipt } = writeReceipt();
    const job = getJob(db, jobId)!;
    const original = job.summary as TamperSummary;
    const summary: TamperSummary = { ...original, policyVersion: original.policyVersion + 1 };
    db.prepare("UPDATE job SET summary=? WHERE jobId=?").run(JSON.stringify(summary), jobId);
    const digest = computeOuterTestPlanDigest({
      level: "smoke",
      files: summary.files,
      policyVersion: summary.policyVersion,
      resourceLimits: summary.resourceLimits,
      loopbackPorts: summary.loopbackPorts,
    });
    persistReceipt({ ...receipt, planDigest: digest });
    const current = inspection();
    expect(current.receiptEligible).toBe(false);
    expect(current.integrityFailure).toMatchObject({ failureClass: "integrity", reason: "verifier_identity_mismatch" });
  });

  it("does not reuse or escalate an old-SHA receipt after the candidate SHA changes", () => {
    writeReceipt();
    writeFileSync(join(worktree, "src", "feature.ts"), "export const x = 2;\n", "utf8");
    git(worktree, "add", "src/feature.ts");
    git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "next sha");
    const newHead = git(worktree, "rev-parse", "HEAD");

    const current = inspection(newHead);
    expect(current.receiptEligible).toBe(false);
    expect(current.latestAttempt).toBeNull();
    expect(current.integrityFailure).toBeNull();
  });
});
