import type { DatabaseSync } from "node:sqlite";
import { readHostVerifierFailureClass, type HostVerifierFailureClass } from "./hostVerifierFailure.ts";
import { listJobs, TERMINAL, type JobRow } from "./jobs.ts";
import { HOST_VERIFIER_POLICY_VERSION } from "./hostVerifierSandbox.ts";

export type HostVerifierOperationalState = "idle" | "running" | "blocked";
export type HostVerifierOperationalResult =
  | "running"
  | "passed"
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
  if (!TERMINAL.has(job.state)) {
    return { result: "running", failureClass: null, reason: null };
  }

  const summary = job.summary ?? {};
  if (job.state === "passed" && summary.kind === "host-verifier-v2") {
    return { result: "passed", failureClass: null, reason: null };
  }
  if (summary.kind === "host-verifier-v2-stale") {
    return {
      result: "integrity_failed",
      failureClass: "integrity",
      reason: typeof summary.staleReason === "string" ? summary.staleReason : "sha_mismatch",
    };
  }

  const explicit = readHostVerifierFailureClass(summary.failureClass);
  if (explicit) {
    return {
      result: `${explicit}_failed` as Exclude<HostVerifierOperationalResult, "running" | "passed">,
      failureClass: explicit,
      reason: typeof summary.reason === "string" ? summary.reason : `${explicit}_failure`,
    };
  }
  if (summary.testFailure === true && summary.infrastructureFailure !== true) {
    return { result: "candidate_failed", failureClass: "candidate", reason: "test_failed" };
  }
  if (summary.infrastructureFailure === true || job.state === "timeout" || job.state === "killed") {
    return {
      result: "infrastructure_failed",
      failureClass: "infrastructure",
      reason: typeof summary.reason === "string" ? summary.reason : job.state === "timeout" ? "timeout" : "infrastructure_failure",
    };
  }

  // A terminal host-verifier row that is not a trusted V2 pass and cannot be
  // classified as a known candidate/infra failure is an integrity signal. Do
  // not guess it into a retryable bucket.
  return { result: "integrity_failed", failureClass: "integrity", reason: "unrecognized_verifier_result" };
}

function durationMs(job: JobRow): number | null {
  if (job.endedAt === null) return null;
  return Math.max(0, job.endedAt - job.startedAt);
}

function consecutiveInfrastructureFailures(jobs: readonly JobRow[], sha: string | null): number {
  if (!sha) return 0;
  let count = 0;
  for (const job of jobs) {
    if (summarySha(job) !== sha) continue;
    const classified = resultFor(job);
    if (classified.failureClass !== "infrastructure") break;
    count += 1;
  }
  return count;
}

export function projectHostVerifierOperationalStatus(
  db: DatabaseSync,
  options: {
    mode: "manual" | "auto";
    verifierBuild: string;
    currentSha?: string | null;
    currentTaskId?: string | null;
  },
): HostVerifierOperationalStatus {
  const jobs = listJobs(db).filter((job) => job.profile === "host-verifier");
  const latest = jobs[0] ?? null;
  const latestClassified = latest ? resultFor(latest) : null;
  const active = jobs.find((job) => !TERMINAL.has(job.state)) ?? null;
  const success = jobs.find((job) => resultFor(job).result === "passed") ?? null;
  const failure = jobs.find((job) => resultFor(job).failureClass !== null) ?? null;
  const failureClassified = failure ? resultFor(failure) : null;
  const latestSha = latest ? summarySha(latest) : null;
  const infraFailures = latestClassified?.failureClass === "infrastructure"
    ? consecutiveInfrastructureFailures(jobs, latestSha)
    : 0;

  let state: HostVerifierOperationalState = "idle";
  if (active) state = "running";
  else if (
    latestClassified?.failureClass === "candidate"
    || latestClassified?.failureClass === "integrity"
    || infraFailures >= 2
  ) state = "blocked";

  const currentSha = options.currentSha ?? null;
  const current = currentSha === null
    ? null
    : jobs.find((job) => (
        summarySha(job) === currentSha
        && (options.currentTaskId == null || job.taskId === options.currentTaskId)
      )) ?? null;

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
