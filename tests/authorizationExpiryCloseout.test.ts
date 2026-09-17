import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { reconcileExpiredAuthorizations } from "../src/authorizationExpiry.ts";
import { openDb } from "../src/db.ts";
import {
  APPROVAL_TTL_MS,
  activeAuthorizationForTask,
  approveAuthorization,
  beginAuthorizedExecution,
  createAuthorization,
  rotateAuthorizationChallenge,
  type DeliveryAuthorizationBinding,
} from "../src/deliveryAuthorization.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { startTaskLifecycleReconciler } from "../src/taskLifecycleScheduler.ts";
import { createTask } from "../src/tasks.ts";

const NOW = 1_900_000_000_000;
const TASK = "task-expiry-closeout";
let root: string;
let db: DatabaseSync;
let stateDb: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  root = mkdtempSync(join(tmpdir(), "auth-expiry-closeout-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  const layout = loadLayout();
  ensureLayout(layout);
  stateDb = layout.stateDb;
  db = openDb(layout);
  createTask(db, {
    taskId: TASK, repoId: "demo", branch: `grande/${TASK}`,
    baseCommit: "base", worktreePath: join(root, TASK), state: "READY",
  });
});

afterEach(() => {
  db.close();
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(root, { recursive: true, force: true });
});

function binding(createdAt: number): DeliveryAuthorizationBinding {
  return {
    authorizationKind: "delivery", taskId: TASK, repoId: "demo",
    worktreeRealpath: join(root, TASK), deliveryTarget: "deploy", deployTarget: "prod",
    deploySpecDigest: `sha256:${"1".repeat(64)}`, policyDigest: `sha256:${"2".repeat(64)}`,
    runtimeBuild: "build-1", toolsetEpoch: 1, toolsDigest: `sha256:${"3".repeat(64)}`,
    createdAt, expiresAt: createdAt + APPROVAL_TTL_MS,
    prNumber: 1, baseRef: "main", baseSha: "b".repeat(40), headSha: "h".repeat(40),
    mergeMethod: "merge", expectedMergeTree: "t".repeat(40),
    deployRef: "profile:deploy-prod", verifyRef: "profile:verify-prod",
  };
}

function proposal(now: number) {
  return createAuthorization(db, {
    kind: "delivery", taskId: TASK, binding: binding(now),
    stages: { merge: { state: "pending" } }, now,
  });
}

function existing(status: "READY" | "APPROVED" | "EXECUTING") {
  const auth = proposal(NOW);
  if (status !== "READY") {
    const { approvalNonce } = rotateAuthorizationChallenge(db, auth.authorizationId, auth.bindingDigest, NOW + 1);
    approveAuthorization(db, {
      authorizationId: auth.authorizationId, bindingDigest: auth.bindingDigest, approvalNonce,
      identity: { sub: "test-user", email: "test@example.com" }, now: NOW + 2,
    });
  }
  if (status === "EXECUTING") {
    beginAuthorizedExecution(db, auth.authorizationId, "delivery", auth.bindingDigest, NOW + 3);
  }
  return auth;
}

function expiryAudits() {
  return listAudit(db, TASK, 100).filter((row) => row.tool === "grande_authorization_expiry_reconcile");
}

function storedStatus(authorizationId: string) {
  return (db.prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
    .get(authorizationId) as { status: string }).status;
}

