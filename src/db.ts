import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Layout } from "./layout.ts";

/**
 * 打开状态库并保证 schema 就位。
 *
 * 用 Node 内置的 `node:sqlite` 而非 better-sqlite3：零依赖，与项目「能力面最小」
 * 的主线一致。代价是 Node 把它标为 experimental，API 可能随版本变化——因此
 * Node 版本锁定 24，且用 `--disable-warning=ExperimentalWarning` **精确**屏蔽
 * 那一条警告（不是全局关警告，其它警告仍应可见）。
 *
 * `stmt.get()` 返回 **null-prototype 对象**，断言时用 `toEqual` 而非 `toStrictEqual`。
 */
export function openDb(layout: Layout): DatabaseSync {
  mkdirSync(dirname(layout.stateDb), { recursive: true });
  const db = new DatabaseSync(layout.stateDb);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS task (
      taskId       TEXT PRIMARY KEY,
      repoId       TEXT NOT NULL,
      branch       TEXT NOT NULL,
      baseCommit   TEXT NOT NULL,
      worktreePath TEXT NOT NULL,
      state        TEXT NOT NULL,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL,
      stateVersion INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job (
      jobId        TEXT PRIMARY KEY,
      taskId       TEXT NOT NULL REFERENCES task(taskId),
      profile      TEXT NOT NULL,
      argv         TEXT NOT NULL,
      state        TEXT NOT NULL,
      pgid         INTEGER,
      exitCode     INTEGER,
      startedAt    INTEGER NOT NULL,
      endedAt      INTEGER,
      artifactPath TEXT,
      summary      TEXT
    );

    CREATE TABLE IF NOT EXISTS audit (
      opId         TEXT PRIMARY KEY,
      taskId       TEXT,
      tool         TEXT NOT NULL,
      inputDigest  TEXT NOT NULL,
      decision     TEXT NOT NULL,
      state        TEXT NOT NULL,
      pathsTouched TEXT NOT NULL,
      at           INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_taskId  ON job(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_task  ON audit(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_state ON audit(state);
  `);

  return db;
}
