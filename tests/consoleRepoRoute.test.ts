import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { openDb } from "../src/db.ts";

vi.mock("../src/accessGate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/accessGate.ts")>();
  return { ...actual, createAccessGate: () => async () => undefined };
});

import { mountConsoleRoutes } from "../src/consoleRoutes.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "console-route-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "console-route-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

function app() {
  const a = new Hono();
  const db = openDb(layout);
  mountConsoleRoutes(a, {
    db,
    consoleAccess: { teamDomain: "https://console.example.test", aud: "c".repeat(64) },
  });
  return { a, db };
}

describe("POST /console/repos/:repoId/register", () => {
  it("空目录经 Gateway 一次完成最小 Git 初始化 + canonical registration", async () => {
    mkdirSync(join(ws, "empty-project"));
    const { a, db } = app();
    try {
      const res = await a.request("/console/repos/empty-project/register", { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        data: { repoId: "empty-project", initialized: true, registered: true },
      });
      const audit = db.prepare(
        "SELECT tool, decision, state FROM audit WHERE tool='grande_repo_add_apply' ORDER BY at DESC LIMIT 1",
      ).get() as { tool: string; decision: string; state: string } | undefined;
      expect(audit).toMatchObject({ tool: "grande_repo_add_apply", decision: "ALLOWED", state: "SUCCEEDED" });
    } finally {
      db.close();
    }
  });

  it("重复注册返回 409，不把幂等失败伪装成第二次成功", async () => {
    mkdirSync(join(ws, "repeat-project"));
    const { a, db } = app();
    try {
      expect((await a.request("/console/repos/repeat-project/register", { method: "POST" })).status).toBe(200);
      const second = await a.request("/console/repos/repeat-project/register", { method: "POST" });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        ok: false,
        error: { code: "already_registered", message: "仓库 repeat-project 已注册；拒绝重复注册。" },
      });
    } finally {
      db.close();
    }
  });

  it("非空非 Git 目录 readiness 失败时 409 且不注册", async () => {
    const repo = join(ws, "plain");
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "keep\n", "utf8");
    const { a, db } = app();
    try {
      const res = await a.request("/console/repos/plain/register", { method: "POST" });
      expect(res.status).toBe(409);
      const body = await res.json() as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("repo_not_ready");
      expect(body.error.message).toMatch(/Git repository|readiness|非空/i);
    } finally {
      db.close();
    }
  });
});
