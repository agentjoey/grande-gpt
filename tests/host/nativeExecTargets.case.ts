import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxPaths } from "../../src/sbpl.ts";
import { defaultExecRoots, runSandboxed } from "../../src/sandbox.ts";

let root: string;
let paths: SandboxPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-exec-host-"));
  paths = {
    worktree: join(root, "worktree"),
    canonicalGit: join(root, "canonical", ".git"),
    jobTmp: join(root, "jobtmp"),
    controlRoot: join(root, "control"),
    worktreesRoot: join(root, "worktrees"),
    execRoots: defaultExecRoots(),
  };
  for (const dir of [paths.worktree, paths.canonicalGit, paths.jobTmp, paths.controlRoot, paths.worktreesRoot, join(paths.worktree, "native", "bin")]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function nativeFixture(path: string): void {
  copyFileSync("/usr/bin/true", path);
  chmodSync(path, 0o755);
}

describe("GG-BL-029 exact repo-owned native artifact execution", () => {
  it("executes the control-plane approved exact native output", async () => {
    const relativeTarget = "native/bin/rename-excl";
    const target = join(paths.worktree, relativeTarget);
    nativeFixture(target);

    const result = await runSandboxed({
      argv: [target],
      cwd: paths.worktree,
      paths,
      toolchain: "darwin-clang",
      nativeExecTargets: [relativeTarget],
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("reverse proof: executable sibling beside the approved output remains denied", async () => {
    const relativeTarget = "native/bin/rename-excl";
    nativeFixture(join(paths.worktree, relativeTarget));
    const sibling = join(paths.worktree, "native", "bin", "evil-probe");
    nativeFixture(sibling);

    const result = await runSandboxed({
      argv: [sibling],
      cwd: paths.worktree,
      paths,
      toolchain: "darwin-clang",
      nativeExecTargets: [relativeTarget],
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/operation not permitted|not permitted/i);
  });
});
