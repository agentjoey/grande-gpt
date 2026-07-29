import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Layout } from "./layout.ts";

/**
 * 当前代码认识的 schema 版本，落在 SQLite 内置的 `PRAGMA user_version`（一个
 * 普通整数，SQLite 自己不使用它，专门留给应用层标记 schema 版本，新建的库默认
 * 是 0）。每次这里的 `CREATE TABLE` 语句发生不兼容变化（增删列、改类型……）就
 * 把这个数字加一。**不写迁移机制**——只需要「检测到不认识的版本就响亮拒绝」。
 *
 * `1 → 2`：新增 `oauth_client` / `oauth_refresh` 两张表。
 * `2 → 3`：D18 单一端点，删除 `oauth_refresh.repoId`。
 * `3 → 4`：S2 Verification Attestation。job 增加 run 启动时的工作区摘要与本机
 * 工具链字段，并新增 attestation 表，把通过的 job 绑定到随后产生的 commit sha。
 */
const SCHEMA_VERSION = 4;

/** 打开状态库并保证 schema 就位；已有库版本必须与当前代码完全一致。 */
export function openDb(layout: Layout): DatabaseSync {
  mkdirSync(dirname(layout.stateDb), { recursive: true });
  const db = new DatabaseSync(layout.stateDb);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const hasExistingSchema =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('task','job','audit','attestation') LIMIT 1",
      )
      .get() !== undefined;

  if (hasExistingSchema) {
    const { user_version: onDisk } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (onDisk !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `状态库 schema 版本不匹配：代码期望 user_version=${SCHEMA_VERSION}，磁盘上的库是 ` +
          `user_version=${onDisk}（${layout.stateDb}）。这个库可能建自加入版本号之前的旧代码，` +
          `或者建自更新的代码。不做自动迁移——请人工确认后处理（例如备份后删除该文件，` +
          `让程序重新初始化一个空库）。`,
      );
    }
  }

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
      jobId           TEXT PRIMARY KEY,
      taskId          TEXT NOT NULL REFERENCES task(taskId),
      profile         TEXT NOT NULL,
      argv            TEXT NOT NULL,
      state           TEXT NOT NULL,
      pgid            INTEGER,
      exitCode        INTEGER,
      startedAt       INTEGER NOT NULL,
      endedAt         INTEGER,
      artifactPath    TEXT,
      summary         TEXT,
      workspaceDigest TEXT,
      hostToolchain   TEXT
    );

    CREATE TABLE IF NOT EXISTS audit (
      opId         TEXT PRIMARY KEY,
      taskId       TEXT,
      tool         TEXT NOT NULL,
      inputDigest  TEXT NOT NULL,
      decision     TEXT NOT NULL,
      state        TEXT NOT NULL,
      pathsTouched TEXT NOT NULL,
      reason       TEXT,
      at           INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attestation (
      attestationId TEXT PRIMARY KEY,
      taskId        TEXT NOT NULL REFERENCES task(taskId),
      "commit"     TEXT NOT NULL,
      profile       TEXT NOT NULL,
      jobId         TEXT NOT NULL REFERENCES job(jobId),
      exitCode      INTEGER NOT NULL,
      startedAt     INTEGER NOT NULL,
      endedAt       INTEGER NOT NULL,
      hostToolchain TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_taskId       ON job(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_task       ON audit(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_state      ON audit(state);
    CREATE INDEX IF NOT EXISTS idx_attestation_task ON attestation(taskId);
    CREATE INDEX IF NOT EXISTS idx_attestation_job  ON attestation(jobId);

    CREATE TABLE IF NOT EXISTS oauth_client (
      clientId     TEXT PRIMARY KEY,
      redirectUris TEXT NOT NULL,
      createdAt    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_refresh (
      handle    TEXT PRIMARY KEY,
      resource  TEXT NOT NULL,
      parent    TEXT,
      valid     INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);

  if (!hasExistingSchema) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}
