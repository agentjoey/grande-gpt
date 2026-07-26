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

const UNIT_FAIL_TAIL = [
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

const UNIT_PASS_TAIL = [
  "$ vitest run",
  "",
  " ✓ tests/parser.test.ts (2 tests)",
  "",
  " Test Files  1 passed (1)",
  "      Tests  2 passed (2)",
];

const LINT_TAIL = ["$ eslint .", "", "  0 problems (0 errors, 0 warnings)"];

const TYPECHECK_TAIL = ["$ tsc --noEmit", "", "  No type errors found."];

/**
 * profile → 输出。第一轮实测中模型指出：跑 `lint` 和 `typecheck` 得到的都是
 * `$ vitest run` 的输出，与 package.json 声明的 `eslint .` / `tsc --noEmit`
 * 对不上，因此它明确拒绝声称 lint/typecheck 通过——那个判断是对的，
 * 原实现只按 willPass 二选一，profile 存了却从不参与决定输出。
 *
 * 只有 unit 与场景（parser 空输入缺陷）绑定，会有失败态；lint 与 typecheck
 * 不属于该场景，恒为通过。
 */
function tailFor(profile: string, willPass: boolean): string[] {
  if (profile === "lint") return LINT_TAIL;
  if (profile === "typecheck") return TYPECHECK_TAIL;
  return willPass ? UNIT_PASS_TAIL : UNIT_FAIL_TAIL;
}

/** lint / typecheck 不参与 parser 场景，恒通过 */
function passesFor(profile: string, willPass: boolean): boolean {
  return profile === "lint" || profile === "typecheck" ? true : willPass;
}

export function getJobStatus(jobId: string): JobStatus | undefined {
  const rec = jobs.get(jobId);
  if (!rec) return undefined;

  const elapsed = Date.now() - rec.startedAt;
  const done = elapsed >= JOB_DURATION_MS;
  const passes = passesFor(rec.profile, rec.willPass);
  const state: JobState = !done ? "running" : passes ? "passed" : "failed";

  return {
    jobId: rec.jobId,
    taskId: rec.taskId,
    profile: rec.profile,
    state,
    exitCode: !done ? null : passes ? 0 : 1,
    durationMs: done ? JOB_DURATION_MS : elapsed,
    failedTests: state === "failed" ? ["parser > handles empty input"] : [],
    tail: !done ? [] : tailFor(rec.profile, rec.willPass),
    artifactId: `art_${rec.jobId.replace("job_", "")}`,
  };
}

export function lastJobStateForTask(taskId: string): string | null {
  const list = jobsByTask.get(taskId);
  if (!list || list.length === 0) return null;
  const lastId = list[list.length - 1] as string;
  return getJobStatus(lastId)?.state ?? null;
}
