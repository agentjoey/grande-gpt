import { mkdtempSync, rmSync } from "node:fs";
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

  it("busy_timeout 设为 5000ms 而不是默认的 0——第二个并发写者不会一撞锁就立刻收到 database is locked", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    db.close();
  });

  it("全新库首次 openDb 之后，user_version 落到当前 schema 版本", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
    db.close();
  });

  it("schema 版本不匹配时 openDb 响亮拒绝，错误信息同时点出期望版本与磁盘上的实际版本", () => {
    // 先用 openDb() 正常建一次库（user_version 落到当前 SCHEMA_VERSION=1），
    // 再绕开 openDb、用一个裸连接把 user_version 强行改写成一个不匹配的值——
    // 模拟「这个库文件是被别的版本的代码建出来的」，不需要真的去改一次 schema
    // 定义就能复现这条防线。
    const l = loadLayout();
    ensureLayout(l);
    openDb(l).close();

    const raw = new DatabaseSync(l.stateDb);
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    expect(() => openDb(l)).toThrow(/user_version=1/);
    expect(() => openDb(l)).toThrow(/user_version=99/);
  });

  it("幂等打开不会把已经匹配的 user_version 错误地判成不匹配（正常路径的对照组）", () => {
    const l = loadLayout();
    ensureLayout(l);
    openDb(l).close();
    expect(() => openDb(l).close()).not.toThrow();
  });
});
