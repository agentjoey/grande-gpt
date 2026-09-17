import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { truncateText } from "./envelope.ts";
import type { Layout } from "./layout.ts";
import { finishJob, getJob, setRunningJobPgid, TERMINAL, type JobState } from "./jobs.ts";
import { markManagedJobLaunching, reserveManagedJob } from "./resourceAdmission.ts";
import { assertTaskId, resolveRepoPath } from "./paths.ts";
import { getProfile } from "./profiles.ts";
import { registeredIds } from "./registry.ts";
import { defaultExecRoots, runSandboxed, type RunOptions, type RunResult } from "./sandbox.ts";
import type { AuditHandle } from "./audit.ts";
import type { ToolError } from "./errors.ts";

export class RunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `RunnerError [${code}]`;
    this.code = code;
  }
}

export interface RunnerDeps {
  db: DatabaseSync;
  layout: Layout;
  /** Internal deterministic seam for job lifecycle tests; production uses runSandboxed. */
  jobSandboxRunner?: (options: RunOptions) => Promise<RunResult>;
}

export interface StartedJob {
  jobId: string;
  state: "running";
  pollAfterSeconds: number;
}

export interface JobPreflight {
  profile: ReturnType<typeof getProfile>;
  canonicalGit: string;
  worktree: string;
  worktreesRoot: string;
}

/** Side-effect-free validation shared by grande_run prerequisites and the real job launcher. */
export function preflightJob(
  deps: RunnerDeps,
  a: { taskId: string; repoId: string; worktreePath: string; profileName: string },
): JobPreflight {
  assertTaskId(a.taskId);
  const profile = getProfile(deps.layout, a.repoId, a.profileName);
  const canonicalGit = join(resolveRepoPath(deps.layout, a.repoId, registeredIds(deps.layout)), ".git");
  const worktree = realpathSync(a.worktreePath);
  const worktreesRoot = realpathSync(deps.layout.worktreesRoot);
  if (!worktree.startsWith(worktreesRoot + sep)) {
    throw new RunnerError(
      "POLICY_DENIED",
      `worktreePath 必须在 ${worktreesRoot} 之下，收到：${worktree}。` +
        `这条路径会直接成为沙箱的可写根。`,
    );
  }
  return { profile, canonicalGit, worktree, worktreesRoot };
}

/** 建议轮询间隔：取超时的 1/10，夹在 3–20 秒之间。给模型一个具体数字比让它自己猜好 */
function pollHint(timeoutSeconds: number): number {
  return Math.min(20, Math.max(3, Math.round(timeoutSeconds / 10)));
}

/**
 * 后台收尾 promise，按 jobId 索引（C-7）。生产路径不 await 它——`grande_run` 必须
 * < 1s 返回，等它跑完就不是异步 job 了。测试与优雅关停用 `awaitJobSettled` 等它落地。
 */
const inFlight = new Map<string, Promise<void>>();

