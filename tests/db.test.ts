import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("openDb()", () => {
  it("建出三张表", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toContain("task");
    expect(names).toContain("job");
    expect(names).toContain("audit");
    db.close();
  });

  it("开启 WAL 与外键约束", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    expect(String((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase()).toBe("wal");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    db.close();
  });

  it("幂等：重复打开不会因为表已存在而报错", () => {
    const l = loadLayout();
    ensureLayout(l);
    openDb(l).close();
    expect(() => openDb(l).close()).not.toThrow();
  });

  it("job.taskId 的外键真的生效——插入孤儿 job 应被拒", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    expect(() =>
      db
        .prepare("INSERT INTO job (jobId,taskId,profile,argv,state,startedAt) VALUES (?,?,?,?,?,?)")
        .run("j1", "no-such-task", "unit", "[]", "running", Date.now()),
    ).toThrow();
    db.close();
  });
});
