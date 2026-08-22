import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { buildHostVerifierStaticPlan } from "./hostVerifier.ts";
import {
  readHostVerifierFailureClass,
  type HostVerifierFailureClass,
  type HostVerifierIntegrityFailure,
  type HostVerifierIntegrityReason,
} from "./hostVerifierFailure.ts";
import type { HostVerificationPlan, RunnableHostVerificationLevel } from "./hostVerification.ts";
import { getJob, listJobs, TERMINAL, type JobRow, type JobState } from "./jobs.ts";
import { planTaskHostVerification, type TaskHostVerificationPlan } from "./outerTest.ts";
import {
  computeOuterTestPlanDigest,
  getOuterTestReceipt,
  type HostVerifierResourceLimits,
  type OuterTestReceiptV2,
} from "./outerTestReceipt.ts";
import type { TaskRow } from "./tasks.ts";

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function includesAll(actual: readonly string[], required: readonly string[]): boolean {
  const set = new Set(actual);
  return required.every((value) => set.has(value));
}

function validLimits(value: unknown): value is HostVerifierResourceLimits {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HostVerifierResourceLimits>;
  return Number.isInteger(candidate.wallTimeoutMs) && (candidate.wallTimeoutMs ?? 0) > 0
    && Number.isInteger(candidate.maxRssMb) && (candidate.maxRssMb ?? 0) > 0
    && Number.isInteger(candidate.maxOutputBytes) && (candidate.maxOutputBytes ?? 0) > 0;
}

function sameLimits(a: unknown, b: HostVerifierResourceLimits): boolean {
  if (!validLimits(a)) return false;
  return a.wallTimeoutMs === b.wallTimeoutMs
    && a.maxRssMb === b.maxRssMb
    && a.maxOutputBytes === b.maxOutputBytes;
}

function sufficientLevel(actual: unknown, required: RunnableHostVerificationLevel): actual is RunnableHostVerificationLevel {
  return actual === "full" || actual === required;
}

function validPorts(value: unknown, productionPort: number): value is number[] {
  return Array.isArray(value)
    && value.length <= 8
    && value.every((port) => Number.isInteger(port) && port >= 1 && port <= 65_535 && port !== productionPort)
    && new Set(value).size === value.length;
}

type V2Validation = { ok: true } | { ok: false; reason: HostVerifierIntegrityReason };

function v2MatchesTrustedJob(
  db: DatabaseSync,
  receipt: OuterTestReceiptV2,
  plan: HostVerificationPlan,
  productionPort: number,
): V2Validation {
  const job = getJob(db, receipt.jobId);
  if (!job || job.taskId !== receipt.taskId || job.profile !== "host-verifier") {
    return { ok: false, reason: "receipt_result_binding_mismatch" };
  }
  if (job.state !== "passed" || job.exitCode !== 0 || job.endedAt === null || !job.summary) {
    return { ok: false, reason: "receipt_result_binding_mismatch" };
  }
  const summary = job.summary;
  if (summary.kind !== "host-verifier-v2") return { ok: false, reason: "receipt_result_binding_mismatch" };
  if (summary.mode !== receipt.mode || summary.repoId !== receipt.repoId || summary.commit !== receipt.commit) {
    return { ok: false, reason: "receipt_result_binding_mismatch" };
  }
  if (!sufficientLevel(summary.level, plan.level as RunnableHostVerificationLevel)) {
    return { ok: false, reason: "verifier_identity_mismatch" };
  }
  if (!Array.isArray(summary.files) || !summary.files.every((file) => typeof file === "string")) {
    return { ok: false, reason: "verifier_identity_mismatch" };
  }
  if (!Number.isInteger(summary.policyVersion) || (summary.policyVersion as number) < 1) {
    return { ok: false, reason: "verifier_identity_mismatch" };
  }
  if (!validLimits(summary.resourceLimits)) return { ok: false, reason: "verifier_identity_mismatch" };
  if (!validPorts(summary.loopbackPorts, productionPort)) return { ok: false, reason: "policy_rejection" };

  const summaryLevel = summary.level as RunnableHostVerificationLevel;
  const currentStatic = buildHostVerifierStaticPlan(summaryLevel);
  if (summary.policyVersion !== currentStatic.policyVersion) {
    return { ok: false, reason: "verifier_identity_mismatch" };
  }
  if (!sameLimits(summary.resourceLimits, currentStatic.resourceLimits)) {
    return { ok: false, reason: "verifier_identity_mismatch" };
  }

  if (plan.manualOnlyRequired) {
    if (receipt.mode !== "manual") return { ok: false, reason: "policy_rejection" };
    const required = [...plan.autoFiles, ...plan.manualOnlyFiles];
    if (!includesAll(summary.files as string[], required)) return { ok: false, reason: "policy_rejection" };
  } else if (!sameStrings(summary.files as string[], currentStatic.files)) {
    return { ok: false, reason: "verifier_identity_mismatch" };
  }

  const finalDigest = computeOuterTestPlanDigest({
    level: summaryLevel,
    files: summary.files as string[],
    policyVersion: summary.policyVersion as number,
    resourceLimits: summary.resourceLimits,
    loopbackPorts: summary.loopbackPorts,
  });
  if (receipt.planDigest !== finalDigest) return { ok: false, reason: "receipt_result_binding_mismatch" };
  if (!sameStrings(receipt.files, summary.files as string[])) return { ok: false, reason: "receipt_result_binding_mismatch" };
  if (receipt.level !== summaryLevel) return { ok: false, reason: "receipt_result_binding_mismatch" };
  if (receipt.startedAt !== job.startedAt || receipt.endedAt !== job.endedAt) {
    return { ok: false, reason: "receipt_result_binding_mismatch" };
  }
  return { ok: true };
}

