import { describe, expect, it } from "vitest";
import * as hostVerification from "../src/hostVerification.ts";
import {
  classifyHostVerification,
  hostFilesForLevel,
  TRUSTED_HOST_MANIFEST,
  validateHostManifest,
} from "../src/hostVerification.ts";

describe("host verification classifier", () => {
  it("classifies docs-only and non-runtime assets as none", () => {
    expect(classifyHostVerification(["README.md", "docs/runbook.md", "docs/research/note.txt"])).toBe("none");
  });

  it("classifies ordinary production source, tests, and schema text as smoke", () => {
    expect(classifyHostVerification(["src/envelope.ts"])).toBe("smoke");
    expect(classifyHostVerification(["tests/envelope.test.ts"])).toBe("smoke");
    expect(classifyHostVerification(["schemas/tool-contract.json"])).toBe("smoke");
  });

  it("classifies security/lifecycle/verifier surfaces as full", () => {
    for (const file of [
      "src/sandbox.ts",
      "src/sbpl.ts",
      "src/runner.ts",
      "src/deploymentHostRunner.ts",
      "src/jobs.ts",
      "src/gitExec.ts",
      "src/githubAuth.ts",
      "src/server.ts",
      "src/hostVerification.ts",
      "src/hostVerificationConfig.ts",
      "src/hostVerificationProduction.ts",
      "src/hostVerifierSoak.ts",
      "src/hostVerifier.ts",
      "src/hostVerifierRuntime.ts",
      "src/hostVerifierRecovery.ts",
      "src/hostVerifierSandbox.ts",
      "src/outerTestReceipt.ts",
      "src/prLifecycle.ts",
      "src/prMergeD2.ts",
      "src/mergeReconcile.ts",
      "src/profiles.ts",
      "tests/host/deployment-host-runner.host.test.ts",
      "tests/host/verifier-sandbox.host.test.ts",
      "tests/host/verifier-runtime.host.test.ts",
      "tests/host/verifier-recovery.host.test.ts",
    ]) {
      expect(classifyHostVerification([file]), file).toBe("full");
    }
  });

  it("fails safe to full for unknown production paths and escalates mixed changes", () => {
    expect(classifyHostVerification(["scripts/release.ts"])).toBe("full");
    expect(classifyHostVerification(["README.md", "src/envelope.ts"])).toBe("smoke");
    expect(classifyHostVerification(["src/envelope.ts", "src/runner.ts"])).toBe("full");
  });

  it("plans recursive-Seatbelt and verifier-policy changes as predefined manual-only Human Gates", () => {
    const planHostVerification = (hostVerification as unknown as {
      planHostVerification?: (files: readonly string[]) => {
        level: "none" | "smoke" | "full";
        autoFiles: string[];
        manualOnlyFiles: string[];
        manualOnlyRequired: boolean;
      };
    }).planHostVerification;
    expect(planHostVerification).toBeTypeOf("function");
    if (!planHostVerification) return;

    expect(planHostVerification(["README.md"])).toEqual({
      level: "none",
      autoFiles: [],
      manualOnlyFiles: [],
      manualOnlyRequired: false,
    });
    expect(planHostVerification(["src/envelope.ts"])).toMatchObject({
      level: "smoke",
      manualOnlyRequired: false,
      manualOnlyFiles: [],
    });
    const safeGitPlan = planHostVerification(["src/gitExec.ts"]);
    expect(safeGitPlan).toMatchObject({
      level: "full",
      manualOnlyRequired: false,
      manualOnlyFiles: [],
    });
    expect(safeGitPlan.autoFiles).toContain("tests/host/git-hook.host.test.ts");
    for (const file of [
      "src/sandbox.ts",
      "src/sbpl.ts",
      "src/runner.ts",
      "src/deploymentHostRunner.ts",
      "src/jobs.ts",
      "src/hostVerification.ts",
      "src/hostVerificationConfig.ts",
      "src/hostVerificationProduction.ts",
      "src/hostVerifierSoak.ts",
      "src/hostVerifier.ts",
      "src/hostVerifierRuntime.ts",
      "src/hostVerifierRecovery.ts",
      "src/hostVerifierSandbox.ts",
      "src/tools.ts",
      "tests/host/sandbox.host.test.ts",
      "tests/host/deployment-host-runner.host.test.ts",
      "tests/host/verifier-sandbox.host.test.ts",
      "tests/host/verifier-runtime.host.test.ts",
      "tests/host/verifier-recovery.host.test.ts",
    ]) {
      const plan = planHostVerification([file]);
      expect(plan.level, file).toBe("full");
      expect(plan.manualOnlyRequired, file).toBe(true);
      expect(plan.manualOnlyFiles.length, file).toBeGreaterThan(0);
      expect(plan.autoFiles, file).not.toContain("tests/host/sandbox.host.test.ts");
      expect(plan.autoFiles, file).not.toContain("tests/host/deployment-host-runner.host.test.ts");
      expect(plan.autoFiles, file).not.toContain("tests/host/verifier-runtime.host.test.ts");
      expect(plan.autoFiles, file).not.toContain("tests/host/verifier-recovery.host.test.ts");
    }
    expect(planHostVerification(["src/deploymentHostRunner.ts"]).manualOnlyFiles).toContain(
      "tests/host/deployment-host-runner.host.test.ts",
    );
  });
});

