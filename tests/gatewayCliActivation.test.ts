import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLatestActivationReceipt } from "../src/activationReceipt.ts";
import { openDb } from "../src/db.ts";
import { runGatewayCli } from "../src/gatewayCli.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { SelfCheckResult } from "../src/selfcheck.ts";
import type { ToolsetIdentity } from "../src/toolsetIdentity.ts";

let ws: string;
let ctrl: string;
const saved = {
  ws: process.env.GRANDE_WORKSPACE,
  ctrl: process.env.GRANDE_CONTROL,
  issuer: process.env.GRANDE_ISSUER,
};

const target: ToolsetIdentity = {
  gatewayBuild: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  toolsetEpoch: 2,
  toolsCount: 25,
  toolsDigest: "sha256:expected",
};

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "gateway-activation-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "gateway-activation-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  process.env.GRANDE_ISSUER = "https://grande.example.test";
  const layout = loadLayout();
  ensureLayout(layout);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = saved.ctrl;
  if (saved.issuer === undefined) delete process.env.GRANDE_ISSUER; else process.env.GRANDE_ISSUER = saved.issuer;
});

describe("GG-BL-019 gateway restart activation wiring", () => {
  it("restart performs trusted activation asynchronously and persists the receipt in the existing state DB", async () => {
    const lines: string[] = [];
    const actions: string[] = [];
    const readProbe = async (): Promise<SelfCheckResult> => ({
      url: "http://127.0.0.1:8787/mcp",
      httpStatus: 200,
      bytes: 123,
      gatewayBuild: target.gatewayBuild,
      toolsetEpoch: target.toolsetEpoch,
      toolsCount: target.toolsCount,
      toolsDigest: target.toolsDigest,
      tools: [],
    });

    const result = runGatewayCli(["restart"], (line) => lines.push(line), {
      resolveIdentity: () => ({ uid: 501, homeDir: join(ctrl, "home") }),
      targetIdentity: target,
      manageLaunchAgent: (action) => {
        actions.push(action);
        if (action === "restart") return { code: 0, lines: ["Gateway LaunchAgent 已重启并就绪"] };
        if (action === "status") return { code: 0, lines: ["Gateway LaunchAgent 已加载 state=running"] };
        return { code: 1, lines: [`unexpected ${action}`] };
      },
      readProbe,
    });

    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(0);
    expect(actions).toEqual(["restart", "status"]);
    expect(lines.join("\n")).toContain("Production activation receipt 已记录");

    const layout = loadLayout();
    const db = openDb(layout);
    try {
      expect(getLatestActivationReceipt(db)?.runtimeBuild).toBe(target.gatewayBuild);
    } finally {
      db.close();
    }
  });
});
