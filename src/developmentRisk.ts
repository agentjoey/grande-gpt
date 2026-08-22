export type DevelopmentRiskLevel = "L1" | "L2" | "L3";

const L3_SOURCE_BASENAMES = new Set([
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
  "hostVerifierSoak.ts",
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

function isL1(file: string): boolean {
  return file.startsWith("docs/") || DOC_ROOT_FILES.has(file) || file.startsWith("assets/");
}

function isL3(file: string): boolean {
  if (file.startsWith("tests/host/")) return true;
  if (file === "vitest.config.ts" || file === "vitest.host.config.ts") return true;
  if (!file.startsWith("src/")) return false;
  return L3_SOURCE_BASENAMES.has(file.slice("src/".length));
}

function isL2(file: string): boolean {
  if (file.startsWith("src/") && file.endsWith(".ts")) return true;
  if (file.startsWith("tests/") && file.endsWith(".test.ts")) return true;
  if ((file.startsWith("schema/") || file.startsWith("schemas/")) && /\.(?:json|ya?ml|txt)$/u.test(file)) return true;
  return false;
}

/**
 * Phase 8 development-risk policy.
 *
 * L1: documentation/non-runtime resources.
 * L2: ordinary source/tests/schema text that do not touch a trusted runtime boundary.
 * L3: sandbox/runner/Git/auth/Gateway/verifier/receipt/merge/deployment boundaries,
 *     host tests/config, or anything unknown. Unknown intentionally fails closed to L3.
 */
export function classifyDevelopmentRisk(changedFiles: readonly string[]): DevelopmentRiskLevel {
  let level: DevelopmentRiskLevel = "L1";
  for (const raw of changedFiles) {
    const file = normalizePath(raw);
    if (isL1(file)) continue;
    if (isL3(file)) return "L3";
    if (isL2(file)) {
      level = "L2";
      continue;
    }
    return "L3";
  }
  return level;
}
