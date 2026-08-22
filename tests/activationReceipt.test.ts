import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getLatestActivationReceipt,
  recordActivationReceipt,
  type ActivationEvidence,
} from "../src/activationReceipt.ts";

let db: DatabaseSync;

const VALID: ActivationEvidence = {
  targetBuild: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  runtimeBuild: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  expectedToolset: {
    toolsetEpoch: 2,
    toolsCount: 25,
    toolsDigest: "sha256:expected",
  },
  runtimeToolset: {
    toolsetEpoch: 2,
    toolsCount: 25,
    toolsDigest: "sha256:expected",
  },
  restart: {
    launchAgentRunning: true,
    endpointReady: true,
  },
  readProbe: {
    ok: true,
    httpStatus: 200,
  },
};

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  db.close();
});

describe("GG-BL-019 durable production activation receipt", () => {
  it("reads missing activation evidence without creating a status table as a side effect", () => {
    expect(getLatestActivationReceipt(db)).toBeNull();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activation_receipt'").get(),
    ).toBeUndefined();
  });

  it("persists exact build/tool identity only after restart readiness and trusted read probe succeed", () => {
    const receipt = recordActivationReceipt(db, VALID, 1_787_409_600_000);

    expect(receipt).toEqual({
      targetBuild: VALID.targetBuild,
      runtimeBuild: VALID.runtimeBuild,
      toolsetEpoch: 2,
      toolsCount: 25,
      toolsDigest: "sha256:expected",
      activatedAt: 1_787_409_600_000,
      restart: { launchAgentRunning: true, endpointReady: true },
      readProbe: { ok: true, httpStatus: 200 },
    });
    expect(getLatestActivationReceipt(db)).toEqual(receipt);
  });

  it("rejects target/runtime build mismatch without persisting evidence", () => {
    const mismatch: ActivationEvidence = {
      ...VALID,
      runtimeBuild: "git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    expect(() => recordActivationReceipt(db, mismatch)).toThrow(/build|target|runtime/i);
    expect(getLatestActivationReceipt(db)).toBeNull();
  });

  it("rejects any expected/runtime tool identity mismatch", () => {
    const cases: ActivationEvidence[] = [
      { ...VALID, runtimeToolset: { ...VALID.runtimeToolset, toolsetEpoch: 3 } },
      { ...VALID, runtimeToolset: { ...VALID.runtimeToolset, toolsCount: 24 } },
      { ...VALID, runtimeToolset: { ...VALID.runtimeToolset, toolsDigest: "sha256:different" } },
    ];
    for (const evidence of cases) {
      expect(() => recordActivationReceipt(db, evidence)).toThrow(/tool|identity|epoch|digest|count/i);
      expect(getLatestActivationReceipt(db)).toBeNull();
    }
  });

  it("rejects activation before LaunchAgent running, endpoint readiness, or trusted read probe", () => {
    const cases: ActivationEvidence[] = [
      { ...VALID, restart: { ...VALID.restart, launchAgentRunning: false } },
      { ...VALID, restart: { ...VALID.restart, endpointReady: false } },
      { ...VALID, readProbe: { ok: false, httpStatus: 500 } },
    ];
    for (const evidence of cases) {
      expect(() => recordActivationReceipt(db, evidence)).toThrow(/restart|launchagent|endpoint|read|probe|ready/i);
      expect(getLatestActivationReceipt(db)).toBeNull();
    }
  });
});
