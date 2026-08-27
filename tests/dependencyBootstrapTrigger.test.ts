import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import { profileRequiresDependencyBootstrap } from "../src/dependencyBootstrap.ts";

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

function writeRegisteredRepo(layout: Layout, manager: "npm" | "pnpm" | "none"): void {
  const repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(layout.configDir, { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
  writeFileSync(join(layout.configDir, "profiles.yaml"), "repos: {}\n", "utf8");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }) + "\n", "utf8");
  if (manager === "npm") {
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "demo", version: "1.0.0" } } }, null, 2) + "\n",
      "utf8",
    );
  }
  if (manager === "pnpm") writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
}

describe("GG-BL-031 profile-aware bootstrap trigger", () => {
  it("auto-triggers for an npm profile when the registered repo has package-lock.json and no depDirs opt-in", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-trigger-npm-"));
    const layout = layoutAt(root);
    writeRegisteredRepo(layout, "npm");

    expect(profileRequiresDependencyBootstrap(layout, "demo", ["npm", "test"])).toBe(true);
  });

  it("auto-triggers for a pnpm profile when the registered repo has pnpm-lock.yaml and no depDirs opt-in", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-trigger-pnpm-"));
    const layout = layoutAt(root);
    writeRegisteredRepo(layout, "pnpm");

    expect(profileRequiresDependencyBootstrap(layout, "demo", ["pnpm", "test"])).toBe(true);
  });

  it("does not auto-trigger a non-package-manager profile merely because the repo has a lockfile", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-trigger-plain-"));
    const layout = layoutAt(root);
    writeRegisteredRepo(layout, "npm");

    expect(profileRequiresDependencyBootstrap(layout, "demo", ["/usr/bin/true"])).toBe(false);
  });

  it("preserves explicit depDirs node_modules opt-in for non-package-manager profiles", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-trigger-explicit-"));
    const layout = layoutAt(root);
    writeRegisteredRepo(layout, "none");
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      "depDirs:\n  demo: [\"node_modules\"]\nrepos: {}\n",
      "utf8",
    );

    expect(profileRequiresDependencyBootstrap(layout, "demo", ["/usr/bin/true"])).toBe(true);
  });
});
