import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { CurrentHostVerification } from "../src/prHostVerification.ts";
import { projectHostVerificationProgress, projectTaskProgress } from "../src/taskProgress.ts";
import { createTask } from "../src/tasks.ts";

function current(overrides: Partial<CurrentHostVerification> = {}): CurrentHostVerification {
  return {
    plan: {
      level: "full",
      autoFiles: ["tests/host/git-hook.host.test.ts"],
      manualOnlyFiles: [],
      manualOnlyRequired: false,
      changedFiles: ["src/example.ts"],
      head: "head1",
    },
    receiptEligible: false,
    latestAttempt: null,
    integrityFailure: null,
    ...overrides,
  };
}

describe("D3 host verification status semantics", () => {
  it("projects running, failed, retryable, retry-exhausted, passed, and manual-required distinctly", () => {
    expect(projectHostVerificationProgress(current({
      latestAttempt: { jobId: "job-running", state: "running", kind: "running", infrastructureFailures: 0, artifactPath: null, artifactExcerpt: null },
    }), "auto")).toMatchObject({ state: "running", requiredLevel: "full", jobId: "job-running", retryCount: 0 });

    expect(projectHostVerificationProgress(current({
      latestAttempt: { jobId: "job-test", state: "failed", kind: "test", infrastructureFailures: 0, artifactPath: null, artifactExcerpt: null },
    }), "auto")).toMatchObject({ state: "failed", jobId: "job-test", retryCount: 0 });

    expect(projectHostVerificationProgress(current({
      latestAttempt: { jobId: "job-infra-1", state: "failed", kind: "infrastructure", infrastructureFailures: 1, artifactPath: null, artifactExcerpt: null },
    }), "auto")).toMatchObject({ state: "retryable-failure", jobId: "job-infra-1", retryCount: 1 });

    expect(projectHostVerificationProgress(current({
      latestAttempt: { jobId: "job-infra-2", state: "failed", kind: "infrastructure", infrastructureFailures: 2, artifactPath: null, artifactExcerpt: null },
    }), "auto")).toMatchObject({ state: "retry-exhausted", jobId: "job-infra-2", retryCount: 2 });

    expect(projectHostVerificationProgress(current({ receiptEligible: true }), "auto")).toMatchObject({
      state: "passed", receiptEligible: true, requiredLevel: "full",
    });
    expect(projectHostVerificationProgress(current(), "manual")).toMatchObject({ state: "manual-required" });
  });

  it("projects integrity failure as zero-retry blocked state with explicit reason", () => {
    const projected = projectHostVerificationProgress(current({
      integrityFailure: {
        failureClass: "integrity",
        reason: "receipt_result_binding_mismatch",
        jobId: "job-integrity",
      },
    }), "auto");

    expect(projected).toMatchObject({
      state: "integrity-failure",
      failureClass: "integrity",
      failureReason: "receipt_result_binding_mismatch",
      jobId: "job-integrity",
      retryCount: 0,
      receiptEligible: false,
    });
  });
});

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "d3-progress-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "d3-progress-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  ensureLayout(loadLayout());
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

function addAttestation(db: ReturnType<typeof openDb>): void {
  db.prepare(`INSERT INTO job (jobId,taskId,profile,argv,state,pgid,exitCode,startedAt,endedAt,artifactPath,summary,workspaceDigest,hostToolchain)
    VALUES ('job-pass','task-d3','typecheck','[]','passed',NULL,0,1,2,NULL,NULL,'digest',?)`)
    .run(JSON.stringify({ node: "v24", pnpm: "10", lockfileSha256: "abc" }));
  db.prepare(`INSERT INTO attestation (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
    VALUES ('att-pass','task-d3','head1','typecheck','job-pass',0,1,2,?)`)
    .run(JSON.stringify({ node: "v24", pnpm: "10", lockfileSha256: "abc" }));
}

function succeeded(db: ReturnType<typeof openDb>, tool: string): void {
  const audit = beginAudit(db, { taskId: "task-d3", tool, input: {} });
  audit.allowed(); audit.executing(); audit.succeeded();
}

function staleReconcile(db: ReturnType<typeof openDb>): void {
  const audit = beginAudit(db, { taskId: "task-d3", tool: "grande_pr_merge", input: { phase: "post_merge_reconcile" } });
  audit.allowed(); audit.executing(); audit.failed("merged-but-local-stale: canonical refresh failed");
}

