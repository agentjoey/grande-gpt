import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import {
  captureDependencyBootstrapIdentity,
  dependencyCacheDir,
  repoRequiresDependencyBootstrap,
  seedPreparedDependenciesFromCanonical,
} from "../src/dependencyBootstrap.ts";

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

function writeNpmIdentityFiles(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }) + "\n", "utf8");
  writeFileSync(
    join(dir, "package-lock.json"),
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

describe("GG-BL-031 bootstrap trigger and canonical seed", () => {
  it("requires dependency bootstrap for a supported lockfile even without depDirs opt-in", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-trigger-"));
    const layout = layoutAt(root);
    const repo = join(root, "repo");
    writeNpmIdentityFiles(repo);
    mkdirSync(layout.configDir, { recursive: true });
    writeFileSync(join(layout.configDir, "profiles.yaml"), "repos: {}\n", "utf8");

    expect(repoRequiresDependencyBootstrap(layout, "demo", repo)).toBe(true);
  });

  it("does not broaden bootstrap to repositories without a supported lockfile", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-trigger-none-"));
    const layout = layoutAt(root);
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }) + "\n", "utf8");
    mkdirSync(layout.configDir, { recursive: true });
    writeFileSync(join(layout.configDir, "profiles.yaml"), "repos: {}\n", "utf8");

    expect(repoRequiresDependencyBootstrap(layout, "demo", repo)).toBe(false);
  });

  it("seeds the prepared cache from matching canonical dependencies without sharing mutable files", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-canonical-seed-"));
    const layout = layoutAt(root);
    const canonical = join(root, "canonical");
    const worktree = join(root, "worktree");
    writeNpmIdentityFiles(canonical);
    writeNpmIdentityFiles(worktree);
    mkdirSync(join(canonical, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(canonical, "node_modules", "pkg", "index.js"), "canonical\n", "utf8");

    const identity = captureDependencyBootstrapIdentity("demo", worktree);
    expect(seedPreparedDependenciesFromCanonical(layout, identity, canonical, worktree)).toBe(true);

    const cacheFile = join(dependencyCacheDir(layout, identity), "node_modules", "pkg", "index.js");
    const worktreeFile = join(worktree, "node_modules", "pkg", "index.js");
    expect(existsSync(cacheFile)).toBe(true);
    expect(readFileSync(worktreeFile, "utf8")).toBe("canonical\n");

    writeFileSync(worktreeFile, "changed\n", "utf8");
    expect(readFileSync(join(canonical, "node_modules", "pkg", "index.js"), "utf8")).toBe("canonical\n");
    expect(readFileSync(cacheFile, "utf8")).toBe("canonical\n");
  });
});
