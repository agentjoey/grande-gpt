import { describe, expect, it } from "vitest";
import {
  computeOuterTestPlanDigest,
  isOuterTestReceiptEligible,
  parseOuterTestReceipt,
  recordTrustedOuterTestPassV2,
  type OuterTestReceiptV2,
  type TrustedFinalizedHostVerifierJob,
} from "../src/outerTestReceipt.ts";

const limits = {
  wallTimeoutMs: 120_000,
  maxRssMb: 1536,
  maxOutputBytes: 256 * 1024,
} as const;

function digest(overrides: Partial<Parameters<typeof computeOuterTestPlanDigest>[0]> = {}): string {
  return computeOuterTestPlanDigest({
    level: "full",
    files: ["tests/host/server.host.test.ts", "tests/host/git-hook.host.test.ts"],
    policyVersion: 2,
    resourceLimits: limits,
    loopbackPorts: [49174, 49173],
    ...overrides,
  });
}

function receipt(overrides: Partial<OuterTestReceiptV2> = {}): OuterTestReceiptV2 {
  return {
    version: 2,
    mode: "auto",
    taskId: "task-v2",
    repoId: "grande-gpt",
    commit: "a".repeat(40),
    level: "full",
    profile: "host-verifier",
    files: ["tests/host/git-hook.host.test.ts", "tests/host/server.host.test.ts"],
    planDigest: digest(),
    jobId: "job-v2",
    startedAt: 100,
    endedAt: 200,
    hostToolchain: {
      node: "v24.14.0",
      pnpm: "10.33.0",
      lockfileSha256: "b".repeat(64),
    },
    ...overrides,
  };
}

const expected = {
  taskId: "task-v2",
  repoId: "grande-gpt",
  commit: "a".repeat(40),
  requiredLevel: "full" as const,
  planDigest: digest(),
};

describe("OuterTestReceipt V2", () => {
  it("hashes sorted files/ports plus level, policy and resource limits deterministically", () => {
    const a = digest();
    const b = digest({
      files: ["tests/host/git-hook.host.test.ts", "tests/host/server.host.test.ts"],
      loopbackPorts: [49173, 49174],
    });
    expect(a).toBe(b);
    expect(digest({ policyVersion: 3 })).not.toBe(a);
    expect(digest({ level: "smoke" })).not.toBe(a);
    expect(digest({ files: ["tests/host/server.host.test.ts"] })).not.toBe(a);
    expect(digest({ loopbackPorts: [49173] })).not.toBe(a);
    expect(digest({ resourceLimits: { ...limits, maxOutputBytes: limits.maxOutputBytes + 1 } })).not.toBe(a);
  });

  it("requires exact task/repo/SHA/plan and sufficient level", () => {
    const r = receipt();
    expect(isOuterTestReceiptEligible(r, expected)).toBe(true);
    expect(isOuterTestReceiptEligible(r, { ...expected, taskId: "task-other" })).toBe(false);
    expect(isOuterTestReceiptEligible(r, { ...expected, repoId: "other" })).toBe(false);
    expect(isOuterTestReceiptEligible(r, { ...expected, commit: "c".repeat(40) })).toBe(false);
    expect(isOuterTestReceiptEligible(r, { ...expected, planDigest: digest({ policyVersion: 3 }) })).toBe(false);
  });

  it("accepts full for smoke but never smoke for full", () => {
    expect(isOuterTestReceiptEligible(receipt(), { ...expected, requiredLevel: "smoke" })).toBe(true);
    const smokeDigest = digest({ level: "smoke" });
    const smoke = receipt({ level: "smoke", planDigest: smokeDigest });
    expect(isOuterTestReceiptEligible(smoke, { ...expected, requiredLevel: "full", planDigest: smokeDigest })).toBe(false);
  });

  it("parses valid V2 and fails closed on corrupt/unknown fields", () => {
    const r = receipt();
    expect(parseOuterTestReceipt(JSON.stringify(r), "task-v2")).toEqual(r);
    expect(parseOuterTestReceipt("not-json", "task-v2")).toBeNull();
    expect(parseOuterTestReceipt(JSON.stringify({ ...r, version: 3 }), "task-v2")).toBeNull();
    expect(parseOuterTestReceipt(JSON.stringify({ ...r, endedAt: 50 }), "task-v2")).toBeNull();
    expect(parseOuterTestReceipt(JSON.stringify({ ...r, files: ["ok", 7] }), "task-v2")).toBeNull();
    expect(parseOuterTestReceipt(JSON.stringify({ ...r, hostToolchain: { node: "x" } }), "task-v2")).toBeNull();
  });

  it("GG-BL-026：parses a modern npm HostToolchain identity without a legacy pnpm field", () => {
    const npmToolchain = {
      node: "v24.14.0",
      packageManager: "npm",
      packageManagerVersion: "11.0.0",
      lockfile: "package-lock.json",
      lockfileSha256: "c".repeat(64),
    } as const;
    const modern = { ...receipt(), hostToolchain: npmToolchain } as unknown as OuterTestReceiptV2;

    const parsed = parseOuterTestReceipt(JSON.stringify(modern), "task-v2");

    expect(parsed).toEqual(modern);
    expect((parsed as any)?.hostToolchain).not.toHaveProperty("pnpm");
  });

  it("keeps legacy V1 readable only as manual-transition compatibility", () => {
    const legacy = {
      taskId: "task-v2",
      commit: "a".repeat(40),
      profile: "unit-selfhost",
      files: ["tests/host/server.host.test.ts"],
      passedAt: 123,
    };
    const parsed = parseOuterTestReceipt(JSON.stringify(legacy), "task-v2");
    expect(parsed).toEqual(legacy);
    expect(isOuterTestReceiptEligible(parsed!, expected)).toBe(false);
    expect(isOuterTestReceiptEligible(parsed!, expected, { allowLegacyManualTransition: true })).toBe(true);
  });

  it("creates V2 only from a trusted finalized passed verifier job record", () => {
    const finalized: TrustedFinalizedHostVerifierJob = {
      trustedVerifier: true,
      state: "passed",
      mode: "auto",
      taskId: "task-v2",
      repoId: "grande-gpt",
      commit: "a".repeat(40),
      level: "full",
      profile: "host-verifier",
      files: ["tests/host/server.host.test.ts", "tests/host/git-hook.host.test.ts"],
      policyVersion: 2,
      resourceLimits: limits,
      loopbackPorts: [49174, 49173],
      jobId: "job-v2",
      startedAt: 100,
      endedAt: 200,
      hostToolchain: {
        node: "v24.14.0",
        pnpm: "10.33.0",
        lockfileSha256: "b".repeat(64),
      },
    };
    const r = recordTrustedOuterTestPassV2(finalized);
    expect(r).toEqual(receipt());
    expect(() => recordTrustedOuterTestPassV2({ ...finalized, state: "failed" as never })).toThrow(/passed|final/i);
    expect(() => recordTrustedOuterTestPassV2({ ...finalized, trustedVerifier: false as never })).toThrow(/trusted|verifier/i);
  });
});
