import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import type { Layout } from "./layout.ts";

export type StatusView = "overview" | "detail" | "jobs" | "attestations" | "brief";
export interface StatusCursor { scope: string; ceiling: number; before: number }
export interface StatusRow extends Record<string, unknown> { _row: number }

/** Bind continuation to the actual state file, view and task, never a caller-supplied path. */
export function statusScope(layout: Layout, view: StatusView, taskId: string | null): string {
  const stat = lstatSync(layout.stateDb);
  return createHash("sha256").update(JSON.stringify([
    layout.stateDb, stat.dev, stat.ino, view, taskId,
  ])).digest("hex");
}

export function encodeStatusCursor(cursor: StatusCursor): string {
  return `status1:${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
}

export function decodeStatusCursor(input: string | undefined, scope: string): StatusCursor | null {
  if (input === undefined) return null;
  try {
    if (input.length > 1024 || !/^status1:[A-Za-z0-9_-]+$/u.test(input)) throw new Error();
    const value = JSON.parse(Buffer.from(input.slice(8), "base64url").toString("utf8")) as StatusCursor;
    if (!value || Object.keys(value).sort().join(",") !== "before,ceiling,scope"
        || value.scope !== scope || !Number.isSafeInteger(value.ceiling) || value.ceiling < 0
        || !Number.isSafeInteger(value.before) || value.before < 0) throw new Error();
    return value;
  } catch { throw new StateError("INVALID_INPUT", "status cursor 不合法，或不属于当前 view/task/state DB。"); }
}

const QUERIES = {
  overview: { table: "task", columns: "taskId", where: "state != 'CLOSED'" },
  jobs: { table: "job", columns: "jobId,taskId,profile,state,pgid,exitCode,startedAt,endedAt", where: "taskId=?" },
  attestations: { table: "attestation", columns: 'attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt', where: "taskId=?" },
} as const;

/** Insertion-order keyset pagination uses existing rowid/task indexes; no OFFSET/history materialization. */
export function readStatusPage(
  db: DatabaseSync,
  view: keyof typeof QUERIES,
  taskId: string | null,
  size: number,
  cursor: StatusCursor | null,
): { rows: StatusRow[]; ceiling: number } {
  const query = QUERIES[view];
  const params = view === "overview" ? [] : [taskId!];
  const ceiling = cursor?.ceiling ?? (db.prepare(`SELECT COALESCE(MAX(rowid),0) n FROM ${query.table}`)
    .get() as { n: number }).n;
  if (cursor && cursor.before > ceiling + 1) throw new StateError("INVALID_INPUT", "status cursor 超出快照边界。");
  const rows = db.prepare(`SELECT rowid _row,${query.columns} FROM ${query.table}
    WHERE ${query.where} AND rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT ?`)
    .all(...params, ceiling, cursor?.before ?? Number.MAX_SAFE_INTEGER, size + 1) as StatusRow[];
  return { rows, ceiling };
}

export function publicStatusRow(row: StatusRow): Record<string, unknown> {
  const { _row, ...result } = row;
  void _row;
  return result;
}
