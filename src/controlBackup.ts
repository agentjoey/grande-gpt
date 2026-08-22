import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync, type DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Layout } from "./layout.ts";

const STATE_BACKUP_RETENTION = 5;

export interface StateDbBackupEvidence {
  path: string;
  schemaVersion: number;
  integrityCheck: "ok";
  reason: string;
}

export interface StateDbRestoreEvidence {
  backupPath: string;
  stateDb: string;
  schemaVersion: number;
  integrityCheck: "ok";
  restoredAt: number;
}

function stateBackupRoot(layout: Layout): string {
  return layout.stateBackupsDir ?? join(layout.controlRoot, "backups", "state");
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function verifySqlite(path: string): { schemaVersion: number; integrityCheck: "ok" } {
  const backup = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = (backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") {
      throw new Error(`状态库 backup integrity_check 失败：${path} (${integrity})`);
    }
    const schemaVersion = (backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    return { schemaVersion, integrityCheck: "ok" };
  } finally {
    backup.close();
  }
}

function assertManagedBackupPath(layout: Layout, backupPath: string): string {
  const root = realpathSync(stateBackupRoot(layout));
  const source = realpathSync(backupPath);
  const rel = relative(root, source);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`restore source 不在受管 backup root 内：${backupPath}`);
  }
  return source;
}

function verifyBackup(path: string, expectedVersion: number): StateDbBackupEvidence {
  const verified = verifySqlite(path);
  if (verified.schemaVersion !== expectedVersion) {
    throw new Error(
      `状态库 backup schema 版本错误：期望 ${expectedVersion}，实际 ${verified.schemaVersion}（${path}）`,
    );
  }
  return { path, schemaVersion: verified.schemaVersion, integrityCheck: "ok", reason: "verified" };
}

function pruneOldBackups(layout: Layout): void {
  const root = stateBackupRoot(layout);
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".db"))
    .sort();
  for (const name of files.slice(0, Math.max(0, files.length - STATE_BACKUP_RETENTION))) {
    rmSync(join(root, name), { force: true });
  }
}

/**
 * SQLite WAL 模式下所有连接都会持续持有 SHARED lock；只有最后一个连接才能拿到
 * EXCLUSIVE lock 并从 WAL 切回 rollback mode。利用 SQLite 自己的锁语义做 restore
 * preflight，比“wal/shm 文件是否存在”可靠——文件存在本身不能证明仍有 live handle。
 */
function assertExclusiveRestoreWindow(layout: Layout): void {
  const probe = new DatabaseSync(layout.stateDb);
  try {
    probe.exec("PRAGMA busy_timeout = 0");
    const current = String(
      (probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toLowerCase();
    if (current !== "wal") {
      throw new Error(`state DB journal_mode=${current}，不是当前受管 WAL 状态；restore fail closed`);
    }

    let changed: string;
    try {
      changed = String(
        (probe.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode: string }).journal_mode,
      ).toLowerCase();
    } catch (error) {
      throw new Error(
        `state DB 仍有 live handle，无法取得 restore exclusive window：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (changed !== "delete") {
      throw new Error(`state DB 仍有 live handle；journal_mode 仍为 ${changed}，restore fail closed`);
    }
  } finally {
    probe.close();
  }
}

/**
 * 在 migration 前创建一份 SQLite 一致性 backup。VACUUM INTO 只读取 source DB，
 * destination 固定在 controlRoot/backups/state 下；校验通过前 migration 不得开始。
 */
export function createStateDbBackup(
  layout: Layout,
  db: DatabaseSyncType,
  reason: string,
  expectedVersion: number,
): StateDbBackupEvidence {
  const root = stateBackupRoot(layout);
  mkdirSync(root, { recursive: true });
  const stamp = String(Date.now()).padStart(13, "0");
  const safeReason = reason.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const path = join(root, `${stamp}-${safeReason}-${randomUUID()}.db`);

  try {
    db.exec(`VACUUM INTO ${sqlStringLiteral(path)}`);
    const verified = verifyBackup(path, expectedVersion);
    pruneOldBackups(layout);
    return { ...verified, reason };
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

/** 只验证受管 backup，不修改 state DB；供 Human restore dry-run 使用。 */
export function inspectStateDbBackup(layout: Layout, backupPath: string): StateDbBackupEvidence {
  const source = assertManagedBackupPath(layout, backupPath);
  const verified = verifySqlite(source);
  return { path: source, schemaVersion: verified.schemaVersion, integrityCheck: "ok", reason: "restore-dry-run" };
}

/**
 * 从受管、已验证 backup 原子替换 state DB。Human 必须先停止 Gateway/相关 DB 用户；
 * preflight 会要求 SQLite 真正取得 WAL→DELETE 的 exclusive transition，若仍有第二个
 * connection 则 fail closed。成功 transition 后再用已校验临时副本原子 rename。
 */
export function restoreStateDbBackup(layout: Layout, backupPath: string): StateDbRestoreEvidence {
  const inspected = inspectStateDbBackup(layout, backupPath);
  assertExclusiveRestoreWindow(layout);

  mkdirSync(dirname(layout.stateDb), { recursive: true });
  const tempPath = join(dirname(layout.stateDb), `.restore-${process.pid}-${randomUUID()}.db`);
  try {
    copyFileSync(inspected.path, tempPath);
    const copied = verifySqlite(tempPath);
    if (copied.schemaVersion !== inspected.schemaVersion) {
      throw new Error(`restore 临时副本 schema 漂移：${copied.schemaVersion} != ${inspected.schemaVersion}`);
    }
    renameSync(tempPath, layout.stateDb);
  } finally {
    rmSync(tempPath, { force: true });
  }

  return {
    backupPath: inspected.path,
    stateDb: layout.stateDb,
    schemaVersion: inspected.schemaVersion,
    integrityCheck: "ok",
    restoredAt: Date.now(),
  };
}
