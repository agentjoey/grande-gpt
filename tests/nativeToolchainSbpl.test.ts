import { describe, expect, it } from "vitest";
import { buildProfile, type SandboxPaths } from "../src/sbpl.ts";

const paths: SandboxPaths = {
  worktree: "/W/.grande-work/worktrees/demo/task_1",
  canonicalGit: "/W/demo/.git",
  jobTmp: "/tmp/job_1",
  controlRoot: "/Users/u/.grande-control",
  worktreesRoot: "/W/.grande-work/worktrees",
  execRoots: ["/usr/bin", "/bin", "/usr/sbin"],
};

function rules(profile: string): string[] {
  return profile.split("\n").filter((line) => !line.startsWith(";;") && line.trim() !== "");
}

describe("GG-BL-029 macOS native toolchain closure", () => {
  it("ordinary profiles do not gain /var/select or Xcode Developer read access", () => {
    const profileRules = rules(buildProfile(paths));
    expect(profileRules).not.toContain('(allow file-read* (subpath "/var/select"))');
    expect(profileRules).not.toContain('(allow file-read* (subpath "/Applications/Xcode.app/Contents/Developer"))');
    expect(profileRules).toContain('(allow file-read* (subpath "/private/var/select"))');
  });

  it("approved toolchain closure adds exact read roots and exact exec targets without opening /var or Developer exec subtree", () => {
    const developer = "/Applications/Xcode.app/Contents/Developer";
    const clang = `${developer}/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang`;
    const ld = `${developer}/Toolchains/XcodeDefault.xctoolchain/usr/bin/ld`;
    const profileRules = rules(buildProfile({
      ...paths,
      toolchainReadRoots: ["/var/select", developer],
      toolchainExecTargets: [clang, ld],
    }));

    expect(profileRules).toContain('(allow file-read* (subpath "/var/select"))');
    expect(profileRules).toContain(`(allow file-read* (subpath "${developer}"))`);
    expect(profileRules).toContain(`(allow process-exec (literal "${clang}"))`);
    expect(profileRules).toContain(`(allow process-exec (literal "${ld}"))`);
    expect(profileRules).not.toContain('(allow file-read* (subpath "/var"))');
    expect(profileRules).not.toContain('(allow file-read* (subpath "/private/var"))');
    expect(profileRules).not.toContain(`(allow process-exec (subpath "${developer}"))`);
  });

  it("rejects toolchain exec targets under the worktree so the closure cannot authorize freshly built repo binaries", () => {
    expect(() => buildProfile({
      ...paths,
      toolchainExecTargets: [`${paths.worktree}/native/helper`],
    })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});
