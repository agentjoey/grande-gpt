import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordActivationReceipt, type ActivationEvidence } from "../src/activationReceipt.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { buildTools } from "../src/tools.ts";

let ws: string;
let ctrl: string;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

const evidence: ActivationEvidence = {
  targetBuild: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  runtimeBuild: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  expectedToolset: { toolsetEpoch: 2, toolsCount: 25, toolsDigest: "sha256:expected" },
  runtimeToolset: { toolsetEpoch: 2, toolsCount: 25, toolsDigest: "sha256:expected" },
  restart: { launchAgentRunning: true, endpointReady: true },
  readProbe: { ok: true, httpStatus: 200 },
};

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "activation-status-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "activation-status-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("GG-BL-019 activation evidence status projection", () => {
  it("exposes the latest activation receipt through grande_task_status without changing the 25-tool contract", async () => {
    const layout = loadLayout();
    ensureLayout(layout);
    const db = openDb(layout);
    try {
      const receipt = recordActivationReceipt(db, evidence, 1_787_409_600_000);
      const tools = buildTools({ db, layout });
      expect(tools).toHaveLength(25);
      const status = tools.find((tool) => tool.name === "grande_task_status");
      if (!status) throw new Error("grande_task_status missing");

      const result = await status.handler({});
      const envelope = result.structuredContent as { ok?: unknown; data?: Record<string, unknown> };
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.activationReceipt).toEqual(receipt);
    } finally {
      db.close();
    }
  });

  it("returns activationReceipt=null before any production activation receipt exists", async () => {
    const layout = loadLayout();
    ensureLayout(layout);
    const db = openDb(layout);
    try {
      const tools = buildTools({ db, layout });
      const status = tools.find((tool) => tool.name === "grande_task_status");
      if (!status) throw new Error("grande_task_status missing");

      const result = await status.handler({});
      const envelope = result.structuredContent as { ok?: unknown; data?: Record<string, unknown> };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toHaveProperty("activationReceipt", null);
    } finally {
      db.close();
    }
  });
});
