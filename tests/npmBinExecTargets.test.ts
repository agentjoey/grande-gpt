import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorktreeBinExecTargets } from "../src/sandbox.ts";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("GG-BL-027 npm .bin target discovery", () => {
  it("returns only symlink targets that resolve to files inside this worktree node_modules", () => {
    root = mkdtempSync(join(tmpdir(), "npm-bin-targets-"));
    const worktree = join(root, "worktree");
    const binDir = join(worktree, "node_modules", ".bin");
    const inside = join(worktree, "node_modules", "demo", "bin", "cli.js");
    const outside = join(worktree, "tools", "outside.js");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(inside, ".."), { recursive: true });
    mkdirSync(join(outside, ".."), { recursive: true });
    writeFileSync(inside, "#!/usr/bin/env node\n", "utf8");
    writeFileSync(outside, "#!/usr/bin/env node\n", "utf8");
    symlinkSync("../demo/bin/cli.js", join(binDir, "inside"));
    symlinkSync("../../tools/outside.js", join(binDir, "outside"));

    expect(resolveWorktreeBinExecTargets(worktree)).toEqual([realpathSync(inside)]);
  });

  it("returns an empty list when node_modules/.bin is absent", () => {
    root = mkdtempSync(join(tmpdir(), "npm-bin-targets-empty-"));
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    expect(resolveWorktreeBinExecTargets(worktree)).toEqual([]);
  });
});
