import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Layout } from "./layout.ts";
import {
  capturePackageManagerIdentity,
  type ModernHostToolchainIdentity,
  type VerificationPackageManager,
} from "./packageManagerIdentity.ts";
import { resolveRepoPath } from "./paths.ts";
import { loadDepDirs } from "./profiles.ts";
import { registeredIds } from "./registry.ts";
import { defaultExecRoots, runSandboxed, type RunResult } from "./sandbox.ts";
import { copyDirectory } from "./directoryCopy.ts";

export const DEPENDENCY_BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;
export const DEPENDENCY_BOOTSTRAP_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEPENDENCY_BOOTSTRAP_MAX_RSS_MB = 4096;
const IDENTITY_MARKER = ".grande-dependency-identity.json";

export interface DependencyBootstrapIdentity extends ModernHostToolchainIdentity {
  repoId: string;
  platform: NodeJS.Platform;
  arch: string;
  key: string;
}

export interface DependencyRuntimeIdentity {
  platform: NodeJS.Platform;
  arch: string;
}

export interface PreparedDependencyResult {
  identity: DependencyBootstrapIdentity;
  source: "existing" | "cache" | "bootstrap";
  cacheDir: string;
  runResult?: RunResult;
}

export type DependencyBootstrapSandboxRunner = typeof runSandboxed;

export class DependencyBootstrapFailure extends Error {
  readonly identity: DependencyBootstrapIdentity;
  readonly result: RunResult;
  constructor(identity: DependencyBootstrapIdentity, result: RunResult) {
    const reason = result.killedBy
      ? `killedBy=${result.killedBy}`
      : `exitCode=${result.exitCode ?? "null"}`;
    super(`dependency bootstrap failed for ${identity.repoId}/${identity.packageManager}: ${reason}`);
    this.name = "DependencyBootstrapFailure";
    this.identity = identity;
    this.result = result;
  }
}

export class DependencyBootstrapIdentityDrift extends Error {
  readonly expected: DependencyBootstrapIdentity;
  readonly actual: DependencyBootstrapIdentity;
  constructor(expected: DependencyBootstrapIdentity, actual: DependencyBootstrapIdentity) {
    super(`dependency bootstrap identity drift for ${expected.repoId}: expected ${expected.key}, got ${actual.key}`);
    this.name = "DependencyBootstrapIdentityDrift";
    this.expected = expected;
    this.actual = actual;
  }
}

function identityPayload(
  repoId: string,
  toolchain: ModernHostToolchainIdentity,
  runtime: DependencyRuntimeIdentity,
): Omit<DependencyBootstrapIdentity, "key"> {
  return {
    repoId,
    node: toolchain.node,
    packageManager: toolchain.packageManager,
    packageManagerVersion: toolchain.packageManagerVersion,
    lockfile: toolchain.lockfile,
    lockfileSha256: toolchain.lockfileSha256,
    platform: runtime.platform,
    arch: runtime.arch,
  };
}

export function buildDependencyBootstrapIdentity(
  repoId: string,
  toolchain: ModernHostToolchainIdentity,
  runtime: DependencyRuntimeIdentity = { platform: process.platform, arch: process.arch },
): DependencyBootstrapIdentity {
  const payload = identityPayload(repoId, toolchain, runtime);
  const key = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...payload, key };
}

export function captureDependencyBootstrapIdentity(repoId: string, repoRoot: string): DependencyBootstrapIdentity {
  return buildDependencyBootstrapIdentity(repoId, capturePackageManagerIdentity(repoRoot));
}

export function dependencyInstallArgv(manager: VerificationPackageManager): string[] {
  return manager === "npm"
    ? ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
    : ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"];
}

export function dependencyCacheDir(layout: Layout, identity: DependencyBootstrapIdentity): string {
  return join(layout.derivedRoot, "dependency-cache", identity.repoId, identity.key);
}

function nodeModules(root: string): string {
  return join(root, "node_modules");
}

function markerPath(root: string): string {
  return join(nodeModules(root), IDENTITY_MARKER);
}

