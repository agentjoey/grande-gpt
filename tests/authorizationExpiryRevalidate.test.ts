import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import {
  approveAuthorization,
  beginAuthorizedExecution,
  rotateAuthorizationChallenge,
} from "../src/deliveryAuthorization.ts";
import {
  prepareDeliveryAuthorization,
  revalidateDeliveryBinding,
  type DeliveryReadinessDeps,
} from "../src/deliveryReadiness.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { createTask } from "../src/tasks.ts";

const TASK = "task-expiry-revalidate";
const NOW = 1_900_000_000_000;
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const TREE = "c".repeat(40);
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

let root: string;
let db: DatabaseSync;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  root = mkdtempSync(join(tmpdir(), "auth-expiry-revalidate-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  const layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId: TASK,
    repoId: "demo",
    branch: `grande/${TASK}`,
    baseCommit: BASE,
    worktreePath: join(root, "worktree"),
    state: "READY",
  });
  saveExplicitDeliveryTarget(db, TASK, "deploy");
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(root, { recursive: true, force: true });
});

function deps(): DeliveryReadinessDeps {
  return {
    readPullRequest: async () => ({ number: 7, baseRef: "main", baseSha: BASE, headSha: HEAD, state: "open" }),
    readRequiredCi: async () => "success",
    readAttestation: () => ({ commit: HEAD, jobId: "job-att" }),
    readHostVerification: () => ({ commit: HEAD, jobId: "job-host", planDigest: DIGEST_A }),
    computeExpectedMergeTree: () => TREE,
    resolveDeployAction: () => ({
      deployTarget: "deployment-host:demo/deploy-prod",
      deployRef: "profile:deploy-prod",
      verifyRef: "profile:verify-prod",
      deploySpecDigest: DIGEST_A,
      policyDigest: DIGEST_B,
    }),
    readWorktreeState: () => ({ headSha: HEAD, clean: true, realpath: join(root, "worktree") }),
    readRuntimeIdentity: () => ({ runtimeBuild: "git:test", toolsetEpoch: 1, toolsDigest: DIGEST_C }),
  };
}

function status(authorizationId: string): string {
  return (db.prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
    .get(authorizationId) as { status: string }).status;
}

describe("revalidation expiry semantics", () => {
  it("does not apply approval expiry to EXECUTING; execution deadline remains a separate concern", async () => {
    const prepared = await prepareDeliveryAuthorization(db, TASK, deps());
    const { approvalNonce } = rotateAuthorizationChallenge(db, prepared.authorizationId, prepared.bindingDigest, NOW + 1);
    approveAuthorization(db, {
      authorizationId: prepared.authorizationId,
      bindingDigest: prepared.bindingDigest,
      approvalNonce,
      identity: { sub: "user-1", email: "user-1@example.com" },
      now: NOW + 2,
    });
    beginAuthorizedExecution(db, prepared.authorizationId, "delivery", prepared.bindingDigest, NOW + 3);
    vi.setSystemTime(prepared.expiresAt);

    const durable = await revalidateDeliveryBinding(db, prepared.authorizationId, deps());

    expect(durable.headSha).toBe(HEAD);
    expect(status(prepared.authorizationId)).toBe("EXECUTING");
    expect(listAudit(db, TASK, 20).filter((row) => row.tool === "grande_delivery_revalidate"))
      .toHaveLength(0);
  });
});
