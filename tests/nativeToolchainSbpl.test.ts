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

describe("GG-BL-029 macOS native toolchain selector read closure", () => {
  it("allows both /var/select and /private/var/select without opening all of /var", () => {
    const profile = buildProfile(paths);
    const rules = profile.split("\n").filter((line) => !line.startsWith(";;") && line.trim() !== "");

    expect(rules).toContain('(allow file-read* (subpath "/var/select"))');
    expect(rules).toContain('(allow file-read* (subpath "/private/var/select"))');
    expect(rules).not.toContain('(allow file-read* (subpath "/var"))');
    expect(rules).not.toContain('(allow file-read* (subpath "/private/var"))');
  });
});