describe("trusted host manifest", () => {
  it("contains only fixed host test files with reasons, levels, and trusted execution mode", () => {
    expect(() => validateHostManifest(TRUSTED_HOST_MANIFEST)).not.toThrow();
    expect(TRUSTED_HOST_MANIFEST.length).toBeGreaterThan(0);
    for (const entry of TRUSTED_HOST_MANIFEST) {
      expect(entry.file).toMatch(/^tests\/host\/.*\.host\.test\.ts$/);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.levels.length).toBeGreaterThan(0);
      expect(entry.levels.every((level) => level === "smoke" || level === "full")).toBe(true);
      expect(["auto", "manualOnly"]).toContain(entry.execution);
    }
  });

  it("marks host cases that would create or validate the verifier boundary manual-only", () => {
    const byFile = new Map(TRUSTED_HOST_MANIFEST.map((entry) => [entry.file, entry]));
    for (const file of [
      "tests/host/sandbox.host.test.ts",
      "tests/host/runner.host.test.ts",
      "tests/host/deployment-host-runner.host.test.ts",
      "tests/host/server.host.test.ts",
      "tests/host/tools.host.test.ts",
      "tests/host/e2e.host.test.ts",
      "tests/host/verifier-sandbox.host.test.ts",
      "tests/host/verifier-runtime.host.test.ts",
      "tests/host/verifier-recovery.host.test.ts",
    ]) {
      expect(byFile.get(file)?.execution, file).toBe("manualOnly");
    }
    expect(byFile.get("tests/host/server-auto.host.test.ts")?.execution).toBe("auto");
    expect(byFile.get("tests/host/git-hook.host.test.ts")?.execution).toBe("auto");
  });

  it("rejects duplicate files, blank reasons, and empty levels", () => {
    expect(() => validateHostManifest([
      { file: "tests/host/a.host.test.ts", reason: "a", levels: ["full"], execution: "auto" },
      { file: "tests/host/a.host.test.ts", reason: "b", levels: ["full"], execution: "auto" },
    ])).toThrow(/duplicate/i);
    expect(() => validateHostManifest([
      { file: "tests/host/a.host.test.ts", reason: " ", levels: ["full"], execution: "auto" },
    ])).toThrow(/reason/i);
    expect(() => validateHostManifest([
      { file: "tests/host/a.host.test.ts", reason: "a", levels: [], execution: "auto" },
    ])).toThrow(/level/i);
  });

  it("selects auto-safe files separately from manual-only files", () => {
    const full = hostFilesForLevel("full");
    const auto = hostFilesForLevel("full", "auto");
    const manualOnly = hostFilesForLevel("full", "manualOnly");
    expect(auto).toContain("tests/host/server-auto.host.test.ts");
    expect(auto).toContain("tests/host/git-hook.host.test.ts");
    expect(auto).not.toContain("tests/host/server.host.test.ts");
    expect(auto).not.toContain("tests/host/sandbox.host.test.ts");
    expect(auto).not.toContain("tests/host/deployment-host-runner.host.test.ts");
    expect(auto).not.toContain("tests/host/verifier-sandbox.host.test.ts");
    expect(auto).not.toContain("tests/host/verifier-runtime.host.test.ts");
    expect(auto).not.toContain("tests/host/verifier-recovery.host.test.ts");
    expect(manualOnly).toContain("tests/host/server.host.test.ts");
    expect(manualOnly).toContain("tests/host/sandbox.host.test.ts");
    expect(manualOnly).toContain("tests/host/runner.host.test.ts");
    expect(manualOnly).toContain("tests/host/deployment-host-runner.host.test.ts");
    expect(manualOnly).toContain("tests/host/verifier-sandbox.host.test.ts");
    expect(manualOnly).toContain("tests/host/verifier-runtime.host.test.ts");
    expect(manualOnly).toContain("tests/host/verifier-recovery.host.test.ts");
    expect(new Set([...auto, ...manualOnly])).toEqual(new Set(full));
  });

  it("selects a bounded smoke subset while full contains all full entries", () => {
    const smoke = hostFilesForLevel("smoke");
    const full = hostFilesForLevel("full");
    expect(smoke.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThanOrEqual(smoke.length);
    expect(smoke.every((file) => full.includes(file))).toBe(true);
    expect(hostFilesForLevel("none")).toEqual([]);
  });
});
