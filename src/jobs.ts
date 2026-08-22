import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import { TERMINAL_JOB_STATES, type JobState as ContractJobState } from "./contract.ts";

/**
 * 单一真相源在 `contract.ts`。**控制台的图表按同一份枚举分类**——
 * 上一版两边各写一遍，结果控制台只认三个值，墙钟超时的 job 在图上没有名字。
 */
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
    "UPDATE job SET pgid=? WHERE jobId=? AND state='running' AND pgid IS NULL",
  ).run(pgid, jobId);
  if (res.changes > 0) return true;
  if (!getJob(db, jobId)) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
  return false;
}

/**
 * Parent-written preparation metadata for restart reconciliation. Terminal CAS
 * always wins later via finishJob and cannot be overwritten by this helper.
 */
export function setRunningJobSummary(
  db: DatabaseSync,
  jobId: string,
  summary: Record<string, unknown>,
): boolean {
  const res = db.prepare(
    "UPDATE job SET summary=? WHERE jobId=? AND state='running'",
  ).run(JSON.stringify(summary), jobId);
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
  const res = db.prepare(
    "UPDATE job SET state=?, exitCode=?, endedAt=?, artifactPath=?, summary=? WHERE jobId=? AND state='running'",
  ).run(
    r.state, r.exitCode, Date.now(), r.artifactPath,
    r.summary ? JSON.stringify(r.summary) : null, jobId,
  );
  if (res.changes === 0) {
    if (!getJob(db, jobId)) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
    return undefined;
  }
  const updated = getJob(db, jobId);
  if (!updated) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
  return updated;
}

export function reconcileRunningJobs(db: DatabaseSync, isAlive: (pgid: number) => boolean): number {
  let n = 0;
  for (const j of listJobs(db)) {
    if (TERMINAL.has(j.state)) continue;
    if (j.pgid !== null && isAlive(j.pgid)) continue;
    const result = finishJob(db, j.jobId, {
      state: "killed", exitCode: null, artifactPath: j.artifactPath,
      summary: { reconciled: true, reason: j.pgid === null ? "无 pgid，无法探活" : "进程组已消失" },
    });
    if (result) n++;
  }
  return n;
}
