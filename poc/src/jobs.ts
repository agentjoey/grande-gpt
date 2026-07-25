import { randomUUID } from "node:crypto";
import { getRepo } from "./fixtures.ts";

export type JobState = "running" | "passed" | "failed";

export interface JobStatus {
  jobId: string;
  taskId: string;
  profile: string;
  state: JobState;
  exitCode: number | null;
  durationMs: number;
  failedTests: string[];
  tail: string[];
  artifactId: string;
}

/** 必须让 job 真的耗时，否则 P-1「模型是否自主轮询」无从观察 */
export const JOB_DURATION_MS = Number(process.env.POC_JOB_DURATION_MS ?? 20_000);

interface JobRecord {
  jobId: string;
  taskId: string;
  profile: string;
  startedAt: number;
  /** 结果在启动时刻定格，模拟真实执行——启动后改文件不影响本次结果 */
  willPass: boolean;
}

const jobs = new Map<string, JobRecord>();
const jobsByTask = new Map<string, string[]>();

export function resetJobs(): void {
  jobs.clear();
  jobsByTask.clear();
}

export function startJob(args: { taskId: string; repoId: string; profile: string }): { jobId: string } {
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  const repo = getRepo(args.repoId);
  jobs.set(jobId, {
    jobId,
    taskId: args.taskId,
    profile: args.profile,
    startedAt: Date.now(),
    willPass: repo?.isFixed() ?? false,
  });
  const list = jobsByTask.get(args.taskId) ?? [];
  list.push(jobId);
  jobsByTask.set(args.taskId, list);
  return { jobId };
}

const FAIL_TAIL = [
  "$ vitest run",
  "",
  " ❯ tests/parser.test.ts (2 tests | 1 failed)",
  "   ✓ parser > splits on comma",
  "   × parser > handles empty input",
  "",
  "  AssertionError: expected [ '' ] to deeply equal []",
  "   ❯ tests/parser.test.ts:12:26",
  "",
  " Test Files  1 failed (1)",
  "      Tests  1 failed | 1 passed (2)",
];

const PASS_TAIL = [
  "$ vitest run",
  "",
  " ✓ tests/parser.test.ts (2 tests)",
  "",
  " Test Files  1 passed (1)",
  "      Tests  2 passed (2)",
];

export function getJobStatus(jobId: string): JobStatus | undefined {
  const rec = jobs.get(jobId);
  if (!rec) return undefined;

  const elapsed = Date.now() - rec.startedAt;
  const done = elapsed >= JOB_DURATION_MS;
  const state: JobState = !done ? "running" : rec.willPass ? "passed" : "failed";

  return {
    jobId: rec.jobId,
    taskId: rec.taskId,
    profile: rec.profile,
    state,
    exitCode: !done ? null : rec.willPass ? 0 : 1,
    durationMs: done ? JOB_DURATION_MS : elapsed,
    failedTests: state === "failed" ? ["parser > handles empty input"] : [],
    tail: !done ? [] : rec.willPass ? PASS_TAIL : FAIL_TAIL,
    artifactId: `art_${rec.jobId.replace("job_", "")}`,
  };
}

export function lastJobStateForTask(taskId: string): string | null {
  const list = jobsByTask.get(taskId);
  if (!list || list.length === 0) return null;
  const lastId = list[list.length - 1] as string;
  return getJobStatus(lastId)?.state ?? null;
}
