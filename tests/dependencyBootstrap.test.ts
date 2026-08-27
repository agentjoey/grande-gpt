import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import type { ModernHostToolchainIdentity } from "../src/packageManagerIdentity.ts";
import {
  DEPENDENCY_BOOTSTRAP_TIMEOUT_MS,
  buildDependencyBootstrapIdentity,
  dependencyCacheDir,
  dependencyInstallArgv,
  materializePreparedDependencies,
  publishPreparedDependencies,
} from "../src/dependencyBootstrap.ts";
import { defaultExecRoots, runSandboxed } from "../src/sandbox.ts";
import { buildProfile, type SandboxPaths } from "../src/sbpl.ts";

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

const npmToolchain: ModernHostToolchainIdentity = {
  node: "v24.14.0",
  packageManager: "npm",
  packageManagerVersion: "11.9.0",
  lockfile: "package-lock.json",
  lockfileSha256: "a".repeat(64),
};

const pnpmToolchain: ModernHostToolchainIdentity = {
  node: "v24.14.0",
  packageManager: "pnpm",
  packageManagerVersion: "10.33.0",
  lockfile: "pnpm-lock.yaml",
  lockfileSha256: "b".repeat(64),
};

describe("GG-BL-031 dependency bootstrap identity and cache", () => {
  it("keys prepared dependencies by repo + manager/lockfile + runtime/platform identity", () => {
    const a = buildDependencyBootstrapIdentity("alpha", npmToolchain, { platform: "darwin", arch: "arm64" });
    const same = buildDependencyBootstrapIdentity("alpha", npmToolchain, { platform: "darwin", arch: "arm64" });
    const otherRepo = buildDependencyBootstrapIdentity("beta", npmToolchain, { platform: "darwin", arch: "arm64" });
    const otherLock = buildDependencyBootstrapIdentity(
      "alpha",
      { ...npmToolchain, lockfileSha256: "c".repeat(64) },
      { platform: "darwin", arch: "arm64" },
    );
    const otherNode = buildDependencyBootstrapIdentity(
      "alpha",
      { ...npmToolchain, node: "v25.0.0" },
      { platform: "darwin", arch: "arm64" },
    );
    const otherArch = buildDependencyBootstrapIdentity("alpha", npmToolchain, { platform: "darwin", arch: "x64" });

    expect(a.key).toBe(same.key);
    expect(new Set([a.key, otherRepo.key, otherLock.key, otherNode.key, otherArch.key]).size).toBe(5);
    expect(a).toMatchObject({
      repoId: "alpha",
      packageManager: "npm",
      packageManagerVersion: "11.9.0",
      lockfile: "package-lock.json",
      lockfileSha256: "a".repeat(64),
      node: "v24.14.0",
      platform: "darwin",
      arch: "arm64",
    });
  });

  it("uses fixed install argv only and gives bootstrap a longer wall-clock budget", () => {
    expect(dependencyInstallArgv("npm")).toEqual(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    expect(dependencyInstallArgv("pnpm")).toEqual(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]);
    expect(DEPENDENCY_BOOTSTRAP_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it("publishes an isolated per-repo cache and materializes a copy without sharing mutable files", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-bootstrap-unit-"));
    const layout = layoutAt(root);
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

    const identity = buildDependencyBootstrapIdentity("alpha", npmToolchain, { platform: "darwin", arch: "arm64" });
    const cache = publishPreparedDependencies(layout, identity, source);
    expect(cache).toBe(dependencyCacheDir(layout, identity));
    expect(materializePreparedDependencies(layout, identity, target)).toBe(true);

    const targetFile = join(target, "node_modules", "pkg", "index.js");
    writeFileSync(targetFile, "module.exports = 999;\n", "utf8");
    expect(readFileSync(join(cache, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("does not reuse a cache entry after lockfile identity changes or across repos", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-bootstrap-stale-"));
    const layout = layoutAt(root);
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, "node_modules", "pkg", "index.js"), "ok\n", "utf8");

    const current = buildDependencyBootstrapIdentity("alpha", npmToolchain, { platform: "darwin", arch: "arm64" });
    publishPreparedDependencies(layout, current, source);

    const staleLock = buildDependencyBootstrapIdentity(
      "alpha",
      { ...npmToolchain, lockfileSha256: "d".repeat(64) },
      { platform: "darwin", arch: "arm64" },
    );
    const otherRepo = buildDependencyBootstrapIdentity("beta", npmToolchain, { platform: "darwin", arch: "arm64" });
    expect(materializePreparedDependencies(layout, staleLock, target)).toBe(false);
    expect(materializePreparedDependencies(layout, otherRepo, target)).toBe(false);
    expect(dependencyCacheDir(layout, current)).not.toBe(dependencyCacheDir(layout, otherRepo));
  });

  it("keeps the previous target intact when cache materialization fails partway", () => {
    root = mkdtempSync(join(tmpdir(), "dependency-bootstrap-atomic-target-"));
    const layout = layoutAt(root);
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(join(source, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(target, "node_modules", "previous"), { recursive: true });
    writeFileSync(join(source, "node_modules", "pkg", "index.js"), "new\n", "utf8");
    writeFileSync(join(target, "node_modules", "previous", "index.js"), "keep\n", "utf8");
    const identity = buildDependencyBootstrapIdentity("alpha", npmToolchain, { platform: "darwin", arch: "arm64" });
    const cache = publishPreparedDependencies(layout, identity, source);
    const unreadable = join(cache, "node_modules", "pkg");
    chmodSync(unreadable, 0);
    try {
      expect(() => materializePreparedDependencies(layout, identity, target)).toThrow();
      expect(readFileSync(join(target, "node_modules", "previous", "index.js"), "utf8")).toBe("keep\n");
      expect(existsSync(join(target, "node_modules", ".grande-dependency-identity.json"))).toBe(false);
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });

  it("keeps ordinary sandboxes offline and allows network only for the explicit package-manager bootstrap policy", () => {
    const paths: SandboxPaths = {
      worktree: "/tmp/grande/worktree",
      canonicalGit: "/tmp/grande/canonical/.git",
      jobTmp: "/tmp/grande/job",
      controlRoot: "/tmp/grande/control",
      worktreesRoot: "/tmp/grande/worktrees",
      execRoots: ["/usr/bin", "/bin"],
    };
    const ordinaryProfile = buildProfile(paths);
    expect(ordinaryProfile).toContain("(deny network*)");
    expect(ordinaryProfile).not.toContain('com.apple.SystemConfiguration.DNSConfiguration');
    expect(ordinaryProfile).not.toContain("process-exec-interpreter");
    const bootstrapProfile = buildProfile(
      { ...paths, bootstrapInterpreterTargets: ["/usr/bin/env"] },
      { network: "package-manager-bootstrap" },
    );
    expect(bootstrapProfile).toContain("(allow network*)");
    expect(bootstrapProfile).not.toContain("(deny network*)");
    expect(bootstrapProfile).toContain(
      '(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration"))',
    );
    expect(bootstrapProfile).toContain(
      '(allow process-exec-interpreter (literal "/usr/bin/env"))',
    );
  });

  it("resolves registry DNS inside the explicit package-manager bootstrap sandbox", async () => {
    if (process.platform !== "darwin") return;
    root = mkdtempSync(join(tmpdir(), "dependency-bootstrap-dns-"));
    const paths: SandboxPaths = {
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

    const result = await runSandboxed({
      argv: [
        process.execPath,
        "--input-type=module",
        "-e",
        "import { lookup } from 'node:dns'; lookup('registry.npmjs.org', (error) => { if (error) { console.error(error.code ?? error.message); process.exitCode = 1; return; } console.log('dns-ok'); });",
      ],
      cwd: paths.worktree,
      paths,
      networkPolicy: "package-manager-bootstrap",
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dns-ok");
  }, 15_000);

  it("does not broaden install argv when package-manager identity is pnpm", () => {
    const identity = buildDependencyBootstrapIdentity("alpha", pnpmToolchain, { platform: "darwin", arch: "arm64" });
    expect(identity.packageManager).toBe("pnpm");
    expect(dependencyInstallArgv(identity.packageManager)).toEqual([
      "pnpm", "install", "--frozen-lockfile", "--ignore-scripts",
    ]);
  });
});
