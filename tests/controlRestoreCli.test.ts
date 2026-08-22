import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStateDbBackup } from "../src/controlBackup.ts";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";
import { runGatewayCli } from "../src/gatewayCli.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";

let ws: string;
let ctrl: string;
let lines: string[];
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

function gatewayCli(argv: string[]): number {
  const result = runGatewayCli(argv, (line) => lines.push(line));
  if (typeof result !== "number") throw new Error("restore-state 必须同步返回退出码");
  return result;
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  lines = [];
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("grande gateway restore-state", () => {
  it("默认 dry-run 只验证并打印 exact managed path/schema；--yes 才真正恢复", () => {
    const layout = loadLayout();
    ensureLayout(layout);
    const db = openDb(layout);
    const backup = createStateDbBackup(layout, db, "cli-restore-test", SCHEMA_VERSION);
    db.exec("CREATE TABLE cli_restore_probe (value TEXT NOT NULL)");
    db.prepare("INSERT INTO cli_restore_probe (value) VALUES (?)").run("must-disappear-after-restore");
    db.close();

    expect(gatewayCli(["restore-state", backup.path])).toBe(0);
    expect(lines.join("\n")).toContain("dry-run");
    expect(lines.join("\n")).toContain(backup.path);
    expect(lines.join("\n")).toContain(`user_version=${SCHEMA_VERSION}`);
    const beforeApply = new DatabaseSync(layout.stateDb, { readOnly: true });
    expect(beforeApply.prepare("SELECT value FROM cli_restore_probe").get()).toBeDefined();
    beforeApply.close();

    lines = [];
    const applyCode = gatewayCli(["restore-state", backup.path, "--yes"]);
    expect(applyCode, lines.join("\n")).toBe(0);
    expect(lines.join("\n")).toContain("已恢复");
    const afterApply = new DatabaseSync(layout.stateDb, { readOnly: true });
    expect(afterApply.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cli_restore_probe'").get()).toBeUndefined();
    afterApply.close();
  });
});
