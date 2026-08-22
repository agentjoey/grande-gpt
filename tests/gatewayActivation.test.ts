import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLatestActivationReceipt } from "../src/activationReceipt.ts";
import {
  runProductionGatewayActivation,
  type GatewayActivationRuntime,
} from "../src/gatewayActivation.ts";
import type { SelfCheckResult } from "../src/selfcheck.ts";
import type { ToolsetIdentity } from "../src/toolsetIdentity.ts";

let db: DatabaseSync;

const TARGET: ToolsetIdentity = {
  gatewayBuild: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  toolsetEpoch: 2,
  toolsCount: 25,
  toolsDigest: "sha256:expected",
};

function probe(overrides: Partial<SelfCheckResult> = {}): SelfCheckResult {
  return {
    url: "http://127.0.0.1:8787/mcp",
    httpStatus: 200,
    bytes: 123,
    gatewayBuild: TARGET.gatewayBuild,
    toolsetEpoch: TARGET.toolsetEpoch,
    toolsCount: TARGET.toolsCount,
    toolsDigest: TARGET.toolsDigest,
    tools: [],
    ...overrides,
  };
}

function runtime(overrides: Partial<GatewayActivationRuntime> = {}): { runtime: GatewayActivationRuntime; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      restart: () => {
        calls.push("restart");
        return { code: 0, lines: ["Gateway LaunchAgent 已重启并就绪"] };
      },
      status: () => {
        calls.push("status");
        return { code: 0, lines: ["Gateway LaunchAgent 已加载 state=running"] };
      },
      readProbe: async () => {
        calls.push("probe");
        return probe();
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  db.close();
});

describe("GG-BL-019 production activation orchestration", () => {
  it("records activation only after restart readiness, running status, and trusted read probe all pass", async () => {
    const fixture = runtime();
    const result = await runProductionGatewayActivation(db, TARGET, fixture.runtime, 1_787_409_600_000);

    expect(result.code).toBe(0);
    expect(fixture.calls).toEqual(["restart", "status", "probe"]);
    expect(result.receipt).toEqual(getLatestActivationReceipt(db));
    expect(result.receipt?.targetBuild).toBe(TARGET.gatewayBuild);
    expect(result.receipt?.runtimeBuild).toBe(TARGET.gatewayBuild);
  });

  it("stops before status/probe and writes no receipt when restart/readiness fails", async () => {
    const fixture = runtime({
      restart: () => {
        fixture.calls.push("restart");
        return { code: 1, lines: ["restart failed"] };
      },
    });
    const result = await runProductionGatewayActivation(db, TARGET, fixture.runtime);

    expect(result.code).toBe(1);
    expect(fixture.calls).toEqual(["restart"]);
    expect(getLatestActivationReceipt(db)).toBeNull();
  });

  it("stops before trusted read probe when LaunchAgent is not proven running", async () => {
    const fixture = runtime({
      status: () => {
        fixture.calls.push("status");
        return { code: 0, lines: ["Gateway LaunchAgent 已加载 state=waiting"] };
      },
    });
    const result = await runProductionGatewayActivation(db, TARGET, fixture.runtime);

    expect(result.code).toBe(1);
    expect(fixture.calls).toEqual(["restart", "status"]);
    expect(getLatestActivationReceipt(db)).toBeNull();
  });

  it("fails closed without persisting when runtime build/tool identity does not match target", async () => {
    const fixture = runtime({
      readProbe: async () => {
        fixture.calls.push("probe");
        return probe({ toolsDigest: "sha256:different" });
      },
    });
    const result = await runProductionGatewayActivation(db, TARGET, fixture.runtime);

    expect(result.code).toBe(1);
    expect(fixture.calls).toEqual(["restart", "status", "probe"]);
    expect(getLatestActivationReceipt(db)).toBeNull();
    expect(result.lines.join("\n")).toMatch(/identity|digest|mismatch/i);
  });
});
