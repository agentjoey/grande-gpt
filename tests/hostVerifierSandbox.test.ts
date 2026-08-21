import { describe, expect, it } from "vitest";
import {
  buildHostVerifierSandboxPlan,
  HOST_VERIFIER_POLICY_VERSION,
} from "../src/hostVerifierSandbox.ts";

const paths = {
  verifierWorktree: "/private/tmp/grande-verifier/source",
  dependencyRoots: ["/private/tmp/grande-verifier/deps"],
  jobTmp: "/private/tmp/grande-verifier/job",
  controlRoot: "/Users/test/.grande-control",
  workspaceRoot: "/Users/test/workspace",
  canonicalRepo: "/Users/test/workspace/grande-gpt",
  taskWorktree: "/Users/test/workspace/.grande-work/worktrees/grande-gpt/task-x",
  databasePath: "/Users/test/.grande-control/state/grande.db",
  toolchainReadRoots: ["/usr/bin", "/bin", "/opt/trusted-node"],
  executableFiles: [
    "/usr/bin/sandbox-exec",
    "/bin/sh",
    "/usr/bin/git",
    "/opt/trusted-node/bin/node",
  ],
  productionPort: 8787,
  loopbackPorts: [49173, 49174],
} as const;

describe("host verifier sandbox plan", () => {
  it("uses policy v2 exact trusted loopback ports with no broad localhost capability", () => {
    const plan = buildHostVerifierSandboxPlan(paths);
    expect(HOST_VERIFIER_POLICY_VERSION).toBe(2);
    expect(plan.policyVersion).toBe(2);
    expect(plan.profile).toContain("(deny default)");
    expect(plan.profile).toContain('(allow file-read* (subpath "/private/tmp/grande-verifier/source"))');
    expect(plan.profile).not.toContain('(allow file-write* (subpath "/private/tmp/grande-verifier/source"))');
    expect(plan.profile).toContain('(allow file-write* (subpath "/private/tmp/grande-verifier/job"))');
    for (const port of paths.loopbackPorts) {
      expect(plan.profile).toContain(`(allow network-bind (local ip "localhost:${port}"))`);
      expect(plan.profile).toContain(`(allow network-inbound (local ip "localhost:${port}"))`);
      expect(plan.profile).toContain(`(allow network-outbound (remote ip "localhost:${port}"))`);
      expect(plan.profile).not.toContain(`127.0.0.1:${port}`);
    }
    expect(plan.profile).not.toContain("localhost:*");
    expect(plan.profile).not.toContain("localhost:8787");
    expect(plan.profile).not.toContain('(deny network-outbound (remote tcp "localhost:8787"))');
    expect(plan.profile).not.toContain("(allow network*)");
  });

  it("allows Node/V8 startup and child creation without broad signal privileges", () => {
    const profile = buildHostVerifierSandboxPlan(paths).profile;
    expect(profile).toContain("(allow sysctl-read)");
    expect(profile).toContain("(allow process-fork)");
    expect(profile).not.toContain("(allow signal)");
  });

  it("allows process execution only for exact trusted executable files", () => {
    const profile = buildHostVerifierSandboxPlan(paths).profile;
    for (const file of paths.executableFiles) {
      expect(profile).toContain(`(allow process-exec (literal "${file}"))`);
    }
    expect(profile).not.toContain('(allow process-exec (subpath "/usr/bin"))');
    expect(profile).not.toContain('(allow process-exec (subpath "/opt/trusted-node"))');
    expect(profile).not.toContain('(allow process-exec)');
  });

  it("explicitly denies trusted control/workspace/canonical/task/db paths", () => {
    const profile = buildHostVerifierSandboxPlan(paths).profile;
    for (const path of [
      paths.controlRoot,
      paths.workspaceRoot,
      paths.canonicalRepo,
      paths.taskWorktree,
      paths.databasePath,
    ]) {
      expect(profile).toContain(`(deny file-read* file-write* (subpath "${path}"))`);
    }
  });

  it("constructs a fresh minimal environment and only exposes trusted allocated ports", () => {
    const plan = buildHostVerifierSandboxPlan(paths);
    expect(Object.keys(plan.env).sort()).toEqual([
      "CI", "GRANDE_VERIFIER_LOOPBACK_PORTS", "HOME", "LANG", "PATH", "TMPDIR", "XDG_CACHE_HOME",
    ]);
    expect(plan.env.PATH).toBe("/usr/bin:/bin:/opt/trusted-node/bin");
    expect(plan.env.HOME).toBe(`${paths.jobTmp}/home`);
    expect(plan.env.GRANDE_VERIFIER_LOOPBACK_PORTS).toBe("49173,49174");
    for (const forbidden of [
      "GITHUB_TOKEN", "OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
      "SSH_AUTH_SOCK", "DYLD_INSERT_LIBRARIES", "GIT_CONFIG_GLOBAL", "GIT_ASKPASS",
    ]) {
      expect(plan.env).not.toHaveProperty(forbidden);
    }
  });

  it("rejects invalid or unsafe trusted loopback allocations", () => {
    expect(() => buildHostVerifierSandboxPlan({ ...paths, loopbackPorts: [8787] })).toThrow(/production|port/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, loopbackPorts: [49173, 49173] })).toThrow(/duplicate|unique/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, loopbackPorts: [0] })).toThrow(/port/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, loopbackPorts: [65536] })).toThrow(/port/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, loopbackPorts: [1,2,3,4,5,6,7,8,9] })).toThrow(/too many|limit|port/i);
  });

  it("rejects relative paths, writable/source overlap, sensitive-root overlap, and invalid production port", () => {
    expect(() => buildHostVerifierSandboxPlan({ ...paths, verifierWorktree: "relative/source" })).toThrow(/absolute/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, jobTmp: paths.verifierWorktree })).toThrow(/overlap|source/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, jobTmp: paths.workspaceRoot })).toThrow(/overlap|workspace/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, productionPort: 0 })).toThrow(/port/i);
  });
});