/** Register non-runner asynchronous jobs with the same shutdown wait/rejection boundary. */
export function trackJobSettlement(jobId: string, settlement: Promise<void>): void {
  const tracked = settlement
    .catch((error: unknown) => {
      console.error(`[runner] ${jobId} 后台收尾发生未处理错误：${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      if (inFlight.get(jobId) === tracked) inFlight.delete(jobId);
    });
  inFlight.set(jobId, tracked);
}

/** 等某个 job 的后台收尾跑完。未知或已收尾的 jobId 立即返回。 */
export function awaitJobSettled(jobId: string): Promise<void> {
  return inFlight.get(jobId) ?? Promise.resolve();
}

/**
 * 等所有在途 job 收尾，最多等 timeoutMs。超时不伪造终态；重启后继续从 durable job 对账。
 */
export async function awaitAllJobsSettled(timeoutMs: number): Promise<number> {
  const pending = [...inFlight.values()];
  if (pending.length === 0) return 0;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled(pending), deadline]);
  if (timer) clearTimeout(timer);
  return pending.length;
}

/** Artifact failure cannot turn the settlement callback into an unhandled rejection. */
function safeWrite(path: string, body: string): void {
  try {
    writeFileSync(path, body, "utf8");
  } catch (e) {
    console.error(`[runner] 写 artifact 失败 ${path}：${(e as Error).message}`);
  }
}

/** @returns 这次收尾真的落库了吗。false = CAS 输了或库已关闭。 */
function safeFinish(
  db: DatabaseSync,
  jobId: string,
  r: {
    state: Exclude<JobState, "running">;
    exitCode: number | null;
    artifactPath: string | null;
    summary: Record<string, unknown> | null;
  },
): boolean {
  try {
    return finishJob(db, jobId, r) !== undefined;
  } catch (e) {
    console.error(`[runner] ${jobId} 收尾失败：${(e as Error).message}`);
    return false;
  }
}

/** Validate, atomically reserve a job, then allocate/spawn. The supervisor owns settlement. */
export function startJob(
  deps: RunnerDeps,
  a: { taskId: string; repoId: string; worktreePath: string; profileName: string },
  audit: AuditHandle,
): StartedJob {
  const { db, layout } = deps;
  let reserved: string | undefined;
  let supervised = false;
  try {
    const { profile, canonicalGit, worktree, worktreesRoot } = preflightJob(deps, a);
    if (!audit.executing()) {
      throw new RunnerError("POLICY_DENIED", "审计句柄推进失败——Policy 未放行或已被他人使用。");
    }
    const jobId = `job_${randomUUID()}`;
    reserveManagedJob(db, layout, {
      jobId, taskId: a.taskId, profile: profile.name, argv: [...profile.argv], kind: "sandbox",
    }, [worktree]);
    reserved = jobId;

    const jobTmp = join(layout.derivedRoot, "tmp", jobId);
    const artifactDir = join(layout.artifactsDir, a.taskId, jobId);
    const artifactPath = join(artifactDir, "output.log");
    // No process exists if directory preparation fails; the reserved row can safely settle.
    mkdirSync(join(jobTmp, "home"), { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    const execRoots = defaultExecRoots();
    markManagedJobLaunching(db, jobId);
    const run = (deps.jobSandboxRunner ?? runSandboxed)({
      argv: [...profile.argv],
      cwd: worktree,
      onSpawn: (pgid) => {
        try {
          if (!setRunningJobPgid(db, jobId, pgid)) throw new Error("job reservation is no longer running");
        } catch (error) {
          // Only the pgid just received from this spawn is eligible for this emergency cleanup.
          if (Number.isInteger(pgid) && pgid > 0) {
            try { process.kill(-pgid, "SIGKILL"); } catch { /* already exited */ }
          }
          throw error;
        }
      },
      paths: {
        worktree, canonicalGit, jobTmp: realpathSync(jobTmp),
        controlRoot: layout.controlRoot, worktreesRoot, execRoots,
      },
      toolchain: profile.toolchain,
      nativeExecTargets: profile.nativeExecTargets,
      timeoutMs: profile.timeoutSeconds * 1000,
      maxOutputBytes: profile.maxOutputBytes,
      maxRssMb: profile.maxRssMb,
    });
    const settled = run.then((r) => {
      safeWrite(artifactPath, `${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
      const state: Exclude<JobState, "running"> =
        r.killedBy === "timeout" ? "timeout"
        : r.killedBy === "rss" ? "killed"
        : r.exitCode === 0 ? "passed" : "failed";
      if (!safeFinish(db, jobId, {
        state, exitCode: r.exitCode, artifactPath,
        summary: { truncated: r.truncated, killedBy: r.killedBy ?? null, durationMs: r.durationMs, peakRssMb: r.peakRssMb },
      })) {
        console.error(`[runner] ${jobId} 的真实结果（${state}, exit=${r.exitCode}）晚于收敛写入、已被丢弃；完整日志仍在 ${artifactPath}`);
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      safeWrite(artifactPath, `runner 内部错误：${message}\n`);
      safeFinish(db, jobId, { state: "killed", exitCode: null, artifactPath, summary: { error: message } });
    }).finally(() => { inFlight.delete(jobId); });
    inFlight.set(jobId, settled);
    supervised = true;
    audit.succeeded();
    return { jobId, state: "running", pollAfterSeconds: pollHint(profile.timeoutSeconds) };
  } catch (error) {
    if (reserved && !supervised) {
      safeFinish(db, reserved, { state: "failed", exitCode: null, artifactPath: null,
        summary: { reason: "launch_failed", error: error instanceof Error ? error.message : String(error) } });
    }
    audit.failed(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export interface JobReport {
  truncated: boolean;
  state: JobState;
  profile: string;
  kind: string | null;
  failureClass: string | null;
  reason: string | null;
  requestedProfile: string | null;
  dependencyIdentityKey: string | null;
  packageManager: string | null;
  exitCode: number | null;
  outputTruncated: boolean;
  killedBy: "timeout" | "rss" | null;
  durationMs: number | null;
  peakRssMb: number | null;
  artifactPath: string | null;
  summary: string;
  networkDenied: boolean;
}

/** jobReport 的终态 → 工具错误码。这一层不经过 toToolError：它不是异常，是 job 结果。 */
export function jobStateToError(r: JobReport): ToolError | null {
  if (r.state === "timeout") {
    return { code: "JOB_TIMEOUT", message: "作业超过 profile 的 timeoutSeconds。", retryable: false, details: { killedBy: r.killedBy } };
  }
  if (r.state === "killed" && r.killedBy === "rss") {
    return { code: "RESOURCE_EXHAUSTED", message: "作业 RSS 超限被终止。", retryable: false, details: { peakRssMb: r.peakRssMb } };
  }
  return null;
}

/** 摘要给模型看的尾部行数（规格 §5.4②：失败用例名 + 关键堆栈 + 尾部 40 行） */
const TAIL_LINES = 40;
const SUMMARY_MAX_BYTES = 8 * 1024;

/**
 * 启发式检测网络被 Seatbelt `(deny network*)` 规则拦截。
 * 非权威信号——Seatbelt 不提供"因为网络被拒"的明确标记，只能从
 * 进程输出中匹配常见特征。不要依赖它为唯一判定依据。
 */
function detectNetworkDenied(artifactContent: string): boolean {
  return (
    /(?:^|\n)curl:\s*\(\s*[67]\d{0,1}\s*\)/m.test(artifactContent) ||
    /EPERM.*connect/i.test(artifactContent) ||
    /Operation not permitted.*(?:connect|socket|sendto|recvfrom|gethostbyname)/i.test(artifactContent)
  );
}

/** Bounded model-facing report; full output remains in the controlled artifact. */
export function jobReport(db: DatabaseSync, jobId: string): JobReport {
  const j = getJob(db, jobId);
  if (!j) throw new RunnerError("JOB_NOT_FOUND", `job 不存在：${jobId}`);
  const s = j.summary;
  if (!TERMINAL.has(j.state)) {
    return {
      truncated: false, state: j.state, profile: j.profile,
      kind: (s?.kind as string | undefined) ?? null,
      failureClass: (s?.failureClass as string | undefined) ?? null,
      reason: (s?.reason as string | undefined) ?? null,
      requestedProfile: (s?.requestedProfile as string | undefined) ?? null,
      dependencyIdentityKey: (s?.dependencyIdentityKey as string | undefined) ?? null,
      packageManager: (s?.packageManager as string | undefined) ?? null,
      exitCode: null, outputTruncated: false,
      killedBy: null, durationMs: null, peakRssMb: null, artifactPath: null,
      summary: "仍在运行中。", networkDenied: false,
    };
  }
  let tail = "";
  let networkDenied = false;
  if (j.artifactPath !== null) {
    try {
      const all = readFileSync(j.artifactPath, "utf8");
      networkDenied = detectNetworkDenied(all);
      tail = all.split("\n").slice(-TAIL_LINES).join("\n");
    } catch {
      tail = "（artifact 不可读）";
    }
  }
  const capped = truncateText(tail, SUMMARY_MAX_BYTES);
  return {
    truncated: capped.truncated,
    state: j.state,
    profile: j.profile,
    kind: (s?.kind as string | undefined) ?? null,
    failureClass: (s?.failureClass as string | undefined) ?? null,
    reason: (s?.reason as string | undefined) ?? null,
    requestedProfile: (s?.requestedProfile as string | undefined) ?? null,
    dependencyIdentityKey: (s?.dependencyIdentityKey as string | undefined) ?? null,
    packageManager: (s?.packageManager as string | undefined) ?? null,
    exitCode: j.exitCode,
    outputTruncated: (s?.truncated as boolean | undefined) ?? false,
    killedBy: (s?.killedBy as JobReport["killedBy"] | undefined) ?? null,
    durationMs: (s?.durationMs as number | undefined) ?? null,
    peakRssMb: (s?.peakRssMb as number | undefined) ?? null,
    artifactPath: j.artifactPath,
    summary: capped.text,
    networkDenied,
  };
}
