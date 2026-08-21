import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db.ts";
import { ensureLayout, loadLayout } from "../../src/layout.ts";
import { startGateway, type AppConfig } from "../../src/server.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function trustedPort(): number {
  const raw = process.env.GRANDE_VERIFIER_LOOPBACK_PORTS?.split(",")[0];
  if (raw !== undefined) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || port === 8787) {
      throw new Error("invalid trusted verifier loopback allocation");
    }
    return port;
  }
  // Manual outer-test compatibility only. The auto verifier always provides the trusted allocation.
  return 8791;
}

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

describe("auto-safe Gateway loopback smoke", () => {
  it("binds and accepts traffic only on the trusted verifier loopback port", async () => {
    const root = mkdtempSync(join(tmpdir(), "grande-server-auto-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const control = join(root, "control");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(control, { recursive: true });
    const previousWorkspace = process.env.GRANDE_WORKSPACE;
    const previousControl = process.env.GRANDE_CONTROL;
    const previousPort = process.env.PORT;
    process.env.GRANDE_WORKSPACE = workspace;
    process.env.GRANDE_CONTROL = control;
    process.env.PORT = String(trustedPort());
    const layout = loadLayout();
    ensureLayout(layout);
    const db = openDb(layout);
    const config: AppConfig = {
      issuer: "https://verifier.invalid",
      layout,
      db,
      accessConfig: { teamDomain: "https://team.invalid", aud: "a".repeat(64) },
    };
    const gateway = await startGateway(config);
    try {
      expect(await reachable(Number(process.env.PORT))).toBe(true);
    } finally {
      await gateway.close();
      db.close();
      if (previousWorkspace === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = previousWorkspace;
      if (previousControl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = previousControl;
      if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
    }
  });
});
