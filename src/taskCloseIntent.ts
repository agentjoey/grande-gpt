import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";

const SHA_RE = /^[0-9a-f]{40}$/u;

export interface TaskCloseIntent {
  taskId: string;
  expectedStateVersion: number;
  headSha: string;
  requestedAt: number;
}

export function ensureTaskCloseIntentTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_close_intent (
      taskId TEXT PRIMARY KEY REFERENCES task(taskId),
      expectedStateVersion INTEGER NOT NULL,
      headSha TEXT NOT NULL,
      requestedAt INTEGER NOT NULL
    )
  `);
}

function toIntent(row: Record<string, unknown>): TaskCloseIntent {
  return {
    taskId: row.taskId as string,
    expectedStateVersion: row.expectedStateVersion as number,
    headSha: row.headSha as string,
    requestedAt: row.requestedAt as number,
  };
}

export function getTaskCloseIntent(db: DatabaseSync, taskId: string): TaskCloseIntent | undefined {
  ensureTaskCloseIntentTable(db);
  const row = db.prepare("SELECT * FROM task_close_intent WHERE taskId = ?").get(taskId);
  return row ? toIntent(row as Record<string, unknown>) : undefined;
}

export function saveTaskCloseIntent(
  db: DatabaseSync,
  input: { taskId: string; expectedStateVersion: number; headSha: string },
): TaskCloseIntent {
  ensureTaskCloseIntentTable(db);
  if (!Number.isInteger(input.expectedStateVersion) || input.expectedStateVersion < 1) {
    throw new StateError("INVALID_INPUT", `close intent stateVersion 非法：${input.expectedStateVersion}`);
  }
  if (!SHA_RE.test(input.headSha)) {
    throw new StateError("INVALID_INPUT", `close intent 需要 exact 40-char Git SHA，收到：${input.headSha}`);
  }
  const existing = getTaskCloseIntent(db, input.taskId);
  if (existing) {
    if (existing.expectedStateVersion === input.expectedStateVersion && existing.headSha === input.headSha) {
      return existing;
    }
    throw new StateError("STALE_STATE", `任务 ${input.taskId} 已有不同的 durable close intent；拒绝覆盖旧快照。`);
  }
  const requestedAt = Date.now();
  db.prepare(
    "INSERT INTO task_close_intent(taskId, expectedStateVersion, headSha, requestedAt) VALUES (?,?,?,?)",
  ).run(input.taskId, input.expectedStateVersion, input.headSha, requestedAt);
  return { ...input, requestedAt };
}

export function clearTaskCloseIntent(db: DatabaseSync, taskId: string): void {
  ensureTaskCloseIntentTable(db);
  db.prepare("DELETE FROM task_close_intent WHERE taskId = ?").run(taskId);
}