function makeTask(db: ReturnType<typeof openDb>, state: "READY" | "CLOSED" = "READY") {
  return createTask(db, {
    taskId: "task-d3", repoId: "grande-gpt", branch: "grande/d3-0001", baseCommit: "base", worktreePath: join(ws, "wt"), state,
  });
}

const progressOptions = {
  readHead: () => "head1",
  filesChanged: () => 2,
  workingTreeDirty: () => false,
  deployConfigured: () => false,
};

describe("D3 task progress projection", () => {
  it("projects exact HEAD, verifier retry exhaustion, blocker, and one unique Human next action", () => {
    const db = openDb(loadLayout());
    const task = makeTask(db);
    addAttestation(db);
    succeeded(db, "grande_pr_open");
    const progress = projectTaskProgress(db, task, {
      ...progressOptions,
      worktreeExists: () => true,
      hostVerificationMode: "auto",
      inspectHostVerification: () => current({ latestAttempt: { jobId: "job-infra-2", state: "failed", kind: "infrastructure", infrastructureFailures: 2, artifactPath: null, artifactExcerpt: null } }),
    });
    expect(progress).toMatchObject({
      phase: "host-verification",
      taskHead: "head1",
      hostVerification: { state: "retry-exhausted", requiredLevel: "full", retryCount: 2, jobId: "job-infra-2" },
    });
    expect(progress.blocker).toBe("hostVerification: verifier infrastructure retry exhausted (2/2)");
    expect(progress.nextAction).toBe("运行 grande outer-test --task task-d3 --run；不要自动重试 verifier");
    db.close();
  });

  it("projects integrity failure as Human blocker and never recommends automatic retry", () => {
    const db = openDb(loadLayout());
    const task = makeTask(db);
    addAttestation(db);
    succeeded(db, "grande_pr_open");
    const progress = projectTaskProgress(db, task, {
      ...progressOptions,
      worktreeExists: () => true,
      hostVerificationMode: "auto",
      inspectHostVerification: () => current({
        integrityFailure: {
          failureClass: "integrity",
          reason: "verifier_identity_mismatch",
          jobId: "job-integrity",
        },
      }),
    });

    expect(progress).toMatchObject({
      phase: "host-verification",
      hostVerification: {
        state: "integrity-failure",
        failureClass: "integrity",
        failureReason: "verifier_identity_mismatch",
        retryCount: 0,
        jobId: "job-integrity",
      },
    });
    expect(progress.blocker).toBe("hostVerification: integrity failure (verifier_identity_mismatch)");
    expect(progress.nextAction).toBe("停止自动重试；由 Human 检查 verifier/receipt/SHA/policy identity 后再继续");
    db.close();
  });

  it("projects remote-merged/local-stale truth and reconciliation as the only next action", () => {
    const db = openDb(loadLayout());
    const task = makeTask(db);
    addAttestation(db);
    succeeded(db, "grande_pr_open");
    succeeded(db, "grande_pr_merge");
    staleReconcile(db);
    const progress = projectTaskProgress(db, task, {
      ...progressOptions,
      worktreeExists: () => true,
      inspectHostVerification: () => current({ receiptEligible: true }),
    });
    expect(progress).toMatchObject({ phase: "cleanup", localState: "merged-local-stale", completed: true, cleanupRequired: true });
    expect(progress.blocker).toBe("cleanup: remote merged but local reconciliation is stale");
    expect(progress.nextAction).toBe("再次调用 grande_pr_merge；只重试本地 reconciliation，不会重复 remote merge");
    db.close();
  });

  it("projects a fully merged and cleaned task as completed with no invented action", () => {
    const db = openDb(loadLayout());
    const task = makeTask(db, "CLOSED");
    addAttestation(db);
    succeeded(db, "grande_pr_open");
    succeeded(db, "grande_pr_merge");
    const progress = projectTaskProgress(db, task, {
      ...progressOptions,
      worktreeExists: () => false,
      inspectHostVerification: () => current({ receiptEligible: true }),
    });
    expect(progress).toMatchObject({
      phase: "completed",
      localState: "completed",
      completed: true,
      cleanupRequired: false,
      blocker: null,
      nextAction: "无待处理动作",
    });
    db.close();
  });
});
