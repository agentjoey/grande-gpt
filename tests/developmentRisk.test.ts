import { describe, expect, it } from "vitest";
import { classifyDevelopmentRisk } from "../src/developmentRisk.ts";
import { classifyHostVerification } from "../src/hostVerification.ts";

describe("Phase 8 development risk classifier", () => {
  it("classifies documentation and non-runtime assets as L1", () => {
    expect(classifyDevelopmentRisk(["README.md", "docs/runbook.md", "assets/logo.svg"])).toBe("L1");
  });

  it("classifies ordinary source, ordinary tests and schema text as L2", () => {
    expect(classifyDevelopmentRisk(["src/envelope.ts"])).toBe("L2");
    expect(classifyDevelopmentRisk(["tests/envelope.test.ts"])).toBe("L2");
    expect(classifyDevelopmentRisk(["schemas/tool-contract.json"])).toBe("L2");
  });

  it("classifies security/runtime boundaries as L3", () => {
    for (const file of [
      "src/runner.ts",
      "src/prLifecycle.ts",
      "src/hostVerification.ts",
      "tests/host/server.host.test.ts",
      "vitest.host.config.ts",
    ]) {
      expect(classifyDevelopmentRisk([file]), file).toBe("L3");
    }
  });

  it("fails closed to L3 for unknown paths and escalates mixed changes", () => {
    expect(classifyDevelopmentRisk(["scripts/release.ts"])).toBe("L3");
    expect(classifyDevelopmentRisk(["README.md", "src/envelope.ts"])).toBe("L2");
    expect(classifyDevelopmentRisk(["src/envelope.ts", "src/runner.ts"])).toBe("L3");
  });

  it("stays aligned with the existing host gate: L1→none, L2→smoke, L3→full", () => {
    const cases = [
      { files: ["docs/phase8.md"], risk: "L1", host: "none" },
      { files: ["src/envelope.ts", "tests/envelope.test.ts"], risk: "L2", host: "smoke" },
      { files: ["src/tools.ts"], risk: "L3", host: "full" },
      { files: ["scripts/unknown-release-file"], risk: "L3", host: "full" },
    ] as const;

    for (const entry of cases) {
      expect(classifyDevelopmentRisk(entry.files), entry.files.join(",")).toBe(entry.risk);
      expect(classifyHostVerification(entry.files), entry.files.join(",")).toBe(entry.host);
    }
  });
});
