import { describe, expect, it } from "vitest";
import {
  HOST_VERIFIER_RESOURCE_LIMITS,
  HostVerifierCoordinator,
  assertDisposableVerifierRoot,
  buildHostVerifierStaticPlan,
  buildTrustedVitestConfig,
  type HostVerifierRequest,
} from "../src/hostVerifier.ts";

function req(overrides: Partial<HostVerifierRequest> = {}): HostVerifierRequest {
  return {
    taskId: "task-a",
    repoId: "grande-gpt",
    commit: "a".repeat(40),
    level: "full",
    ...overrides,
  };
}

describe("host verifier static plan", () => {
  it("selects only trusted auto-safe files for smoke/full", () => {
    const smoke = buildHostVerifierStaticPlan("smoke");
    expect(smoke.files).toEqual(["tests/host/server-auto.host.test.ts"]);
    const full = buildHostVerifierStaticPlan("full");
    expect(full.files).toContain("tests/host/server-auto.host.test.ts");
    expect(full.files).toContain("tests/host/git-hook.host.test.ts");
    expect(full.files).not.toContain("tests/host/server.host.test.ts");
    expect(full.files).not.toContain("tests/host/verifier-sandbox.host.test.ts");
    expect(full.files).not.toContain("tests/host/runner.host.test.ts");
  });

  it("binds static identity to files/level/policy/resource limits before runtime ports exist", () => {
    const a = buildHostVerifierStaticPlan("full");
    const b = buildHostVerifierStaticPlan("full");
    expect(a.staticPlanDigest).toBe(b.staticPlanDigest);
    expect(a.resourceLimits).toEqual(HOST_VERIFIER_RESOURCE_LIMITS);
    expect(buildHostVerifierStaticPlan("smoke").staticPlanDigest).not.toBe(a.staticPlanDigest);
  });

  it("builds a syntactically plain fixed single-worker Vitest config from selected files only", () => {
    const config = buildTrustedVitestConfig(["tests/host/server-auto.host.test.ts", "tests/host/git-hook.host.test.ts"]);
    expect(config).toContain("tests/host/server-auto.host.test.ts");
    expect(config).toContain("tests/host/git-hook.host.test.ts");
    expect(config).toContain('environment: "node"');
    expect(config).toContain('pool: "forks"');
    expect(config).toContain("maxWorkers: 1");
    expect(config).not.toContain('\\"node\\"');
    expect(config).not.toContain("vitest.host.config.ts");
    expect(config).not.toContain("process.env");
  });

  it("rejects any disposable cleanup root overlapping task/workspace/control", () => {
    const bounds = {
      workspaceRoot: "/Users/test/workspace",
      controlRoot: "/Users/test/.grande-control",
      taskWorktree: "/Users/test/workspace/.grande-work/worktrees/grande-gpt/task-a",
    };
    expect(() => assertDisposableVerifierRoot("/private/tmp/grande-host-verifier-abc", bounds)).not.toThrow();
    expect(() => assertDisposableVerifierRoot(bounds.taskWorktree, bounds)).toThrow(/disposable|task|overlap/i);
    expect(() => assertDisposableVerifierRoot("/Users/test/workspace/tmp", bounds)).toThrow(/workspace|overlap/i);
    expect(() => assertDisposableVerifierRoot("/Users/test/.grande-control/tmp", bounds)).toThrow(/control|overlap/i);
    expect(() => assertDisposableVerifierRoot("/private/tmp/not-a-verifier", bounds)).toThrow(/prefix|verifier|disposable/i);
  });
});

describe("HostVerifierCoordinator", () => {
  it("coalesces an identical task/repo/SHA/static-plan tuple", async () => {
    let resolve!: () => void;
    const settled = new Promise<void>((r) => { resolve = r; });
    let launches = 0;
    const c = new HostVerifierCoordinator(() => {
      launches++;
      return { jobId: "job-1", settled };
    });
    const first = c.start(req());
    const second = c.start(req());
    expect(first).toMatchObject({ state: "running", jobId: "job-1", coalesced: false });
    expect(second).toMatchObject({ state: "running", jobId: "job-1", coalesced: true });
    expect(launches).toBe(1);
    resolve();
    await settled;
  });

  it("keeps one verifier globally and reports busy for a different tuple", async () => {
    let resolve!: () => void;
    const settled = new Promise<void>((r) => { resolve = r; });
    let launches = 0;
    const c = new HostVerifierCoordinator(() => {
      launches++;
      return { jobId: "job-1", settled };
    });
    c.start(req());
    const other = c.start(req({ commit: "b".repeat(40) }));
    expect(other).toMatchObject({ state: "busy", jobId: "job-1", coalesced: false });
    expect(launches).toBe(1);
    resolve();
    await settled;
  });

  it("releases the global slot when the verifier settles", async () => {
    const settlements: Array<() => void> = [];
    let launches = 0;
    const c = new HostVerifierCoordinator(() => {
      launches++;
      let resolve!: () => void;
      const settled = new Promise<void>((r) => { resolve = r; });
      settlements.push(resolve);
      return { jobId: `job-${launches}`, settled };
    });
    c.start(req());
    settlements[0]!();
    await Promise.resolve();
    await Promise.resolve();
    const next = c.start(req({ commit: "b".repeat(40) }));
    expect(next).toMatchObject({ state: "running", jobId: "job-2" });
    settlements[1]!();
  });
});
