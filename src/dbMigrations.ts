import type { DatabaseSync } from "node:sqlite";

interface MigrationStep {
  from: number;
  to: number;
  apply(db: DatabaseSync): void;
}

const MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 5,
    to: 6,
    apply(db) {
      db.exec(`
        CREATE TABLE audit_ack (
          opId    TEXT PRIMARY KEY,
          ackedAt INTEGER NOT NULL,
          note    TEXT
        )
      `);
    },
  },
];

export function canMigrate(fromVersion: number, toVersion: number): boolean {
  return MIGRATIONS.some((step) => step.from === fromVersion && step.to === toVersion);
}

export function migrateDb(db: DatabaseSync, fromVersion: number, toVersion: number): void {
  const step = MIGRATIONS.find((candidate) => candidate.from === fromVersion && candidate.to === toVersion);
  if (!step) {
    throw new Error(`没有受支持的 SQLite migration：${fromVersion} -> ${toVersion}`);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    step.apply(db);
    db.exec(`PRAGMA user_version = ${step.to}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 保留原始 migration 错误；ROLLBACK 自身失败不能掩盖根因。
    }
    throw error;
  }
}
