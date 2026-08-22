import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";

let ws: string;
let ctrl: string;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("GG-BL-007 migration rollback", () => {
  it("migration step 中途失败时 ROLLBACK，source 仍为可读 version 5，并保留 verified pre-migration backup", () => {
    const layout = loadLayout();
    ensureLayout(layout);
    const seed = openDb(layout);
    seed.exec("DROP TABLE audit_ack");
    seed.exec("CREATE TABLE audit_ack (incompatible TEXT NOT NULL)");
    seed.exec("CREATE TABLE rollback_probe (value TEXT NOT NULL)");
    seed.prepare("INSERT INTO rollback_probe (value) VALUES (?)").run("still-here");
    seed.exec("PRAGMA user_version = 5");
    seed.close();

    expect(() => openDb(layout)).toThrow();

    const raw = new DatabaseSync(layout.stateDb, { readOnly: true });
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    expect(raw.prepare("SELECT value FROM rollback_probe").get()).toEqual({ value: "still-here" });
    const cols = raw.prepare("PRAGMA table_info(audit_ack)").all().map((row) => (row as { name: string }).name);
    expect(cols).toEqual(["incompatible"]);
    raw.close();

    const backups = readdirSync(join(layout.controlRoot, "backups", "state")).filter((name) => name.endsWith(".db"));
    expect(backups).toHaveLength(1);
  });
});
