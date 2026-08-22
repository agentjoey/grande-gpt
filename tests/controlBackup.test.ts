import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function seedVersion5Db(): ReturnType<typeof loadLayout> {
  const layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);
  db.exec("DROP TABLE audit_ack");
  db.exec("CREATE TABLE phase7_probe (value TEXT NOT NULL)");
  db.prepare("INSERT INTO phase7_probe (value) VALUES (?)").run("preserved");
  db.exec("PRAGMA user_version = 5");
  db.close();
  return layout;
}

describe("GG-BL-007 verified pre-migration backup", () => {
  it("5 -> 6 migration 前创建完整、可读且仍为 user_version=5 的 verified backup", () => {
    const layout = seedVersion5Db();

    const migrated = openDb(layout);
    migrated.close();

    const backupDir = join(layout.controlRoot, "backups", "state");
    const backups = readdirSync(backupDir).filter((name) => name.endsWith(".db"));
    expect(backups).toHaveLength(1);

    const backup = new DatabaseSync(join(backupDir, backups[0]!));
    expect((backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
    expect((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    expect(backup.prepare("SELECT value FROM phase7_probe").get()).toEqual({ value: "preserved" });
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_ack'").get()).toBeUndefined();
    backup.close();
  });

  it("backup destination 失败时 migration 不开始，source DB bytes/schema/user_version 保持零修改", () => {
    const layout = seedVersion5Db();
    const before = readFileSync(layout.stateDb);

    const blockedParent = join(layout.controlRoot, "backups");
    mkdirSync(layout.controlRoot, { recursive: true });
    writeFileSync(blockedParent, "not-a-directory");

    expect(() => openDb(layout)).toThrow();
    expect(readFileSync(layout.stateDb)).toEqual(before);

    const source = new DatabaseSync(layout.stateDb);
    expect((source.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    expect(source.prepare("SELECT value FROM phase7_probe").get()).toEqual({ value: "preserved" });
    expect(source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_ack'").get()).toBeUndefined();
    source.close();
  });
});
