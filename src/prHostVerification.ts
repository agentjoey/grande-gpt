import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { buildHostVerifierStaticPlan } from "./hostVerifier.ts";
import type { HostVerificationPlan, RunnableHostVerificationLevel } from "./hostVerification.ts";
import { getJob, listJobs, TERMINAL, type JobState } from "./jobs.ts";
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

function v2MatchesTrustedJob(
  db: DatabaseSync,
  receipt: OuterTestReceiptV2,
  plan: HostVerificationPlan,
  productionPort: number,
): boolean {
  const job = getJob(db, receipt.jobId);
  if (!job || job.taskId !== receipt.taskId || job.profile !== "host-verifier") return false;
  if (job.state !== "passed" || job.exitCode !== 0 || job.endedAt === null || !job.summary) return false;
  const summary = job.summary;
  if (summary.kind !== "host-verifier-v2") return false;
  if (summary.mode !== receipt.mode || summary.repoId !== receipt.repoId || summary.commit !== receipt.commit) return false;
  if (!sufficientLevel(summary.level, plan.level as RunnableHostVerificationLevel)) return false;
  if (!Array.isArray(summary.files) || !summary.files.every((file) => typeof file === "string")) return false;
  if (!Number.isInteger(summary.policyVersion) || (summary.policyVersion as number) < 1) return false;
  if (!validLimits(summary.resourceLimits)) return false;
  if (!validPorts(summary.loopbackPorts, productionPort)) return false;

  const summaryLevel = summary.level as RunnableHostVerificationLevel;
  const currentStatic = buildHostVerifierStaticPlan(summaryLevel);
  if (summary.policyVersion !== currentStatic.policyVersion) return false;
  if (!sameLimits(summary.resourceLimits, currentStatic.resourceLimits)) return false;

  if (plan.manualOnlyRequired) {
    if (receipt.mode !== "manual") return false;
    const required = [...plan.autoFiles, ...plan.manualOnlyFiles];
    if (!includesAll(summary.files as string[], required)) return false;
  } else if (!sameStrings(summary.files as string[], currentStatic.files)) {
    return false;
  }

  const finalDigest = computeOuterTestPlanDigest({
    level: summaryLevel,
    files: summary.files as string[],
    policyVersion: summary.policyVersion as number,
    resourceLimits: summary.resourceLimits,
    loopbackPorts: summary.loopbackPorts,
  });
  if (receipt.planDigest !== finalDigest) return false;
  if (!sameStrings(receipt.files, summary.files as string[])) return false;
  if (receipt.level !== summaryLevel) return false;
  if (receipt.startedAt !== job.startedAt || receipt.endedAt !== job.endedAt) return false;
  return true;
}

export interface HostVerifierAttempt {
  jobId: string;
  state: JobState;
  kind: "running" | "test" | "infrastructure";
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
      infrastructureFailures: 0,
      artifactPath: latest.artifactPath,
      artifactExcerpt: null,
    };
  }
  if (latest.summary?.kind !== "host-verifier-failure") return null;
  if (latest.summary.testFailure === true && latest.summary.infrastructureFailure !== true) {
    return {
      jobId: latest.jobId,
      state: latest.state,
      kind: "test",
      infrastructureFailures: 0,
      artifactPath: latest.artifactPath,
      artifactExcerpt: boundedArtifactExcerpt(latest.artifactPath),
    };
  }
  if (latest.summary.infrastructureFailure === true) {
    let infrastructureFailures = 0;
    for (const job of jobs) {
      if (job.summary?.kind === "host-verifier-failure" && job.summary.infrastructureFailure === true) {
        infrastructureFailures += 1;
        continue;
      }
      break;
    }
    return {
      jobId: latest.jobId,
      state: latest.state,
      kind: "infrastructure",
      infrastructureFailures,
      artifactPath: latest.artifactPath,
      artifactExcerpt: boundedArtifactExcerpt(latest.artifactPath),
    };
  }
  return null;
}

export interface CurrentHostVerification {
  plan: TaskHostVerificationPlan;
  receiptEligible: boolean;
  latestAttempt: HostVerifierAttempt | null;
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
  if (plan.level === "none") return { plan, receiptEligible: true, latestAttempt };
  const receipt = getOuterTestReceipt(db, task.taskId);
  if (!receipt) return { plan, receiptEligible: false, latestAttempt };

  if (!("version" in receipt)) {
    const required = plan.manualOnlyRequired
      ? [...plan.autoFiles, ...plan.manualOnlyFiles]
      : plan.autoFiles;
    return {
      plan,
      latestAttempt,
      receiptEligible: receipt.taskId === task.taskId
        && receipt.commit === commit
        && receipt.profile === "unit-selfhost"
        && includesAll(receipt.files, required),
    };
  }

  if (receipt.taskId !== task.taskId || receipt.repoId !== task.repoId || receipt.commit !== commit) {
    return { plan, receiptEligible: false, latestAttempt };
  }
  if (!sufficientLevel(receipt.level, plan.level)) return { plan, receiptEligible: false, latestAttempt };
  return { plan, receiptEligible: v2MatchesTrustedJob(db, receipt, plan, productionPort), latestAttempt };
}

export function manualOuterTestCommand(taskId: string): string {
  return `grande outer-test --task ${taskId} --run`;
}
