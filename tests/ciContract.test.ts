import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface PackageJson {
  engines?: { node?: string };
  packageManager?: string;
  scripts?: Record<string, string>;
}

const LEGACY_SELFHOST_EXCLUDES = [
  "tests/sandbox.test.ts",
  "tests/runner.test.ts",
  "tests/server.test.ts",
  "tests/tools.test.ts",
  "tests/e2e.test.ts",
] as const;

function pkg(): PackageJson {
  return JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as PackageJson;
}

function workflow(): string {
  return readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
}

describe("GG-BL-018 minimal independent CI contract", () => {
  it("pins the same Node/pnpm baseline used by GrandeGPT", () => {
    const value = pkg();
    expect(value.engines?.node).toBe(">=24 <25");
    expect(value.packageManager).toBe("pnpm@10.33.0");
  });

  it("exposes one deterministic selfhost-safe command with the five trusted legacy exclusions", () => {
    const command = pkg().scripts?.["test:selfhost-safe"];
    expect(command).toBeTypeOf("string");
    expect(command).toMatch(/^vitest run(?: --exclude tests\/[a-zA-Z0-9.-]+\.test\.ts){5}$/);
    for (const file of LEGACY_SELFHOST_EXCLUDES) {
      expect(command).toContain(`--exclude ${file}`);
    }
    expect((command!.match(/--exclude /g) ?? [])).toHaveLength(LEGACY_SELFHOST_EXCLUDES.length);
    expect(command).not.toContain("tests/host/");
  });

  it("has a focused public tool-contract check and one CI verify entry point", () => {
    const scripts = pkg().scripts ?? {};
    expect(scripts["test:tool-contract"]).toBe(
      "vitest run tests/toolsetIdentity.test.ts tests/onboardingTools.test.ts",
    );
    expect(scripts["ci:verify"]).toBe(
      "pnpm test:selfhost-safe && pnpm typecheck && pnpm test:tool-contract",
    );
    expect(scripts["ci:verify"]).not.toMatch(/outer-test|hostVerifier|tests\/host|sandbox-exec|launchctl/);
  });

  it("pins ordinary CI to macOS without moving trusted host suites into GitHub Actions", () => {
    const value = workflow();
    expect(value).toContain("runs-on: macos-15");
    expect(value).not.toMatch(/runs-on:\s*ubuntu/i);
    expect(value).toContain("run: pnpm ci:verify");
    expect(value).not.toMatch(/outer-test|hostVerifier|tests\/host|sandbox-exec|launchctl/);
  });
});
