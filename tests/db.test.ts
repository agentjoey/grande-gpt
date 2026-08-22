import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("openDb()", () => {
  it("建出核心状态表与 attestation 表", () => {
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
    expect(names).toContain("attestation");
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
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("建出 oauth_client / oauth_refresh 两张表（U1 实测缺口：重启丢 client/refresh_token 的回归修复）", () => {
    const l = loadLayout();
    ensureLayout(l);
    const db = openDb(l);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(names).toContain("oauth_client");
    expect(names).toContain("oauth_refresh");
    db.close();
  });

  it("把当前前一版本 5 顺序迁移到 6，并保留既有 task/audit/OAuth/attestation/receipt 数据", () => {
    const l = loadLayout();
    ensureLayout(l);

    const seed = openDb(l);
    const now = Date.now();
    seed.prepare(
      "INSERT INTO task (taskId,repoId,branch,baseCommit,worktreePath,state,createdAt,updatedAt,stateVersion) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("task-migrate", "demo", "grande/demo", "abc", "/tmp/demo", "READY", now, now, 1);
    seed.prepare(
      "INSERT INTO audit (opId,taskId,tool,inputDigest,decision,state,pathsTouched,reason,at,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("op-migrate", "task-migrate", "probe", "sha256:x", "ALLOWED", "SUCCEEDED", "[]", null, now, now);
    seed.prepare("INSERT INTO oauth_client (clientId,redirectUris,createdAt) VALUES (?,?,?)").run(
      "client-migrate",
      "[]",
      now,
    );
    seed.prepare("INSERT INTO oauth_refresh (handle,resource,parent,valid,createdAt) VALUES (?,?,?,?,?)").run(
      "refresh-migrate",
      "https://example.invalid",
      null,
      1,
      now,
    );
    seed.prepare(
      "INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,hostToolchain) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("job-migrate", "task-migrate", "unit", "[]", "passed", 0, now, now + 1, "node24");
    seed.prepare(
      'INSERT INTO attestation (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run("att-migrate", "task-migrate", "abc", "unit", "job-migrate", 0, now, now + 1, "node24");
    seed.prepare("INSERT INTO outer_test_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)").run(
      "task-migrate",
      '{"commit":"abc"}',
      now,
    );
    seed.exec("DROP TABLE audit_ack");
    seed.exec("PRAGMA user_version = 5");
    seed.close();

    const migrated = openDb(l);
    expect((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(6);
    expect(migrated.prepare("SELECT taskId FROM task WHERE taskId='task-migrate'").get()).toBeDefined();
    expect(migrated.prepare("SELECT opId FROM audit WHERE opId='op-migrate'").get()).toBeDefined();
    expect(migrated.prepare("SELECT clientId FROM oauth_client WHERE clientId='client-migrate'").get()).toBeDefined();
    expect(migrated.prepare("SELECT handle FROM oauth_refresh WHERE handle='refresh-migrate'").get()).toBeDefined();
    expect(migrated.prepare("SELECT attestationId FROM attestation WHERE attestationId='att-migrate'").get()).toBeDefined();
    expect(migrated.prepare("SELECT taskId FROM outer_test_receipt WHERE taskId='task-migrate'").get()).toBeDefined();
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_ack'").get()).toBeDefined();
    migrated.close();
  });

  it("schema 版本不匹配时 openDb 响亮拒绝，错误信息同时点出期望版本与磁盘上的实际版本", () => {
    const l = loadLayout();
    ensureLayout(l);
    openDb(l).close();

    const raw = new DatabaseSync(l.stateDb);
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    expect(() => openDb(l)).toThrow(new RegExp(`user_version=${SCHEMA_VERSION}`));
    expect(() => openDb(l)).toThrow(/user_version=99/);
  });

  it("幂等打开不会把已经匹配的 user_version 错误地判成不匹配（正常路径的对照组）", () => {
    const l = loadLayout();
    ensureLayout(l);
    openDb(l).close();
    expect(() => openDb(l).close()).not.toThrow();
  });
});
