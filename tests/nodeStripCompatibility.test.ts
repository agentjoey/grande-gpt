import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Node strip-only production compatibility", () => {
  it("Phase 4 capability module 可被生产同款 Node 直接 import，不依赖 TypeScript transform", () => {
    const moduleUrl = new URL("../src/capabilities.ts", import.meta.url).href;
    expect(() => execFileSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    )).not.toThrow();
  });
});
