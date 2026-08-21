import { describe, expect, it } from "vitest";
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
      "src/jobs.ts",
      "src/gitExec.ts",
      "src/githubAuth.ts",
      "src/server.ts",
      "src/hostVerification.ts",
      "src/hostVerifierSandbox.ts",
      "src/outerTestReceipt.ts",
      "src/prLifecycle.ts",
      "src/profiles.ts",
      "tests/host/verifier-sandbox.host.test.ts",
    ]) {
      expect(classifyHostVerification([file]), file).toBe("full");
    }
  });

  it("fails safe to full for unknown production paths and escalates mixed changes", () => {
    expect(classifyHostVerification(["scripts/release.ts"])).toBe("full");
    expect(classifyHostVerification(["README.md", "src/envelope.ts"])).toBe("smoke");
    expect(classifyHostVerification(["src/envelope.ts", "src/runner.ts"])).toBe("full");
  });
});

describe("trusted host manifest", () => {
  it("contains only fixed host test files with reasons and smoke/full levels", () => {
    expect(() => validateHostManifest(TRUSTED_HOST_MANIFEST)).not.toThrow();
    expect(TRUSTED_HOST_MANIFEST.length).toBeGreaterThan(0);
    for (const entry of TRUSTED_HOST_MANIFEST) {
      expect(entry.file).toMatch(/^tests\/host\/.*\.host\.test\.ts$/);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(entry.levels.length).toBeGreaterThan(0);
      expect(entry.levels.every((level) => level === "smoke" || level === "full")).toBe(true);
    }
  });

  it("rejects duplicate files, blank reasons, and empty levels", () => {
    expect(() => validateHostManifest([
      { file: "tests/host/a.host.test.ts", reason: "a", levels: ["full"] },
      { file: "tests/host/a.host.test.ts", reason: "b", levels: ["full"] },
    ])).toThrow(/duplicate/i);
    expect(() => validateHostManifest([
      { file: "tests/host/a.host.test.ts", reason: " ", levels: ["full"] },
    ])).toThrow(/reason/i);
    expect(() => validateHostManifest([
      { file: "tests/host/a.host.test.ts", reason: "a", levels: [] },
    ])).toThrow(/level/i);
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
