import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_HOST_ADAPTERS,
  TRUSTED_HOST_MANIFEST,
  validateHostCoverage,
} from "../src/hostVerification.ts";

const root = process.cwd();
const hostDir = join(root, "tests", "host");

function hostFilesOnDisk(): string[] {
  if (!existsSync(hostDir)) return [];
  return readdirSync(hostDir)
    .filter((name) => name.endsWith(".host.test.ts"))
    .map((name) => `tests/host/${name}`)
    .sort();
}

function projectTests(): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(rel);
    }
  };
  walk(join(root, "tests"), "tests");
  return files.sort();
}

describe("host manifest coverage contract", () => {
  it("registers every host test on disk and every manifest file exists", () => {
    const manifestFiles = TRUSTED_HOST_MANIFEST.map((entry) => entry.file).sort();
    expect(manifestFiles).toEqual(hostFilesOnDisk());
    for (const file of manifestFiles) expect(existsSync(join(root, file)), file).toBe(true);
  });

  it("maps every legacy unit-selfhost exclusion to a trusted host adapter", () => {
    const legacyExcluded = [
      "tests/sandbox.test.ts",
      "tests/runner.test.ts",
      "tests/server.test.ts",
      "tests/tools.test.ts",
      "tests/e2e.test.ts",
    ];
    expect(Object.keys(LEGACY_HOST_ADAPTERS).sort()).toEqual(legacyExcluded.sort());
    expect(() => validateHostCoverage({
      allProjectTests: projectTests(),
      unitSelfhostExcluded: legacyExcluded,
    })).not.toThrow();
  });

  it("fails closed when an excluded test or host file is not covered", () => {
    expect(() => validateHostCoverage({
      allProjectTests: ["tests/unknown.test.ts"],
      unitSelfhostExcluded: ["tests/unknown.test.ts"],
    })).toThrow(/uncovered|exclude/i);
  });
});
