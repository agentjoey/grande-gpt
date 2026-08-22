import type { DatabaseSync } from "node:sqlite";

export interface ActivationToolsetIdentity {
  toolsetEpoch: number;
  toolsCount: number;
  toolsDigest: string;
}

export interface ActivationEvidence {
  targetBuild: string;
  runtimeBuild: string;
  expectedToolset: ActivationToolsetIdentity;
  runtimeToolset: ActivationToolsetIdentity;
  restart: {
    launchAgentRunning: boolean;
    endpointReady: boolean;
  };
  readProbe: {
    ok: boolean;
    httpStatus: number;
  };
}

export interface ActivationReceipt {
  targetBuild: string;
  runtimeBuild: string;
  toolsetEpoch: number;
  toolsCount: number;
  toolsDigest: string;
  activatedAt: number;
  restart: {
    launchAgentRunning: true;
    endpointReady: true;
  };
  readProbe: {
    ok: true;
    httpStatus: 200;
  };
}

function ensureTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activation_receipt (
      receiptId   INTEGER PRIMARY KEY CHECK (receiptId = 1),
      receiptJson TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL
    )
  `);
}

function assertEligible(evidence: ActivationEvidence): void {
  if (evidence.targetBuild !== evidence.runtimeBuild) {
    throw new Error(`activation build mismatch：target=${evidence.targetBuild} runtime=${evidence.runtimeBuild}`);
  }

  const expected = evidence.expectedToolset;
  const runtime = evidence.runtimeToolset;
  if (
    expected.toolsetEpoch !== runtime.toolsetEpoch
    || expected.toolsCount !== runtime.toolsCount
    || expected.toolsDigest !== runtime.toolsDigest
  ) {
    throw new Error(
      `activation tool identity mismatch：expected epoch/count/digest=`
      + `${expected.toolsetEpoch}/${expected.toolsCount}/${expected.toolsDigest}，runtime=`
      + `${runtime.toolsetEpoch}/${runtime.toolsCount}/${runtime.toolsDigest}`,
    );
  }

  if (!evidence.restart.launchAgentRunning) {
    throw new Error("activation restart evidence 不完整：LaunchAgent 未证明 running");
  }
  if (!evidence.restart.endpointReady) {
    throw new Error("activation restart evidence 不完整：Gateway endpoint 未证明 ready");
  }
  if (!evidence.readProbe.ok || evidence.readProbe.httpStatus !== 200) {
    throw new Error(`activation trusted read probe 未通过：HTTP ${evidence.readProbe.httpStatus}`);
  }
}

export function recordActivationReceipt(
  db: DatabaseSync,
  evidence: ActivationEvidence,
  activatedAt = Date.now(),
): ActivationReceipt {
  ensureTable(db);
  assertEligible(evidence);

  const receipt: ActivationReceipt = {
    targetBuild: evidence.targetBuild,
    runtimeBuild: evidence.runtimeBuild,
    toolsetEpoch: evidence.runtimeToolset.toolsetEpoch,
    toolsCount: evidence.runtimeToolset.toolsCount,
    toolsDigest: evidence.runtimeToolset.toolsDigest,
    activatedAt,
    restart: { launchAgentRunning: true, endpointReady: true },
    readProbe: { ok: true, httpStatus: 200 },
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO activation_receipt (receiptId, receiptJson, updatedAt)
      VALUES (1, ?, ?)
      ON CONFLICT(receiptId) DO UPDATE SET receiptJson=excluded.receiptJson, updatedAt=excluded.updatedAt
    `).run(JSON.stringify(receipt), activatedAt);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original persistence failure.
    }
    throw error;
  }
  return receipt;
}

export function getLatestActivationReceipt(db: DatabaseSync): ActivationReceipt | null {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activation_receipt'")
    .get();
  if (!table) return null;

  const row = db.prepare("SELECT receiptJson FROM activation_receipt WHERE receiptId=1").get() as
    | { receiptJson: string }
    | undefined;
  if (!row) return null;

  const parsed = JSON.parse(row.receiptJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("activation receipt malformed");
  }
  return parsed as ActivationReceipt;
}
