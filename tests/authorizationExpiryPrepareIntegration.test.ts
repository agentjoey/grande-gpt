import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { prepareDeliveryAuthorization, type DeliveryReadinessDeps } from "../src/deliveryReadiness.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { createTask } from "../src/tasks.ts";

const TASK = "task-expiry-prepare";
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
  root = mkdtempSync(join(tmpdir(), "auth-expiry-prepare-"));
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

describe("prepare after authorization expiry", () => {
  it("expires the old READY authorization at expiresAt and immediately creates a new proposal", async () => {
    const first = await prepareDeliveryAuthorization(db, TASK, deps());
    vi.setSystemTime(first.expiresAt);

    const second = await prepareDeliveryAuthorization(db, TASK, deps());

    expect(second.authorizationId).not.toBe(first.authorizationId);
    const rows = db.prepare(
      "SELECT authorizationId,status FROM delivery_authorization WHERE taskId=? ORDER BY createdAt ASC, rowid ASC",
    ).all(TASK) as unknown as Array<{ authorizationId: string; status: string }>;
    expect(rows).toEqual([
      { authorizationId: first.authorizationId, status: "EXPIRED" },
      { authorizationId: second.authorizationId, status: "READY" },
    ]);
    const audits = listAudit(db, TASK, 20);
    expect(audits.filter((row) => row.tool === "grande_authorization_expiry_reconcile" && row.state === "SUCCEEDED"))
      .toHaveLength(1);
    expect(audits.filter((row) => row.tool === "grande_delivery_prepare" && row.state === "SUCCEEDED"))
      .toHaveLength(2);
  });
});