export interface HostVerifierAttempt {
  jobId: string;
  state: JobState;
  kind: "running" | "test" | "infrastructure" | "integrity";
  failureClass?: HostVerifierFailureClass | null;
  reason?: string | null;
  infrastructureFailures: number;
  artifactPath: string | null;
  artifactExcerpt: string | null;
}

function boundedArtifactExcerpt(path: string | null): string | null {
  if (!path) return null;
  try {
    const text = readFileSync(path, "utf8");
    return text.slice(-4000);
  } catch {
    return null;
  }
}

function jobFailureClass(job: JobRow): HostVerifierFailureClass | null {
  const explicit = readHostVerifierFailureClass(job.summary?.failureClass);
  if (explicit) return explicit;
  if (job.summary?.kind === "host-verifier-v2-stale") return "integrity";
  if (job.summary?.testFailure === true && job.summary.infrastructureFailure !== true) return "candidate";
  if (job.summary?.infrastructureFailure === true || job.state === "timeout" || job.state === "killed") return "infrastructure";
  return null;
}

function jobFailureReason(job: JobRow, failureClass: HostVerifierFailureClass): string {
  if (typeof job.summary?.reason === "string") return job.summary.reason;
  if (failureClass === "candidate") return "test_failed";
  if (failureClass === "infrastructure") {
    if (job.state === "timeout") return "timeout";
    if (job.state === "killed") return "process_killed";
    return "infrastructure_failure";
  }
  if (job.summary?.kind === "host-verifier-v2-stale") return "sha_mismatch";
  return "unrecognized_verifier_result";
}

function latestMatchingAttempt(db: DatabaseSync, taskId: string, commit: string): HostVerifierAttempt | null {
  const jobs = listJobs(db, taskId).filter((job) => {
    if (job.profile !== "host-verifier" || !job.summary) return false;
    return job.summary.commit === commit;
  });
  const latest = jobs[0];
  if (!latest) return null;
  if (!TERMINAL.has(latest.state)) {
    return {
      jobId: latest.jobId,
      state: latest.state,
      kind: "running",
      failureClass: null,
      reason: null,
      infrastructureFailures: 0,
      artifactPath: latest.artifactPath,
      artifactExcerpt: null,
    };
  }

  const failureClass = jobFailureClass(latest);
  if (!failureClass) return null;
  const reason = jobFailureReason(latest, failureClass);
  if (failureClass === "candidate") {
    return {
      jobId: latest.jobId,
      state: latest.state,
      kind: "test",
      failureClass,
      reason,
      infrastructureFailures: 0,
      artifactPath: latest.artifactPath,
      artifactExcerpt: boundedArtifactExcerpt(latest.artifactPath),
    };
  }
  if (failureClass === "integrity") {
    return {
      jobId: latest.jobId,
      state: latest.state,
      kind: "integrity",
      failureClass,
      reason,
      infrastructureFailures: 0,
      artifactPath: latest.artifactPath,
      artifactExcerpt: boundedArtifactExcerpt(latest.artifactPath),
    };
  }

  let infrastructureFailures = 0;
  for (const job of jobs) {
    if (jobFailureClass(job) === "infrastructure") {
      infrastructureFailures += 1;
      continue;
    }
    break;
  }
  return {
    jobId: latest.jobId,
    state: latest.state,
    kind: "infrastructure",
    failureClass,
    reason,
    infrastructureFailures,
    artifactPath: latest.artifactPath,
    artifactExcerpt: boundedArtifactExcerpt(latest.artifactPath),
  };
}

