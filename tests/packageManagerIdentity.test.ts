import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capturePackageManagerIdentity,
  isValidHostToolchainIdentity,
} from "../src/packageManagerIdentity.ts";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("GG-BL-026 verification package-manager identity", () => {
  it("fails closed when packageManager explicitly says npm but package-lock.json is missing", () => {
    root = mkdtempSync(join(tmpdir(), "pkg-identity-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "npm@11.0.0" }) + "\n", "utf8");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    expect(() => capturePackageManagerIdentity(root!)).toThrow(/packageManager=npm.*package-lock\.json/i);
  });

  it("rejects a mixed modern npm identity that also carries the legacy pnpm field", () => {
    expect(isValidHostToolchainIdentity({
      node: "v24.14.0",
      packageManager: "npm",
      packageManagerVersion: "11.0.0",
      lockfile: "package-lock.json",
      lockfileSha256: "a".repeat(64),
      pnpm: "10.33.0",
    })).toBe(false);
  });
});
