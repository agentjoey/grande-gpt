import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import { repoRequiresDependencyBootstrap } from "../src/dependencyBootstrap.ts";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function layoutAt(base: string): Layout {
  return {
    workspaceRoot: join(base, "workspace"),
    controlRoot: join(base, "control"),
    stateDb: join(base, "control", "state", "grande.db"),
    configDir: join(base, "control", "config"),
    reposConfig: join(base, "control", "config", "repos.yaml"),
    artifactsDir: join(base, "control", "artifacts"),
    derivedRoot: join(base, "workspace", ".grande-work"),
    worktreesRoot: join(base, "workspace", ".grande-work", "worktrees"),
  };
}

function writeRegisteredRepo(layout: Layout, withLockfile: boolean): string {
  const repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(layout.configDir, { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
  writeFileSync(join(layout.configDir, "profiles.yaml"), "repos: {}\n", "utf8");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }) + "\n", "utf8");
  if (withLockfile) {
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "demo", version: "1.0.0" } },
      }, null, 2) + "\n",
      "utf8",
    );
  }
  return repo;
}

describe("GG-BL-031 bootstrap trigger", () => {
  it("requires dependency bootstrap for a supported lockfile even without depDirs opt-in", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-trigger-"));
    const layout = layoutAt(root);
    writeRegisteredRepo(layout, true);

    expect(repoRequiresDependencyBootstrap(layout, "demo")).toBe(true);
  });

  it("does not broaden bootstrap to repositories without a supported lockfile", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-trigger-none-"));
    const layout = layoutAt(root);
    writeRegisteredRepo(layout, false);

    expect(repoRequiresDependencyBootstrap(layout, "demo")).toBe(false);
  });
});
