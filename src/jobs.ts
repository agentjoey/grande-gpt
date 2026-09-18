import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import { TERMINAL_JOB_STATES, type JobState as ContractJobState } from "./contract.ts";

/** Job states have one source of truth shared with Console. */
export type JobState = ContractJobState;

export interface JobRow {
  jobId: string;
  taskId: string;
  profile: string;
  argv: string[];
  state: JobState;
  pgid: number | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  artifactPath: string | null;
  summary: Record<string, unknown> | null;
}

export const TERMINAL: ReadonlySet<JobState> = new Set(TERMINAL_JOB_STATES);

function toRow(r: Record<string, unknown>): JobRow {
  return {
    jobId: r.jobId as string,
    taskId: r.taskId as string,
    profile: r.profile as string,
    argv: JSON.parse((r.argv as string) || "[]") as string[],
    state: r.state as JobState,
    pgid: (r.pgid as number | null) ?? null,
    exitCode: (r.exitCode as number | null) ?? null,
    startedAt: r.startedAt as number,
    endedAt: (r.endedAt as number | null) ?? null,
    artifactPath: (r.artifactPath as string | null) ?? null,
    summary: r.summary ? (JSON.parse(r.summary as string) as Record<string, unknown>) : null,
  };
}

export function createJob(
  db: DatabaseSync,
  j: { jobId: string; taskId: string; profile: string; argv: string[]; pgid: number | null },
): JobRow {
  const now = Date.now();
  db.prepare(
    "INSERT INTO job (jobId,taskId,profile,argv,state,pgid,startedAt) VALUES (?,?,?,?,'running',?,?)",
  ).run(j.jobId, j.taskId, j.profile, JSON.stringify(j.argv), j.pgid, now);
  return {
    ...j, state: "running", exitCode: null, startedAt: now,
    endedAt: null, artifactPath: null, summary: null,
  };
}

export function getJob(db: DatabaseSync, jobId: string): JobRow | undefined {
  const r = db.prepare("SELECT * FROM job WHERE jobId = ?").get(jobId);
  return r ? toRow(r as Record<string, unknown>) : undefined;
}

/** One-shot CAS for the detached process group discovered after async preparation. */
export function setRunningJobPgid(db: DatabaseSync, jobId: string, pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) throw new StateError("INVALID_INPUT", "pgid 必须是正整数。");
  const res = db.prepare(
    `UPDATE job SET pgid=?, summary=CASE WHEN json_type(summary,'$.resourceOwner')='object'
      THEN json_set(summary,'$.resourceOwner.phase','running') ELSE summary END
      WHERE jobId=? AND state='running' AND pgid IS NULL`,
  ).run(pgid, jobId);
  if (res.changes > 0) return true;
  if (!getJob(db, jobId)) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
  return false;
}

/** Domain summaries cannot erase a live supervisor's durable ownership marker. */
const PRESERVE_OWNER = `CASE WHEN json_type(summary,'$.resourceOwner')='object'
  THEN json_set(COALESCE(?,'{}'),'$.resourceOwner',json_extract(summary,'$.resourceOwner')) ELSE ? END`;

export function setRunningJobSummary(
  db: DatabaseSync,
  jobId: string,
  summary: Record<string, unknown>,
): boolean {
  const text = JSON.stringify(summary);
  const res = db.prepare(
    `UPDATE job SET summary=${PRESERVE_OWNER} WHERE jobId=? AND state='running'`,
  ).run(text, text, jobId);
  if (res.changes > 0) return true;
  if (!getJob(db, jobId)) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
  return false;
}

export function listJobs(db: DatabaseSync, taskId?: string): JobRow[] {
  const rows = taskId
    ? db.prepare("SELECT * FROM job WHERE taskId = ? ORDER BY startedAt DESC, rowid DESC").all(taskId)
    : db.prepare("SELECT * FROM job ORDER BY startedAt DESC, rowid DESC").all();
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

/** Avoid materializing historical job output while inspecting execution capacity. */
export function listNonterminalJobs(db: DatabaseSync, taskId?: string): JobRow[] {
  const marks = TERMINAL_JOB_STATES.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM job WHERE state NOT IN (${marks})${taskId ? " AND taskId=?" : ""}
    ORDER BY startedAt, rowid`).all(...TERMINAL_JOB_STATES, ...(taskId ? [taskId] : []));
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

export function finishJob(
  db: DatabaseSync,
  jobId: string,
  r: {
    state: Exclude<JobState, "running">;
    exitCode: number | null;
    artifactPath: string | null;
    summary: Record<string, unknown> | null;
  },
): JobRow | undefined {
  const text = r.summary ? JSON.stringify(r.summary) : null;
  const res = db.prepare(
    `UPDATE job SET state=?, exitCode=?, endedAt=?, artifactPath=?, summary=${PRESERVE_OWNER}
      WHERE jobId=? AND state='running'`,
  ).run(r.state, r.exitCode, Date.now(), r.artifactPath, text, text, jobId);
  if (res.changes === 0) {
    if (!getJob(db, jobId)) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
    return undefined;
  }
  const updated = getJob(db, jobId);
  if (!updated) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
  return updated;
}

/** A live/unknown owner may still be preparing, collecting output, or persisting receipts. */
export function hasUnsettledResourceOwner(job: JobRow): boolean {
  const value = job.summary?.resourceOwner;
  if (value === undefined) return false;
  if (!value || typeof value !== "object") return true;
  const owner = value as { pid?: unknown; phase?: unknown };
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true; }
  // The owner died between launch and pgid persistence. No TTL can prove there is no child.
  return job.pgid === null && owner.phase !== "preparing";
}

export function reconcileRunningJobs(db: DatabaseSync, isAlive: (pgid: number) => boolean): number {
  let n = 0;
  for (const j of listNonterminalJobs(db)) {
    if (hasUnsettledResourceOwner(j)) continue;
    if (j.pgid !== null && isAlive(j.pgid)) continue;
    const result = finishJob(db, j.jobId, {
      state: "killed", exitCode: null, artifactPath: j.artifactPath,
      summary: { reconciled: true, reason: j.pgid === null ? "无 pgid，无法探活" : "进程组已消失" },
    });
    if (result) n++;
  }
  return n;
}