function markerBody(identity: DependencyBootstrapIdentity): string {
  return JSON.stringify(identity) + "\n";
}

function markerMatches(root: string, identity: DependencyBootstrapIdentity): boolean {
  const marker = markerPath(root);
  if (!existsSync(nodeModules(root)) || !existsSync(marker)) return false;
  try {
    return readFileSync(marker, "utf8") === markerBody(identity);
  } catch {
    return false;
  }
}

function cloneDirectory(source: string, destination: string): void {
  copyDirectory(source, destination);
}

export function preparedDependenciesPresent(root: string, identity: DependencyBootstrapIdentity): boolean {
  return markerMatches(root, identity);
}

export function preparedDependencyCachePresent(layout: Layout, identity: DependencyBootstrapIdentity): boolean {
  return markerMatches(dependencyCacheDir(layout, identity), identity);
}

export function publishPreparedDependencies(
  layout: Layout,
  identity: DependencyBootstrapIdentity,
  sourceRoot: string,
): string {
  const sourceModules = nodeModules(sourceRoot);
  if (!existsSync(sourceModules)) throw new Error(`dependency bootstrap produced no node_modules for ${identity.repoId}`);

  // The marker lives inside ignored node_modules, never in the tracked worktree. It binds both
  // the task copy and every cache copy to the exact manager/lockfile/runtime identity.
  const sourceWasMarked = markerMatches(sourceRoot, identity);
  if (!sourceWasMarked) writeFileSync(markerPath(sourceRoot), markerBody(identity), "utf8");

  const finalDir = dependencyCacheDir(layout, identity);
  if (markerMatches(finalDir, identity)) return finalDir;
  const parent = join(layout.derivedRoot, "dependency-cache", identity.repoId);
  mkdirSync(parent, { recursive: true });
  const staging = `${finalDir}.tmp-${randomUUID()}`;
  mkdirSync(staging, { recursive: true });
  try {
    cloneDirectory(sourceModules, nodeModules(staging));
    if (markerMatches(finalDir, identity)) {
      rmSync(staging, { recursive: true, force: true });
      return finalDir;
    }
    try {
      renameSync(staging, finalDir);
    } catch (error) {
      // Concurrent identical bootstraps may race to publish. A complete matching winner is fine;
      // anything else remains a real cache publication failure.
      if (!markerMatches(finalDir, identity)) throw error;
      rmSync(staging, { recursive: true, force: true });
    }
    return finalDir;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!sourceWasMarked) rmSync(markerPath(sourceRoot), { force: true });
    throw error;
  }
}

export function materializePreparedDependencies(
  layout: Layout,
  identity: DependencyBootstrapIdentity,
  targetRoot: string,
): boolean {
  if (markerMatches(targetRoot, identity)) return true;
  const cacheRoot = dependencyCacheDir(layout, identity);
  if (!markerMatches(cacheRoot, identity)) return false;

  const targetModules = nodeModules(targetRoot);
  const stagingRoot = join(targetRoot, `.grande-dependency-stage-${randomUUID()}`);
  const backupModules = join(targetRoot, `.grande-dependency-backup-${randomUUID()}`);
  mkdirSync(stagingRoot, { recursive: true });
  let backedUp = false;
  try {
    cloneDirectory(nodeModules(cacheRoot), nodeModules(stagingRoot));
    if (!markerMatches(stagingRoot, identity)) {
      throw new Error(`materialized dependency cache identity mismatch for ${identity.repoId}`);
    }
    if (existsSync(targetModules)) {
      renameSync(targetModules, backupModules);
      backedUp = true;
    }
    renameSync(nodeModules(stagingRoot), targetModules);
    backedUp = false;
    try {
      rmSync(backupModules, { recursive: true, force: true });
    } catch (error) {
      console.error(`[dependency-bootstrap] failed to remove replaced dependency backup ${backupModules}`, error);
    }
    return true;
  } catch (error) {
    if (backedUp && !existsSync(targetModules)) {
      renameSync(backupModules, targetModules);
      backedUp = false;
    }
    throw error;
  } finally {
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch (error) {
      console.error(`[dependency-bootstrap] failed to remove staging directory ${stagingRoot}`, error);
    }
    if (!backedUp) {
      try {
        rmSync(backupModules, { recursive: true, force: true });
      } catch (error) {
        console.error(`[dependency-bootstrap] failed to remove backup directory ${backupModules}`, error);
      }
    }
  }
}