describe("authorization expiry closeout", () => {
  it.each(["READY", "APPROVED"] as const)(
    "direct create releases an expired %s slot without waiting for prepare or the scheduler",
    (status) => {
      const old = existing(status);
      const next = proposal(old.expiresAt);
      expect(storedStatus(old.authorizationId)).toBe("EXPIRED");
      expect(next.authorizationId).not.toBe(old.authorizationId);
      expect(activeAuthorizationForTask(db, TASK)?.authorizationId).toBe(next.authorizationId);
      expect(expiryAudits()).toHaveLength(1);
      expect(expiryAudits()[0]).toMatchObject({ state: "SUCCEEDED", decision: "ALLOWED" });
    },
  );

  it.each(["READY", "APPROVED", "EXECUTING"] as const)(
    "direct create preserves the active %s blocker when it is not eligible for approval expiry",
    (status) => {
      const old = existing(status);
      const now = status === "EXECUTING" ? old.expiresAt + 1 : NOW + 10;
      expect(() => proposal(now)).toThrow(/active|活跃|STALE_STATE/i);
      expect(storedStatus(old.authorizationId)).toBe(status);
      expect(activeAuthorizationForTask(db, TASK)?.authorizationId).toBe(old.authorizationId);
      expect(expiryAudits()).toHaveLength(0);
    },
  );

  it("two concurrent SQLite connections produce one expiry winner and one successful audit", async () => {
    const old = existing("APPROVED");
    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const workers: Worker[] = [];
    let ready = 0;
    const run = () => new Promise<number>((resolve, reject) => {
      const worker = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const { DatabaseSync } = require("node:sqlite");
        (async () => {
          const { reconcileExpiredAuthorizations } = await import(workerData.moduleUrl);
          const db = new DatabaseSync(workerData.stateDb);
          let result;
          try {
            db.exec("PRAGMA busy_timeout = 5000");
            parentPort.postMessage({ ready: true });
            const gate = new Int32Array(workerData.gate);
            if (Atomics.wait(gate, 0, 0, 5000) === "timed-out") throw new Error("expiry worker barrier timed out");
            result = reconcileExpiredAuthorizations(db, workerData.now);
          } finally {
            db.close();
          }
          parentPort.postMessage(result);
        })().catch((error) => { throw error; });
      `, {
        eval: true,
        workerData: {
          stateDb, gate, now: old.expiresAt,
          moduleUrl: new URL("../src/authorizationExpiry.ts", import.meta.url).href,
        },
      });
      workers.push(worker);
      let finished = false;
      worker.on("message", (message: { ready?: boolean; expired?: number }) => {
        if (message.ready) {
          if (++ready === 2) {
            Atomics.store(new Int32Array(gate), 0, 1);
            Atomics.notify(new Int32Array(gate), 0, 2);
          }
        } else if (typeof message.expired === "number") {
          finished = true;
          resolve(message.expired);
        }
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (!finished) reject(new Error(`expiry worker exited before result: ${code}`));
      });
    });
    try {
      expect((await Promise.all([run(), run()])).sort()).toEqual([0, 1]);
      expect(storedStatus(old.authorizationId)).toBe("EXPIRED");
      expect(activeAuthorizationForTask(db, TASK)).toBeUndefined();
      expect(expiryAudits()).toHaveLength(1);
      expect(expiryAudits()[0]).toMatchObject({ state: "SUCCEEDED", decision: "ALLOWED" });
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 15_000);

  it.each(["startup", "periodic"] as const)(
    "task recovery failure at %s does not skip durable authorization expiry",
    async (failurePhase) => {
      const old = existing("APPROVED");
      const failure = new Error("task recovery unavailable");
      let phase: "startup" | "periodic" = "startup";
      let now = failurePhase === "startup" ? old.expiresAt : NOW + 3;
      let periodic: (() => void) | undefined;
      const errors: Array<{ phase: string; error: unknown }> = [];
      const successfulPhases: string[] = [];
      const controller = await startTaskLifecycleReconciler(db, loadLayout(), {
        reconcile: async () => {
          if (phase === failurePhase) throw failure;
          return { creatingReady: 0, creatingClosed: 0, closingClosed: 0, unresolved: 0 };
        },
        reconcileAuthorizations: (connection) => reconcileExpiredAuthorizations(connection, now),
        onError: (atPhase, error) => { errors.push({ phase: atPhase, error }); },
        onResult: (atPhase) => { successfulPhases.push(atPhase); },
        setIntervalFn: (callback) => {
          periodic = callback;
          return {} as ReturnType<typeof setInterval>;
        },
        clearIntervalFn: () => {},
      });
      try {
        if (failurePhase === "periodic") {
          expect(storedStatus(old.authorizationId)).toBe("APPROVED");
          phase = "periodic";
          now = old.expiresAt;
          periodic!();
          await Promise.resolve();
        }
        expect(storedStatus(old.authorizationId)).toBe("EXPIRED");
        expect(activeAuthorizationForTask(db, TASK)).toBeUndefined();
        expect(expiryAudits()).toHaveLength(1);
        expect(expiryAudits()[0]).toMatchObject({ state: "SUCCEEDED", decision: "ALLOWED" });
        expect(errors).toEqual([{ phase: failurePhase, error: failure }]);
        expect(successfulPhases).not.toContain(failurePhase);
      } finally {
        controller.stop();
      }
    },
  );

  it("expiry audit failure leaves recovery running and allows the next periodic retry", async () => {
    const old = existing("APPROVED");
    db.exec(`
      CREATE TRIGGER fail_scheduler_expiry_audit
      BEFORE UPDATE OF state ON audit
      WHEN NEW.tool='grande_authorization_expiry_reconcile' AND NEW.state='SUCCEEDED'
      BEGIN
        SELECT RAISE(ABORT, 'scheduler expiry audit failure');
      END
    `);
    let recoveryCalls = 0;
    let periodic: (() => void) | undefined;
    const errors: unknown[] = [];
    const results: Array<{ phase: string; expired: number }> = [];
    const controller = await startTaskLifecycleReconciler(db, loadLayout(), {
      reconcile: async () => {
        recoveryCalls++;
        return { creatingReady: 0, creatingClosed: 0, closingClosed: 0, unresolved: 0 };
      },
      reconcileAuthorizations: (connection) => reconcileExpiredAuthorizations(connection, old.expiresAt),
      onError: (_phase, error) => { errors.push(error); },
      onResult: (phase, result) => { results.push({ phase, expired: result.authorizationsExpired }); },
      setIntervalFn: (callback) => {
        periodic = callback;
        return {} as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });
    try {
      expect(recoveryCalls).toBe(1);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain("scheduler expiry audit failure");
      expect(storedStatus(old.authorizationId)).toBe("APPROVED");
      expect(expiryAudits()).toHaveLength(0);
      expect(results).toHaveLength(0);
      db.exec("DROP TRIGGER fail_scheduler_expiry_audit");
      periodic!();
      await Promise.resolve();
      expect(recoveryCalls).toBe(2);
      expect(storedStatus(old.authorizationId)).toBe("EXPIRED");
      expect(expiryAudits()).toHaveLength(1);
      expect(results).toEqual([{ phase: "periodic", expired: 1 }]);
    } finally {
      controller.stop();
    }
  });
});
