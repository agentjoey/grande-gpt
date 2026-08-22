import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";

const roots: string[] = [];

function fixture(): Layout {
  const ws = mkdtempSync(join(tmpdir(), "host-verification-config-ws-"));
  const ctrl = mkdtempSync(join(tmpdir(), "host-verification-config-ctrl-"));
  roots.push(ws, ctrl);
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  const layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(ws, "grande-gpt", ".grande"), { recursive: true });
  return layout;
}

async function configModule(): Promise<Record<string, any>> {
  try {
    return await import("../src/hostVerificationConfig.ts");
  } catch {
    return {};
  }
}

afterEach(() => {
  delete process.env.GRANDE_WORKSPACE;
  delete process.env.GRANDE_CONTROL;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("trusted host verification activation config", () => {
  it("defaults to manual/concurrency=1 when trusted control config is absent", async () => {
    const layout = fixture();
    const mod = await configModule();
    expect(typeof mod.loadHostVerificationConfig).toBe("function");
    if (typeof mod.loadHostVerificationConfig !== "function") return;

    expect(mod.loadHostVerificationConfig(layout)).toEqual({ mode: "manual", concurrency: 1 });
  });

  it("accepts only the approved grande-gpt auto shape from the control plane", async () => {
    const layout = fixture();
    writeFileSync(join(layout.configDir, "host-verification.yaml"), [
      "hostVerification:",
      "  grande-gpt:",
      "    mode: auto",
      "    concurrency: 1",
      "",
    ].join("\n"), "utf8");

    const mod = await configModule();
    expect(typeof mod.loadHostVerificationConfig).toBe("function");
    if (typeof mod.loadHostVerificationConfig !== "function") return;
    expect(mod.loadHostVerificationConfig(layout)).toEqual({ mode: "auto", concurrency: 1 });
  });

  it("ignores candidate-repo activation files when trusted config is absent", async () => {
    const layout = fixture();
    writeFileSync(join(layout.workspaceRoot, "grande-gpt", ".grande", "host-verification.yaml"), [
      "hostVerification:",
      "  grande-gpt:",
      "    mode: auto",
      "    concurrency: 1",
      "",
    ].join("\n"), "utf8");

    const mod = await configModule();
    expect(typeof mod.loadHostVerificationConfig).toBe("function");
    if (typeof mod.loadHostVerificationConfig !== "function") return;
    expect(mod.loadHostVerificationConfig(layout)).toEqual({ mode: "manual", concurrency: 1 });
  });

  it.each([
    ["mode", "hostVerification:\n  grande-gpt:\n    mode: enabled\n    concurrency: 1\n"],
    ["concurrency", "hostVerification:\n  grande-gpt:\n    mode: auto\n    concurrency: 2\n"],
    ["shape", "mode: auto\nconcurrency: 1\n"],
  ])("fails closed on invalid trusted %s config", async (_case, text) => {
    const layout = fixture();
    writeFileSync(join(layout.configDir, "host-verification.yaml"), text, "utf8");

    const mod = await configModule();
    expect(typeof mod.loadHostVerificationConfig).toBe("function");
    if (typeof mod.loadHostVerificationConfig !== "function") return;
    expect(() => mod.loadHostVerificationConfig(layout)).toThrow(/host-verification|mode|concurrency|config/i);
  });
});
