import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreStateDbBackup } from "../src/controlBackup.ts";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";
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

function createMigratedFixture(): { layout: ReturnType<typeof loadLayout>; backupPath: string } {
  const layout = loadLayout();
  ensureLayout(layout);
  const seed = openDb(layout);
  seed.exec("DROP TABLE audit_ack");
  seed.exec("CREATE TABLE phase7_restore_probe (value TEXT NOT NULL)");
  seed.prepare("INSERT INTO phase7_restore_probe (value) VALUES (?)").run("from-v5");
  seed.exec("PRAGMA user_version = 5");
  seed.close();

  const migrated = openDb(layout);
  migrated.close();
  const backupDir = join(layout.controlRoot, "backups", "state");
  const backupName = readdirSync(backupDir).find((name) => name.endsWith(".db"));
  if (!backupName) throw new Error("fixture 没有生成 migration backup");
  return { layout, backupPath: join(backupDir, backupName) };
}

describe("GG-BL-007 managed state restore", () => {
  it("从 managed verified backup 原子恢复，并能由当前 binary 重新打开/迁移", () => {
    const { layout, backupPath } = createMigratedFixture();
    const current = openDb(layout);
    current.prepare("UPDATE phase7_restore_probe SET value=?").run("changed-after-migration");
    current.close();
    const backupBytes = readFileSync(backupPath);

    const evidence = restoreStateDbBackup(layout, backupPath);
    expect(evidence.backupPath).toBe(backupPath);
    expect(evidence.schemaVersion).toBe(5);
    expect(readFileSync(layout.stateDb)).toEqual(backupBytes);

    const raw = new DatabaseSync(layout.stateDb, { readOnly: true });
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    expect(raw.prepare("SELECT value FROM phase7_restore_probe").get()).toEqual({ value: "from-v5" });
    raw.close();

    const reopened = openDb(layout);
    expect((reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(reopened.prepare("SELECT value FROM phase7_restore_probe").get()).toEqual({ value: "from-v5" });
    reopened.close();
  });

  it("拒绝 managed backup root 之外的 restore source", () => {
    const { layout, backupPath } = createMigratedFixture();
    const outside = join(layout.controlRoot, "outside.db");
    copyFileSync(backupPath, outside);
    expect(() => restoreStateDbBackup(layout, outside)).toThrow(/managed|backup root|受管/);
  });

  it("拒绝 managed root 内的无效 SQLite，并保持当前 state DB bytes 不变", () => {
    const { layout } = createMigratedFixture();
    const before = readFileSync(layout.stateDb);
    const invalid = join(layout.controlRoot, "backups", "state", "invalid.db");
    writeFileSync(invalid, "not sqlite");
    expect(() => restoreStateDbBackup(layout, invalid)).toThrow();
    expect(readFileSync(layout.stateDb)).toEqual(before);
  });

  it("state DB 仍有 live WAL handle 时 fail closed，不替换底层文件", () => {
    const { layout, backupPath } = createMigratedFixture();
    const live = openDb(layout);
    const before = readFileSync(layout.stateDb);
    try {
      expect(() => restoreStateDbBackup(layout, backupPath)).toThrow(/live|handle|使用|WAL/i);
      expect(readFileSync(layout.stateDb)).toEqual(before);
    } finally {
      live.close();
    }
  });
});
