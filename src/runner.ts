import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { truncateText } from "./envelope.ts";
import type { Layout } from "./layout.ts";
import { createJob, finishJob, getJob, type JobState } from "./jobs.ts";
import { resolveRepoPath } from "./paths.ts";
import { getProfile } from "./profiles.ts";
import { registeredIds } from "./registry.ts";
import { defaultExecRoots, runSandboxed } from "./sandbox.ts";

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
}

export interface StartedJob {
  jobId: string;
  state: "running";
  pollAfterSeconds: number;
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

/** 等某个 job 的后台收尾跑完。未知或已收尾的 jobId 立即返回。 */
export function awaitJobSettled(jobId: string): Promise<void> {
  return inFlight.get(jobId) ?? Promise.resolve();
}

/**
 * 收尾路径**自己绝不能抛**（C-7）：它跑在没有调用方的 promise 尾巴上，抛出去就是
 * unhandled rejection——测试环境里这会让整个 vitest 套件非零退出（实测：进程
 * exit 99），生产环境里则是一条永远不会被任何人看到的崩溃。
 */
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

/**
 * 启动一个 job，**立刻返回**。
 *
 * ChatGPT 的工具调用 ~60s 超时不可配置（规格 §5.4①），同步等待跑测试必然撞墙。
 * 因此本函数只负责：校验 → 启动子进程 → 落 job 行 → 返回。实际执行在后台继续，
 * 结束时回调 `finishJob`。
 *
 * **校验必须在任何有副作用的操作之前完成**，否则一个 profile 名打错、或一个
 * 指向工作区外的 `worktreePath`，会在留下痕迹之后才被拒绝。
 */
export function startJob(
  deps: RunnerDeps,
  a: { taskId: string; repoId: string; worktreePath: string; profileName: string },
): StartedJob {
  const { db, layout } = deps;

  // 先校验——抛错时不能留下任何痕迹
  const profile = getProfile(layout, a.repoId, a.profileName);
  // repoId 必须过注册与路径逃逸门禁：startJob 的 worktreePath 会变成
  // `allow file-write*` 的 subpath，裸 join(workspaceRoot, repoId) 等于没有门禁（C-6）。
  const canonicalGit = join(resolveRepoPath(layout, a.repoId, registeredIds(layout)), ".git");
  const worktree = realpathSync(a.worktreePath);
  const worktreesRoot = realpathSync(layout.worktreesRoot);
  if (worktree !== worktreesRoot && !worktree.startsWith(worktreesRoot + sep)) {
    throw new RunnerError(
      "POLICY_DENIED",
      `worktreePath 必须在 ${worktreesRoot} 之下，收到：${worktree}。` +
        `这条路径会直接成为沙箱的可写根。`,
    );
  }

  const jobId = `job_${randomUUID()}`;
  const jobTmp = join(layout.derivedRoot, "tmp", jobId);
  // jobTmp 必须先于下面的 realpathSync(jobTmp) 存在——这一步没法推迟到 createJob
  // 成功之后：它是构造 runSandboxed 调用参数的一部分（同步求值，在函数体真正
  // 执行之前）。
  mkdirSync(join(jobTmp, "home"), { recursive: true });

  // runSandboxed 的前半段（realpath、写 profile、spawn）是同步的，onSpawn 在返回
  // promise 之前就已经触发，所以 createJob 拿得到真实 pgid（C-5）。实测整段 6 ms。
  let pgid: number | null = null;
  const run = runSandboxed({
    argv: [...profile.argv],
    cwd: worktree,
    onSpawn: (p) => { pgid = p; },
    paths: {
      worktree, canonicalGit, jobTmp: realpathSync(jobTmp),
      controlRoot: layout.controlRoot, worktreesRoot, execRoots: defaultExecRoots(),
    },
    timeoutMs: profile.timeoutSeconds * 1000,
    maxOutputBytes: profile.maxOutputBytes,
    maxRssMb: profile.maxRssMb,
  });

  const artifactDir = join(layout.artifactsDir, a.taskId, jobId);
  const artifactPath = join(artifactDir, "output.log");

  createJob(db, { jobId, taskId: a.taskId, profile: profile.name, argv: [...profile.argv], pgid });

  // artifactDir 特意挪到 createJob 成功之后再建（MINOR 修复）：jobTmp 没法这样
  // 处理（上面解释过的顺序依赖），但 artifactDir 在 job 行落库之前完全用不上——
  // 挪到这里之后，createJob 失败时只留一个空目录（jobTmp），不是两个。下面的
  // `.then`/`.catch` 回调保证只会在这次同步调用返回之后才运行（Promise 语义），
  // 不存在「回调抢在 mkdirSync 前面执行」的竞态。
  mkdirSync(artifactDir, { recursive: true });

  inFlight.set(
    jobId,
    run
      .then((r) => {
        safeWrite(artifactPath, `${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
        const state: Exclude<JobState, "running"> =
          r.killedBy === "timeout" ? "timeout"
          : r.killedBy === "rss" || r.killedBy === "output" ? "killed"
          : r.exitCode === 0 ? "passed" : "failed";
        const won = safeFinish(db, jobId, {
          state, exitCode: r.exitCode, artifactPath,
          summary: { truncated: r.truncated, killedBy: r.killedBy ?? null, durationMs: r.durationMs, peakRssMb: r.peakRssMb },
        });
        if (!won) {
          // finishJob 的 CAS 输了：别人（多半是 reconcileRunningJobs）已经把这行判成终态。
          // **不覆盖**，但必须留痕——否则真实结果连同 artifactPath 一起悄无声息地消失。
          console.error(
            `[runner] ${jobId} 的真实结果（${state}, exit=${r.exitCode}）晚于收敛写入、已被丢弃；` +
              `完整日志仍在 ${artifactPath}`,
          );
        }
      })
      .catch((e: unknown) => {
        safeWrite(artifactPath, `runner 内部错误：${(e as Error).message}\n`);
        safeFinish(db, jobId, { state: "killed", exitCode: null, artifactPath, summary: { error: (e as Error).message } });
      })
      .finally(() => { inFlight.delete(jobId); }),
  );

  return { jobId, state: "running", pollAfterSeconds: pollHint(profile.timeoutSeconds) };
}

export interface JobReport {
  truncated: boolean;
  state: JobState;
  exitCode: number | null;
  outputTruncated: boolean;
  killedBy: "timeout" | "rss" | "output" | null;
  durationMs: number | null;
  artifactPath: string | null;
  summary: string;
}

/** 摘要给模型看的尾部行数（规格 §5.4②：失败用例名 + 关键堆栈 + 尾部 40 行） */
const TAIL_LINES = 40;
const SUMMARY_MAX_BYTES = 8 * 1024;

/**
 * 生成给模型看的 job 报告。完整日志留在 artifact，这里只给尾部摘要 ——
 * 整份测试日志轻易就能撑爆 ChatGPT 的响应上限。
 *
 * **不接 `layout` 参数**（MINOR 修复）：旧签名里有，函数体从未用过——`artifactPath`
 * 已经是 `getJob` 返回行里的绝对路径，不需要 `layout` 拼接。
 */
export function jobReport(db: DatabaseSync, jobId: string): JobReport {
  const j = getJob(db, jobId);
  if (!j) throw new RunnerError("JOB_NOT_FOUND", `job 不存在：${jobId}`);

  if (j.state === "running") {
    return {
      truncated: false, state: "running", exitCode: null, outputTruncated: false,
      killedBy: null, durationMs: null, artifactPath: null, summary: "仍在运行中。",
    };
  }

  let tail = "";
  if (j.artifactPath !== null) {
    try {
      const all = readFileSync(j.artifactPath, "utf8").split("\n");
      tail = all.slice(-TAIL_LINES).join("\n");
    } catch {
      tail = "（artifact 不可读）";
    }
  }
  const capped = truncateText(tail, SUMMARY_MAX_BYTES);
  const s = j.summary;
  return {
    truncated: capped.truncated,
    state: j.state,
    exitCode: j.exitCode,
    outputTruncated: (s?.truncated as boolean | undefined) ?? false,
    killedBy: (s?.killedBy as JobReport["killedBy"] | undefined) ?? null,
    durationMs: (s?.durationMs as number | undefined) ?? null,
    artifactPath: j.artifactPath,
    summary: capped.text,
  };
}
