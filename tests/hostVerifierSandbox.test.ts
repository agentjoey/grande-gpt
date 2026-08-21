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
} as const;

describe("host verifier sandbox plan", () => {
  it("is fixed-policy, read-only source, temp-only writes, and loopback-only network", () => {
    const plan = buildHostVerifierSandboxPlan(paths);
    expect(HOST_VERIFIER_POLICY_VERSION).toBeGreaterThan(0);
    expect(plan.profile).toContain("(deny default)");
    expect(plan.profile).toContain('(allow file-read* (subpath "/private/tmp/grande-verifier/source"))');
    expect(plan.profile).not.toContain('(allow file-write* (subpath "/private/tmp/grande-verifier/source"))');
    expect(plan.profile).toContain('(allow file-write* (subpath "/private/tmp/grande-verifier/job"))');
    expect(plan.profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(plan.profile).toContain('(deny network-outbound (remote ip "localhost:8787"))');
    expect(plan.profile).not.toContain("(allow network*)");
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

  it("constructs a fresh minimal environment instead of inheriting credentials/proxies/DYLD/Git/SSH state", () => {
    const plan = buildHostVerifierSandboxPlan(paths);
    expect(Object.keys(plan.env).sort()).toEqual([
      "CI", "HOME", "LANG", "PATH", "TMPDIR", "XDG_CACHE_HOME",
    ]);
    expect(plan.env.PATH).toBe("/usr/bin:/bin:/opt/trusted-node/bin");
    expect(plan.env.HOME).toBe(`${paths.jobTmp}/home`);
    for (const forbidden of [
      "GITHUB_TOKEN", "OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
      "SSH_AUTH_SOCK", "DYLD_INSERT_LIBRARIES", "GIT_CONFIG_GLOBAL", "GIT_ASKPASS",
    ]) {
      expect(plan.env).not.toHaveProperty(forbidden);
    }
  });

  it("rejects relative paths, writable/source overlap, sensitive-root overlap, and invalid port", () => {
    expect(() => buildHostVerifierSandboxPlan({ ...paths, verifierWorktree: "relative/source" })).toThrow(/absolute/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, jobTmp: paths.verifierWorktree })).toThrow(/overlap|source/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, jobTmp: paths.workspaceRoot })).toThrow(/overlap|workspace/i);
    expect(() => buildHostVerifierSandboxPlan({ ...paths, productionPort: 0 })).toThrow(/port/i);
  });
});
