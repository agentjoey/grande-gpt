import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { APPROVAL_TTL_MS, createAuthorization } from "../src/deliveryAuthorization.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { projectTaskProgress } from "../src/taskProgress.ts";
import { recordTaskPrMerged } from "../src/taskPrReceipt.ts";
import { createTask, getTask } from "../src/tasks.ts";

const TASK = "task_persisted_delivery";
const HEAD = "1".repeat(40);
let root: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "persisted-delivery-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  const layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  createTask(db, { taskId: TASK, repoId: "demo", branch: "grande/persisted-delivery",
    baseCommit: "2".repeat(40), worktreePath: join(root, "worktree"), state: "READY" });
  recordTaskPrMerged(db, { taskId: TASK, prNumber: 54, prUrl: "https://github.com/example/demo/pull/54",
    headSha: HEAD, baseRef: "main", baseSha: "2".repeat(40), mergeSha: "3".repeat(40) });
});

afterEach(() => {
  db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

function project() {
  // Isolate persisted delivery semantics from I/O, covered separately by real-default tests.
  return projectTaskProgress(db, getTask(db, TASK)!, {
    readHead: () => HEAD, filesChanged: () => 1, workingTreeDirty: () => false,
    worktreeExists: () => true, deployConfigured: () => false,
  });
}

describe("persisted delivery evidence survives missing deploy config", () => {
  it.each([JSON.stringify({ verifyComplete: false }), "{broken", JSON.stringify({ verifyComplete: true })])(
    "does not infer cleanup safety from an absent spec: %s", (receiptJson) => {
      db.prepare("INSERT INTO deployment_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)")
        .run(TASK, receiptJson, Date.now());
      expect(project().cleanupEligibility?.eligible).toBe(false);
    },
  );

  it("does not ignore a durable uncertain authorization on a legacy task", () => {
    const createdAt = Date.now();
    const auth = createAuthorization(db, { kind: "delivery", taskId: TASK, binding: {
      authorizationKind: "delivery", taskId: TASK, repoId: "demo", worktreeRealpath: join(root, "worktree"),
      deliveryTarget: "deploy", deployTarget: "prod", deploySpecDigest: `sha256:${"1".repeat(64)}`,
      policyDigest: `sha256:${"2".repeat(64)}`, runtimeBuild: "fixture", toolsetEpoch: 3,
      toolsDigest: `sha256:${"3".repeat(64)}`, createdAt, expiresAt: createdAt + APPROVAL_TTL_MS,
      prNumber: 54, baseRef: "main", baseSha: "2".repeat(40), headSha: HEAD, mergeMethod: "merge",
      expectedMergeTree: "4".repeat(40), deployRef: "profile:deploy", verifyRef: "profile:verify",
    }, stages: {}, now: createdAt });
    db.prepare("UPDATE delivery_authorization SET status='UNCERTAIN' WHERE authorizationId=?").run(auth.authorizationId);
    expect(project().cleanupEligibility?.eligible).toBe(false);
  });
});
