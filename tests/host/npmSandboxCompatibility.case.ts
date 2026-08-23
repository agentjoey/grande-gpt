import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxPaths } from "../../src/sbpl.ts";
import { defaultExecRoots, runSandboxed } from "../../src/sandbox.ts";

let root: string;
let paths: SandboxPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "npm-bin-sandbox-"));
  paths = {
    worktree: join(root, "worktree"),
    canonicalGit: join(root, "canonical", ".git"),
    jobTmp: join(root, "jobtmp"),
    controlRoot: join(root, "control"),
    worktreesRoot: join(root, "worktrees"),
    execRoots: defaultExecRoots(),
  };
  for (const dir of [paths.worktree, paths.canonicalGit, paths.jobTmp, paths.controlRoot, paths.worktreesRoot]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(join(paths.worktree, "node_modules", ".bin"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function executable(path: string, source: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
}

describe("GG-BL-027 npm .bin symlink execution", () => {
  it("executes an npm-style .bin symlink whose real target stays inside this worktree node_modules", async () => {
    const target = join(paths.worktree, "node_modules", "demo-cli", "bin", "cli.js");
    executable(target, "#!/usr/bin/env node\nconsole.log('npm-bin-ok')\n");
    const bin = join(paths.worktree, "node_modules", ".bin", "demo-cli");
    symlinkSync("../demo-cli/bin/cli.js", bin);

    const result = await runSandboxed({
      argv: [bin], cwd: paths.worktree, paths, timeoutMs: 10_000, maxOutputBytes: 65_536,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("npm-bin-ok");
  });

  it("does not grant exec when an npm-style .bin symlink resolves outside node_modules", async () => {
    const target = join(paths.worktree, "tools", "outside.js");
    executable(target, "#!/usr/bin/env node\nconsole.log('must-not-run')\n");
    const bin = join(paths.worktree, "node_modules", ".bin", "outside");
    symlinkSync("../../tools/outside.js", bin);

    const result = await runSandboxed({
      argv: [bin], cwd: paths.worktree, paths, timeoutMs: 10_000, maxOutputBytes: 65_536,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("must-not-run");
    expect(result.stderr + result.stdout).toMatch(/operation not permitted|not permitted/i);
  });

  it("still rejects a newly executable file elsewhere in the worktree", async () => {
    const target = join(paths.worktree, "direct.js");
    executable(target, "#!/usr/bin/env node\nconsole.log('must-not-run')\n");

    const result = await runSandboxed({
      argv: [target], cwd: paths.worktree, paths, timeoutMs: 10_000, maxOutputBytes: 65_536,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("must-not-run");
    expect(result.stderr + result.stdout).toMatch(/operation not permitted|not permitted/i);
  });
});
