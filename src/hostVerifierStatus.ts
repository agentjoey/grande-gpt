import type { DatabaseSync } from "node:sqlite";
import { readHostVerifierFailureClass, type HostVerifierFailureClass } from "./hostVerifierFailure.ts";
import { getJob, TERMINAL, type JobRow } from "./jobs.ts";
import { HOST_VERIFIER_POLICY_VERSION } from "./hostVerifierSandbox.ts";

export type HostVerifierOperationalState = "idle" | "running" | "blocked";
export type HostVerifierOperationalResult =
  | "running"
  | "passed"
  | "cancelled"
  | "candidate_failed"
  | "infrastructure_failed"
  | "integrity_failed";

export interface HostVerifierOperationalStatus {
  mode: "manual" | "auto";
  enabled: boolean;
  state: HostVerifierOperationalState;
  lastAttemptAt: number | null;
  lastAttemptSha: string | null;
  lastResult: HostVerifierOperationalResult | null;
  lastDurationMs: number | null;
  lastSuccessAt: number | null;
  lastSuccessSha: string | null;
  lastFailureAt: number | null;
  lastFailureClass: HostVerifierFailureClass | null;
  lastFailureReason: string | null;
  activeJobId: string | null;
  queueDepth: 0;
  verifierBuild: string;
  verifierVersion: number;
  currentSha: string | null;
  currentResult: HostVerifierOperationalResult | null;
}

interface ClassifiedResult {
  result: HostVerifierOperationalResult;
  failureClass: HostVerifierFailureClass | null;
  reason: string | null;
}

function summarySha(job: JobRow): string | null {
  const commit = job.summary?.commit;
  return typeof commit === "string" && /^[0-9a-f]{40}$/u.test(commit) ? commit : null;
}

function resultFor(job: JobRow): ClassifiedResult {
  if (!TERMINAL.has(job.state)) return { result: "running", failureClass: null, reason: null };
  if (job.state === "cancelled") return { result: "cancelled", failureClass: null, reason: "cancellation_requested" };
  const summary = job.summary ?? {};
  if (job.state === "passed" && summary.kind === "host-verifier-v2") {
    return { result: "passed", failureClass: null, reason: null };
  }
  if (summary.kind === "host-verifier-v2-stale") {
    return { result: "integrity_failed", failureClass: "integrity",
      reason: typeof summary.staleReason === "string" ? summary.staleReason : "sha_mismatch" };
  }
  const explicit = readHostVerifierFailureClass(summary.failureClass);
  if (explicit) {
    return { result: `${explicit}_failed`, failureClass: explicit,
      reason: typeof summary.reason === "string" ? summary.reason : `${explicit}_failure` };
  }
  if (summary.testFailure === true && summary.infrastructureFailure !== true) {
    return { result: "candidate_failed", failureClass: "candidate", reason: "test_failed" };
  }
  if (summary.infrastructureFailure === true || job.state === "timeout" || job.state === "killed") {
    return { result: "infrastructure_failed", failureClass: "infrastructure",
      reason: typeof summary.reason === "string" ? summary.reason : job.state === "timeout" ? "timeout" : "infrastructure_failure" };
  }
  return { result: "integrity_failed", failureClass: "integrity", reason: "unrecognized_verifier_result" };
}

function durationMs(job: JobRow): number | null {
  return job.endedAt === null ? null : Math.max(0, job.endedAt - job.startedAt);
}

const COMMIT = "CASE WHEN json_valid(summary) THEN json_extract(summary,'$.commit') ELSE NULL END";
const KIND = "CASE WHEN json_valid(summary) THEN json_extract(summary,'$.kind') ELSE NULL END";

/** Constant-size latest/current observations. Never materialize every repository job for a status page. */
export function projectHostVerifierOperationalStatus(
  db: DatabaseSync,
  options: {
    mode: "manual" | "auto";
    verifierBuild: string;
    currentSha?: string | null;
    currentTaskId?: string | null;
  },
): HostVerifierOperationalStatus {
  const fetched = new Map<string, JobRow>();
  const select = (condition: string, parameters: string[] = [], limit = 1): JobRow[] => {
    const rows = db.prepare(`SELECT jobId FROM job WHERE profile='host-verifier' AND (${condition})
      ORDER BY startedAt DESC,rowid DESC LIMIT ?`).all(...parameters, limit) as { jobId: string }[];
    return rows.map(({ jobId }) => {
      let row = fetched.get(jobId);
      if (!row) { row = getJob(db, jobId)!; fetched.set(jobId, row); }
      return row;
    });
  };
  const latest = select("1")[0] ?? null;
  const latestClassified = latest ? resultFor(latest) : null;
  const active = select("state NOT IN ('passed','failed','timeout','killed','cancelled')")[0] ?? null;
  const success = select(`state='passed' AND ${KIND}='host-verifier-v2'`)[0] ?? null;
  const failure = select(`state IN ('passed','failed','timeout','killed') AND NOT (state='passed' AND COALESCE(${KIND},'')='host-verifier-v2')`)[0] ?? null;
  const failureClassified = failure ? resultFor(failure) : null;
  const latestSha = latest ? summarySha(latest) : null;
  // The retry policy stops at two failures; older history cannot change that decision.
  let infraFailures = 0;
  if (latestSha && latestClassified?.failureClass === "infrastructure") {
    for (const job of select(`${COMMIT}=?`, [latestSha], 2)) {
      if (resultFor(job).failureClass !== "infrastructure") break;
      infraFailures++;
    }
  }
  let state: HostVerifierOperationalState = "idle";
  if (active) state = "running";
  else if (latestClassified?.failureClass === "candidate" || latestClassified?.failureClass === "integrity" || infraFailures >= 2) {
    state = "blocked";
  }
  const currentSha = options.currentSha ?? null;
  const current = currentSha === null ? null : select(
    `${COMMIT}=?${options.currentTaskId == null ? "" : " AND taskId=?"}`,
    options.currentTaskId == null ? [currentSha] : [currentSha, options.currentTaskId],
  )[0] ?? null;
  return {
    mode: options.mode,
    enabled: options.mode === "auto",
    state,
    lastAttemptAt: latest?.startedAt ?? null,
    lastAttemptSha: latestSha,
    lastResult: latestClassified?.result ?? null,
    lastDurationMs: latest ? durationMs(latest) : null,
    lastSuccessAt: success?.endedAt ?? null,
    lastSuccessSha: success ? summarySha(success) : null,
    lastFailureAt: failure?.endedAt ?? null,
    lastFailureClass: failureClassified?.failureClass ?? null,
    lastFailureReason: failureClassified?.reason ?? null,
    activeJobId: active?.jobId ?? null,
    queueDepth: 0,
    verifierBuild: options.verifierBuild,
    verifierVersion: HOST_VERIFIER_POLICY_VERSION,
    currentSha,
    currentResult: current ? resultFor(current).result : null,
  };
}
