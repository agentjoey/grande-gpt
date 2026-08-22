export type HostVerificationLevel = "none" | "smoke" | "full";
export type RunnableHostVerificationLevel = Exclude<HostVerificationLevel, "none">;
export type HostManifestExecution = "auto" | "manualOnly";

export interface HostManifestEntry {
  file: string;
  reason: string;
  levels: readonly RunnableHostVerificationLevel[];
  execution: HostManifestExecution;
}

export interface HostVerificationPlan {
  level: HostVerificationLevel;
  autoFiles: string[];
  manualOnlyFiles: string[];
  manualOnlyRequired: boolean;
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
    reason: "Exercises real macOS Seatbelt behavior that requires its own sandbox boundary.",
    levels: ["full"],
    execution: "manualOnly",
  },
  {
    file: "tests/host/runner.host.test.ts",
    reason: "Exercises real sandboxed jobs, process groups, timeouts, and orphan cleanup.",
    levels: ["full"],
    execution: "manualOnly",
  },
  {
    file: "tests/host/server.host.test.ts",
    reason: "Retains the complete legacy Gateway host regression suite; some cases are not safe inside a second verifier boundary.",
    levels: ["full"],
    execution: "manualOnly",
  },
  {
    file: "tests/host/server-auto.host.test.ts",
    reason: "Auto-safe Gateway lifecycle smoke that consumes only the trusted parent loopback allocation.",
    levels: ["smoke", "full"],
    execution: "auto",
  },
  {
    file: "tests/host/tools.host.test.ts",
    reason: "Exercises tool handlers that start real jobs through the host sandbox boundary.",
    levels: ["smoke", "full"],
    execution: "manualOnly",
  },
  {
    file: "tests/host/e2e.host.test.ts",
    reason: "Exercises the complete request-to-run loop with real sandboxed host resources.",
    levels: ["full"],
    execution: "manualOnly",
  },
  {
    file: "tests/host/git-hook.host.test.ts",
    reason: "Proves a real Git hook executes normally and Safe Git suppresses it without creating a second Seatbelt boundary.",
    levels: ["full"],
    execution: "auto",
  },
  {
    file: "tests/host/verifier-sandbox.host.test.ts",
    reason: "Feasibility-proves the verifier Seatbelt itself from the unsandboxed trusted host layer.",
    levels: ["full"],
    execution: "manualOnly",
  },
  {
    file: "tests/host/verifier-runtime.host.test.ts",
    reason: "Validates the one-shot verifier from the trusted host layer, including exact-SHA execution and timeout/RSS process-group cleanup.",
    levels: ["full"],
    execution: "manualOnly",
  },
  {
    file: "tests/host/verifier-recovery.host.test.ts",
    reason: "Validates Gateway restart recovery for recorded verifier process groups and disposable resources from the trusted host layer.",
    levels: ["full"],
    execution: "manualOnly",
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
  "hostVerificationConfig.ts",
  "hostVerificationProduction.ts",
  "hostVerifier.ts",
  "hostVerifierRuntime.ts",
  "hostVerifierRecovery.ts",
  "hostVerifierSandbox.ts",
  "outerTest.ts",
  "outerTestReceipt.ts",
  "prLifecycle.ts",
  "prMergeD2.ts",
  "mergeReconcile.ts",
  "profiles.ts",
  "deployment.ts",
  "tools.ts",
]);

const MANUAL_ONLY_SOURCE_BASENAMES = new Set([
  "sandbox.ts",
  "sbpl.ts",
  "runner.ts",
  "jobs.ts",
  "hostVerification.ts",
  "hostVerificationConfig.ts",
  "hostVerificationProduction.ts",
  "hostVerifier.ts",
  "hostVerifierRuntime.ts",
  "hostVerifierRecovery.ts",
  "hostVerifierSandbox.ts",
  "profiles.ts",
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

function requiresManualOnly(file: string): boolean {
  if (file.startsWith("tests/host/")) {
    const entry = TRUSTED_HOST_MANIFEST.find((candidate) => candidate.file === file);
    return entry?.execution === "manualOnly";
  }
  if (file === "vitest.host.config.ts") return true;
  if (!file.startsWith("src/")) return false;
  return MANUAL_ONLY_SOURCE_BASENAMES.has(file.slice("src/".length));
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
    if (entry.execution !== "auto" && entry.execution !== "manualOnly") {
      throw new Error(`host manifest execution required: ${entry.file}`);
    }
  }
}

export function hostFilesForLevel(
  level: HostVerificationLevel,
  execution: HostManifestExecution | "all" = "all",
): string[] {
  if (level === "none") return [];
  validateHostManifest(TRUSTED_HOST_MANIFEST);
  return TRUSTED_HOST_MANIFEST
    .filter((entry) => entry.levels.includes(level))
    .filter((entry) => execution === "all" || entry.execution === execution)
    .map((entry) => entry.file);
}

export function planHostVerification(changedFiles: readonly string[]): HostVerificationPlan {
  const level = classifyHostVerification(changedFiles);
  if (level === "none") {
    return { level, autoFiles: [], manualOnlyFiles: [], manualOnlyRequired: false };
  }
  const manualOnlyRequired = changedFiles
    .map(normalizePath)
    .some(requiresManualOnly);
  return {
    level,
    autoFiles: hostFilesForLevel(level, "auto"),
    manualOnlyFiles: manualOnlyRequired ? hostFilesForLevel(level, "manualOnly") : [],
    manualOnlyRequired,
  };
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
