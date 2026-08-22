import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ mode: "manual" as const, concurrency: 1 as const })),
  createRuntime: vi.fn(() => ({ hostVerificationMode: "manual" as const, hostVerifierCoordinator: undefined })),
  buildTools: vi.fn((_deps: unknown, _options?: unknown) => []),
}));

vi.mock("@hono/node-server", () => ({
  serve: () => ({ close: (callback: (error?: Error) => void) => callback() }),
}));

vi.mock("../src/hostVerificationConfig.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hostVerificationConfig.ts")>();
  return { ...actual, loadHostVerificationConfig: mocks.loadConfig };
});

vi.mock("../src/hostVerificationProduction.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hostVerificationProduction.ts")>();
  return { ...actual, createProductionHostVerification: mocks.createRuntime };
});

vi.mock("../src/tools.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools.ts")>();
  return { ...actual, buildTools: mocks.buildTools };
});

let root: string;
let db: ReturnType<typeof openDb>;
let layout: ReturnType<typeof loadLayout>;
let oldPort: string | undefined;

async function serverModule(): Promise<Record<string, any>> {
  return await import("../src/server.ts");
}

beforeEach(() => {
  mocks.loadConfig.mockClear();
  mocks.createRuntime.mockClear();
  mocks.buildTools.mockClear();

  root = mkdtempSync(join(tmpdir(), "host-verification-server-wiring-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  oldPort = process.env.PORT;
  process.env.PORT = "0";
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  db = openDb(layout);
});

afterEach(() => {
  db.close();
  delete process.env.GRANDE_WORKSPACE;
  delete process.env.GRANDE_CONTROL;
  if (oldPort === undefined) delete process.env.PORT;
  else process.env.PORT = oldPort;
  rmSync(root, { recursive: true, force: true });
});

describe("Gateway startup Host Verifier activation wiring", () => {
  it("loads trusted activation config and constructs the production runtime exactly once per Gateway start", async () => {
    const mod = await serverModule();
    const cfg = {
      issuer: "https://grande.example.test",
      layout,
      db,
      accessConfig: { teamDomain: "https://team.example.test", aud: "a".repeat(64) },
    };

    const gateway = await mod.startGateway(cfg);
    try {
      expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
      expect(mocks.loadConfig).toHaveBeenCalledWith(layout);
      expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
      expect(mocks.createRuntime).toHaveBeenCalledWith(
        { db, layout },
        { mode: "manual", concurrency: 1 },
      );
    } finally {
      await gateway.close();
    }
  });

  it("passes the same startup runtime options into every request-scoped buildTools assembly", async () => {
    const mod = await serverModule();
    expect(typeof mod.buildGatewayTools).toBe("function");
    if (typeof mod.buildGatewayTools !== "function") return;

    const sharedCoordinator = { marker: "one-gateway-coordinator" };
    const hostVerification = {
      hostVerificationMode: "auto",
      hostVerifierCoordinator: sharedCoordinator,
    };
    mod.buildGatewayTools({ db, layout, hostVerification }, "grande-gpt");
    mod.buildGatewayTools({ db, layout, hostVerification }, undefined);

    expect(mocks.buildTools).toHaveBeenCalledTimes(2);
    expect(mocks.buildTools.mock.calls[0]?.[1]).toBe(hostVerification);
    expect(mocks.buildTools.mock.calls[1]?.[1]).toBe(hostVerification);
    expect(mocks.buildTools.mock.calls[0]?.[0]).toEqual({ db, layout, defaultRepoId: "grande-gpt" });
    expect(mocks.buildTools.mock.calls[1]?.[0]).toEqual({ db, layout, defaultRepoId: undefined });
  });
});