export function repoRequiresDependencyBootstrap(layout: Layout, repoId: string): boolean {
  return loadDepDirs(layout, repoId).includes("node_modules");
}

export function profileRequiresDependencyBootstrap(
  layout: Layout,
  repoId: string,
  worktreeRoot: string,
  profileArgv: readonly string[],
): boolean {
  if (repoRequiresDependencyBootstrap(layout, repoId)) return true;
  if (!existsSync(join(worktreeRoot, "package.json"))) return false;
  if (profileArgv[0] === "npm") return existsSync(join(worktreeRoot, "package-lock.json"));
  if (profileArgv[0] === "pnpm") return existsSync(join(worktreeRoot, "pnpm-lock.yaml"));
  return false;
}

function assertStableDependencyIdentity(
  repoId: string,
  worktree: string,
  expected: DependencyBootstrapIdentity,
): void {
  const actual = captureDependencyBootstrapIdentity(repoId, worktree);
  if (actual.key === expected.key) return;
  rmSync(nodeModules(worktree), { recursive: true, force: true });
  throw new DependencyBootstrapIdentityDrift(expected, actual);
}

export async function prepareDependenciesInWorktree(input: {
  layout: Layout;
  repoId: string;
  worktreePath: string;
  jobTmp: string;
  onSpawn?: (pgid: number) => void;
  sandboxRunner?: DependencyBootstrapSandboxRunner;
}): Promise<PreparedDependencyResult> {
  const { layout, repoId } = input;
  const worktree = realpathSync(input.worktreePath);
  const identity = captureDependencyBootstrapIdentity(repoId, worktree);
  const cacheDir = dependencyCacheDir(layout, identity);

  if (preparedDependenciesPresent(worktree, identity)) {
    assertStableDependencyIdentity(repoId, worktree, identity);
    return { identity, source: "existing", cacheDir };
  }
  if (materializePreparedDependencies(layout, identity, worktree)) {
    assertStableDependencyIdentity(repoId, worktree, identity);
    return { identity, source: "cache", cacheDir };
  }

  const canonicalRepo = resolveRepoPath(layout, repoId, registeredIds(layout));
  mkdirSync(input.jobTmp, { recursive: true });
  const result = await (input.sandboxRunner ?? runSandboxed)({
    argv: dependencyInstallArgv(identity.packageManager),
    cwd: worktree,
    paths: {
      worktree,
      canonicalGit: join(canonicalRepo, ".git"),
      jobTmp: input.jobTmp,
      controlRoot: layout.controlRoot,
      worktreesRoot: layout.worktreesRoot,
      execRoots: defaultExecRoots(),
    },
    networkPolicy: "package-manager-bootstrap",
    timeoutMs: DEPENDENCY_BOOTSTRAP_TIMEOUT_MS,
    maxOutputBytes: DEPENDENCY_BOOTSTRAP_MAX_OUTPUT_BYTES,
    maxRssMb: DEPENDENCY_BOOTSTRAP_MAX_RSS_MB,
    onSpawn: input.onSpawn,
  });

  if (result.exitCode !== 0 || result.killedBy !== null) {
    rmSync(nodeModules(worktree), { recursive: true, force: true });
    throw new DependencyBootstrapFailure(identity, result);
  }

  assertStableDependencyIdentity(repoId, worktree, identity);
  mkdirSync(nodeModules(worktree), { recursive: true });
  publishPreparedDependencies(layout, identity, worktree);
  return { identity, source: "bootstrap", cacheDir, runResult: result };
}