export interface CurrentHostVerification {
  plan: TaskHostVerificationPlan;
  receiptEligible: boolean;
  latestAttempt: HostVerifierAttempt | null;
  integrityFailure: HostVerifierIntegrityFailure | null;
}

function attemptIntegrityFailure(attempt: HostVerifierAttempt | null): HostVerifierIntegrityFailure | null {
  if (attempt?.kind !== "integrity") return null;
  return {
    failureClass: "integrity",
    reason: attempt.reason ?? "unrecognized_verifier_result",
    jobId: attempt.jobId,
  };
}

/**
 * Recompute the trusted host plan from task.baseCommit..current PR head and decide
 * whether the stored receipt is still eligible. V2 is bound back to its terminal
 * trusted job; V1 is accepted only as the explicit manual-transition path and must
 * cover every currently required host file.
 */
export function inspectCurrentHostVerification(
  db: DatabaseSync,
  task: TaskRow,
  commit: string,
  productionPort = Number(process.env.PORT ?? "8787"),
): CurrentHostVerification {
  const plan = planTaskHostVerification(task, commit);
  const latestAttempt = latestMatchingAttempt(db, task.taskId, commit);
  const attemptIntegrity = attemptIntegrityFailure(latestAttempt);
  if (plan.level === "none") {
    return { plan, receiptEligible: true, latestAttempt, integrityFailure: null };
  }
  const receipt = getOuterTestReceipt(db, task.taskId);
  if (!receipt) {
    return { plan, receiptEligible: false, latestAttempt, integrityFailure: attemptIntegrity };
  }

  if (!("version" in receipt)) {
    const required = plan.manualOnlyRequired
      ? [...plan.autoFiles, ...plan.manualOnlyFiles]
      : plan.autoFiles;
    return {
      plan,
      latestAttempt,
      integrityFailure: attemptIntegrity,
      receiptEligible: receipt.taskId === task.taskId
        && receipt.commit === commit
        && receipt.profile === "unit-selfhost"
        && includesAll(receipt.files, required),
    };
  }

  // A V2 receipt for another exact SHA is simply stale historical evidence. It must
  // not be reused, but it is not itself an integrity escalation for the new SHA.
  if (receipt.commit !== commit) {
    return { plan, receiptEligible: false, latestAttempt, integrityFailure: attemptIntegrity };
  }
  if (receipt.taskId !== task.taskId || receipt.repoId !== task.repoId) {
    return {
      plan,
      receiptEligible: false,
      latestAttempt,
      integrityFailure: { failureClass: "integrity", reason: "receipt_result_binding_mismatch", jobId: receipt.jobId },
    };
  }
  if (!sufficientLevel(receipt.level, plan.level)) {
    return {
      plan,
      receiptEligible: false,
      latestAttempt,
      integrityFailure: { failureClass: "integrity", reason: "verifier_identity_mismatch", jobId: receipt.jobId },
    };
  }
  const validation = v2MatchesTrustedJob(db, receipt, plan, productionPort);
  if (!validation.ok) {
    return {
      plan,
      receiptEligible: false,
      latestAttempt,
      integrityFailure: { failureClass: "integrity", reason: validation.reason, jobId: receipt.jobId },
    };
  }
  return { plan, receiptEligible: true, latestAttempt, integrityFailure: null };
}

export function manualOuterTestCommand(taskId: string): string {
  return `grande outer-test --task ${taskId} --run`;
}
