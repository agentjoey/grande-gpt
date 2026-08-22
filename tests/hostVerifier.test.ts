import { describe, expect, it } from "vitest";
import {
  assertDisposableVerifierRoot,
  buildHostVerifierStaticPlan,
  buildTrustedVitestConfig,
  HostVerifierCoordinator,
} from "../src/hostVerifier.ts";

const request = {
  taskId: "task-1",
  repoId: "grande-gpt",
  commit: "a".repeat(40),
  level: "full" as const,
};

describe("host verifier static plan", () => {
  it("selects only auto-safe trusted files and binds policy/resource identity", () => {
    const plan = buildHostVerifierStaticPlan("full");
    expect(plan.files).toEqual([
      "tests/host/git-hook.host.test.ts",
      "tests/host/server-auto.host.test.ts",
    ]);
    expect(plan.policyVersion).toBe(2);
    expect(plan.resourceLimits).toMatchObject({
      wallTimeoutMs: 120_000,
      maxRssMb: 1536,
      maxOutputBytes: 256 * 1024,
    });
    expect(plan.staticPlanDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("builds a syntactically plain fixed single-worker Vitest config from selected files only", () => {
    const config = buildTrustedVitestConfig([
      "tests/host/server-auto.host.test.ts",
      "tests/host/git-hook.host.test.ts",
    ]);
    expect(config).toContain("tests/host/server-auto.host.test.ts");
    expect(config).toContain("tests/host/git-hook.host.test.ts");
    expect(config).toContain('environment: "node"');
    expect(config).toContain('pool: "threads"');
    expect(config).toContain("maxWorkers: 1");
    expect(config).toContain("fileParallelism: false");
    expect(config).not.toContain('pool: "forks"');
    expect(config).not.toContain('\\"node\\"');
  });

  it("rejects non-manifest paths in trusted Vitest config", () => {
    expect(() => buildTrustedVitestConfig(["tests/unit.test.ts"])).toThrow(/trusted host verifier files/i);
  });

  it("cleanup guard rejects workspace/control/task overlap and non-trusted temp names", () => {
    const bounds = {
      workspaceRoot: "/Users/test/workspace",
      controlRoot: "/Users/test/control",
      taskWorktree: "/Users/test/workspace/.grande-work/worktrees/grande-gpt/task-1",
    };
    expect(() => assertDisposableVerifierRoot(bounds.workspaceRoot, bounds)).toThrow(/workspace/i);
    expect(() => assertDisposableVerifierRoot(bounds.controlRoot, bounds)).toThrow(/control/i);
    expect(() => assertDisposableVerifierRoot(bounds.taskWorktree, bounds)).toThrow(/workspace|task/i);
    expect(() => assertDisposableVerifierRoot("/private/tmp/not-owned", bounds)).toThrow(/prefix/i);
    expect(() => assertDisposableVerifierRoot("/private/tmp/grande-host-verifier-abc", bounds)).not.toThrow();
  });
});

describe("HostVerifierCoordinator", () => {
  it("coalesces the same tuple into one launch", async () => {
    let launches = 0;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const coordinator = new HostVerifierCoordinator(() => {
      launches += 1;
      return { jobId: "job-1", settled };
    });
    const first = coordinator.start(request);
    const second = coordinator.start(request);
    expect(first).toMatchObject({ state: "running", jobId: "job-1", coalesced: false });
    expect(second).toMatchObject({ state: "running", jobId: "job-1", coalesced: true });
    expect(launches).toBe(1);
    settle();
    await settled;
  });

  it("keeps exactly one verifier global and frees the slot after settlement", async () => {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    let launches = 0;
    const coordinator = new HostVerifierCoordinator((_request, plan) => {
      void plan;
      launches += 1;
      return { jobId: `job-${launches}`, settled: launches === 1 ? settled : Promise.resolve() };
    });
    expect(coordinator.start(request).state).toBe("running");
    expect(coordinator.start({ ...request, commit: "b".repeat(40) })).toMatchObject({
      state: "busy",
      jobId: "job-1",
      coalesced: false,
    });
    expect(launches).toBe(1);
    settle();
    await settled;
    await Promise.resolve();
    expect(coordinator.start({ ...request, commit: "b".repeat(40) })).toMatchObject({
      state: "running",
      jobId: "job-2",
    });
    expect(launches).toBe(2);
  });

  it("rejects non-exact commit identity before launch", () => {
    const coordinator = new HostVerifierCoordinator(() => ({ jobId: "never", settled: Promise.resolve() }));
    expect(() => coordinator.start({ ...request, commit: "main" })).toThrow(/exact|40-hex|commit/i);
  });
});
