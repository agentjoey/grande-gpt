export type HostVerificationLevel = "none" | "smoke" | "full";
export type RunnableHostVerificationLevel = Exclude<HostVerificationLevel, "none">;

export interface HostManifestEntry {
  file: string;
  reason: string;
  levels: readonly RunnableHostVerificationLevel[];
}

export const LEGACY_HOST_ADAPTERS = {
  "tests/sandbox.test.ts": "tests/host/sandbox.host.test.ts",
  "tests/runner.test.ts": "tests/host/runner.host.test.ts",
  "tests/server.test.ts": "tests/host/server.host.test.ts",
  "tests/tools.test.ts": "tests/host/tools.host.test.ts",
  "tests/e2e.test.ts": "tests/host/e2e.host.test.ts",
} as const;

export const TRUSTED_HOST_MANIFEST: readonly HostManifestEntry[] = [
  {
    file: "tests/host/sandbox.host.test.ts",
    reason: "Exercises real macOS Seatbelt behavior and nested process policy.",
    levels: ["full"],
  },
  {
    file: "tests/host/runner.host.test.ts",
    reason: "Exercises real sandboxed jobs, process groups, timeouts, and orphan cleanup.",
    levels: ["full"],
  },
  {
    file: "tests/host/server.host.test.ts",
    reason: "Exercises Gateway lifecycle and real loopback listener behavior.",
    levels: ["smoke", "full"],
  },
  {
    file: "tests/host/tools.host.test.ts",
    reason: "Exercises tool handlers that start real jobs through the host sandbox boundary.",
    levels: ["smoke", "full"],
  },
  {
    file: "tests/host/e2e.host.test.ts",
    reason: "Exercises the complete request-to-run loop with real host resources.",
    levels: ["full"],
  },
  {
    file: "tests/host/verifier-sandbox.host.test.ts",
    reason: "Proves verifier Seatbelt nesting, hook suppression, loopback isolation, sensitive-path denial, and process-group cleanup on the real host.",
    levels: ["full"],
  },
] as const;

const FULL_SOURCE_BASENAMES = new Set([
  "sandbox.ts",
  "sbpl.ts",
  "runner.ts",
  "jobs.ts",
  "gitExec.ts",
  "githubAuth.ts",
  "push.ts",
  "prOpen.ts",
  "canonicalGit.ts",
  "canonicalRefresh.ts",
  "syncBase.ts",
  "worktree.ts",
  "worktreeGc.ts",
  "server.ts",
  "main.ts",
  "hostVerification.ts",
  "hostVerifierSandbox.ts",
  "outerTest.ts",
  "outerTestReceipt.ts",
  "prLifecycle.ts",
  "profiles.ts",
  "deployment.ts",
  "tools.ts",
]);

const DOC_ROOT_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "LICENSE.md",
]);

function normalizePath(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isDocsOnly(file: string): boolean {
  return file.startsWith("docs/") || DOC_ROOT_FILES.has(file) || file.startsWith("assets/");
}

function isCritical(file: string): boolean {
  if (file.startsWith("tests/host/")) return true;
  if (file === "vitest.config.ts" || file === "vitest.host.config.ts") return true;
  if (!file.startsWith("src/")) return false;
  const base = file.slice("src/".length);
  return FULL_SOURCE_BASENAMES.has(base);
}

function isOrdinaryProduction(file: string): boolean {
  if (file.startsWith("src/") && file.endsWith(".ts")) return true;
  if (file.startsWith("tests/") && file.endsWith(".test.ts")) return true;
  if ((file.startsWith("schema/") || file.startsWith("schemas/")) && /\.(?:json|ya?ml|txt)$/u.test(file)) return true;
  return false;
}

export function classifyHostVerification(changedFiles: readonly string[]): HostVerificationLevel {
  let level: HostVerificationLevel = "none";
  for (const raw of changedFiles) {
    const file = normalizePath(raw);
    if (isDocsOnly(file)) continue;
    if (isCritical(file)) return "full";
    if (isOrdinaryProduction(file)) {
      level = "smoke";
      continue;
    }
    return "full";
  }
  return level;
}

export function validateHostManifest(manifest: readonly HostManifestEntry[]): void {
  const seen = new Set<string>();
  for (const entry of manifest) {
    if (!/^tests\/host\/[^/]+\.host\.test\.ts$/u.test(entry.file)) {
      throw new Error(`host manifest file must be tests/host/*.host.test.ts: ${entry.file}`);
    }
    if (seen.has(entry.file)) throw new Error(`duplicate host manifest file: ${entry.file}`);
    seen.add(entry.file);
    if (!entry.reason.trim()) throw new Error(`host manifest reason required: ${entry.file}`);
    if (entry.levels.length === 0) throw new Error(`host manifest level required: ${entry.file}`);
    const levels = new Set(entry.levels);
    if (levels.size !== entry.levels.length || [...levels].some((level) => level !== "smoke" && level !== "full")) {
      throw new Error(`invalid host manifest levels: ${entry.file}`);
    }
    if (!levels.has("full")) throw new Error(`host manifest full level required: ${entry.file}`);
  }
}

export function hostFilesForLevel(level: HostVerificationLevel): string[] {
  if (level === "none") return [];
  validateHostManifest(TRUSTED_HOST_MANIFEST);
  return TRUSTED_HOST_MANIFEST
    .filter((entry) => entry.levels.includes(level))
    .map((entry) => entry.file);
}

export function validateHostCoverage(input: {
  allProjectTests: readonly string[];
  unitSelfhostExcluded: readonly string[];
}): void {
  validateHostManifest(TRUSTED_HOST_MANIFEST);
  const manifestFiles = new Set(TRUSTED_HOST_MANIFEST.map((entry) => entry.file));
  for (const excludedRaw of input.unitSelfhostExcluded) {
    const excluded = normalizePath(excludedRaw);
    const adapter = (LEGACY_HOST_ADAPTERS as Record<string, string>)[excluded];
    if (!adapter || !manifestFiles.has(adapter)) {
      throw new Error(`uncovered unit-selfhost exclude: ${excluded}`);
    }
  }
  for (const raw of input.allProjectTests) {
    const file = normalizePath(raw);
    if (file.startsWith("tests/host/") && !manifestFiles.has(file)) {
      throw new Error(`uncovered host test: ${file}`);
    }
  }
}
