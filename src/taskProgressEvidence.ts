import type { DatabaseSync } from "node:sqlite";
import type { AttestationRow } from "./attestation.ts";
import { StateError } from "./errors.ts";
import { getJob, TERMINAL, type JobRow } from "./jobs.ts";
import { isValidHostToolchainIdentity } from "./packageManagerIdentity.ts";
import type { TaskRow } from "./tasks.ts";

export interface TaskProgressEvidence {
  attestation: AttestationRow | null;
  latestJob: JobRow | undefined;
  hasRunningJob: boolean;
  progressAt: number;
}

/** Exact-head lookup, not a materialized history. The shared toolchain validator remains authoritative. */
export function readHeadAttestation(db: DatabaseSync, taskId: string, head: string): AttestationRow | null {
  if (!head) return null;
  const row = db.prepare(`SELECT * FROM attestation WHERE taskId=? AND "commit"=? AND exitCode=0
    ORDER BY endedAt DESC,rowid DESC LIMIT 1`).get(taskId, head) as Record<string, unknown> | undefined;
  if (!row) return null;
  let hostToolchain: unknown;
  try { hostToolchain = JSON.parse(row.hostToolchain as string); }
  catch { throw new StateError("INVALID_INPUT", "exact-head attestation toolchain is unreadable"); }
  if (!isValidHostToolchainIdentity(hostToolchain)) throw new StateError("INVALID_INPUT", "exact-head attestation toolchain is incomplete");
  return {
    attestationId: row.attestationId as string, taskId: row.taskId as string,
    commit: row.commit as string, profile: row.profile as string, jobId: row.jobId as string,
    exitCode: row.exitCode as number, startedAt: row.startedAt as number, endedAt: row.endedAt as number,
    hostToolchain,
  };
}

/** Constant-size evidence for a single projection. History views paginate separately in SQL. */
export function readTaskProgressEvidence(db: DatabaseSync, task: TaskRow, head: string): TaskProgressEvidence {
  const latest = db.prepare("SELECT jobId FROM job WHERE taskId=? ORDER BY startedAt DESC,rowid DESC LIMIT 1")
    .get(task.taskId) as { jobId: string } | undefined;
  const terminal = [...TERMINAL];
  const hasRunningJob = db.prepare(`SELECT 1 FROM job WHERE taskId=? AND state NOT IN (${terminal.map(() => "?").join(",")}) LIMIT 1`)
    .get(task.taskId, ...terminal) !== undefined;
  const times = db.prepare("SELECT MAX(startedAt) startedAt,MAX(endedAt) endedAt FROM job WHERE taskId=?")
    .get(task.taskId) as { startedAt: number | null; endedAt: number | null };
  const audit = db.prepare("SELECT MAX(updatedAt) at FROM audit WHERE taskId=? AND state='SUCCEEDED'")
    .get(task.taskId) as { at: number | null };
  return {
    attestation: readHeadAttestation(db, task.taskId, head),
    latestJob: latest ? getJob(db, latest.jobId) : undefined,
    hasRunningJob,
    progressAt: Math.max(task.updatedAt, times.startedAt ?? 0, times.endedAt ?? 0, audit.at ?? 0),
  };
}
