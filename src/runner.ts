import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { truncateText } from "./envelope.ts";
import type { Layout } from "./layout.ts";
import { createJob, finishJob, getJob, TERMINAL, type JobState } from "./jobs.ts";
import { assertTaskId, resolveRepoPath } from "./paths.ts";
import { getProfile } from "./profiles.ts";
import { registeredIds } from "./registry.ts";
import { defaultExecRoots, runSandboxed } from "./sandbox.ts";
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
 * 等**所有**在途 job 收尾，最多等 `timeoutMs`。返回真实等到的 job 数。
 *
 * 关停路径需要的是这个，而不是逐个 `awaitJobSettled`——关停时调用方手里没有
 * jobId 列表，`inFlight` 是唯一知道谁还在途的地方。此前 `main.ts` 的关停注释
 * 写着「让在途的后台 job 收尾写完 artifact 再退出」，实现却是 `db.close()` 之后
 * 直接 `process.exit(0)`；实测后果是一个真正跑完了 90 秒的 job 被记成
 * `killed` / `artifactPath=null`，时长记的是下次启动 reconcile 的时刻。
 *
 * **必须带超时**：`timeoutSeconds` 最大可到 600，关停不能被一个刚起步的长 job
 * 卡住十分钟。超时后照样退出——那种情况下退化回原来的行为（下次启动由
 * `reconcileRunningJobs` 收拾），不比现在更差。
 */
export async function awaitAllJobsSettled(timeoutMs: number): Promise<number> {
  const pending = [...inFlight.values()];
  if (pending.length === 0) return 0;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    // 这个定时器不该把 Node 的事件循环撑着不让退出。
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled(pending), deadline]);
  if (timer) clearTimeout(timer);
  return pending.length;
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
  audit: AuditHandle,
): StartedJob {
  const { db, layout } = deps;

  try {
    // 先校验——抛错时不能留下任何痕迹
    // C4：taskId 会被直接拼进 artifactDir（`join(layout.artifactsDir, a.taskId, jobId)`，
    // 见下方），必须先于任何副作用校验形状——worktree.ts 早先给 openWorktree 加过
    // 同一条校验，但这里（taskId 第二次被拼进文件系统路径的地方）从未补上，
    // 一个 `../../../../tmp/evil` 形状的 taskId 能把 job 的 stdout/stderr 写到
    // 控制平面之外的任意路径。
    assertTaskId(a.taskId);
    const profile = getProfile(layout, a.repoId, a.profileName);
    // repoId 必须过注册与路径逃逸门禁：startJob 的 worktreePath 会变成
    // `allow file-write*` 的 subpath，裸 join(workspaceRoot, repoId) 等于没有门禁（C-6）。
    const canonicalGit = join(resolveRepoPath(layout, a.repoId, registeredIds(layout)), ".git");
    const worktree = realpathSync(a.worktreePath);
    const worktreesRoot = realpathSync(layout.worktreesRoot);
    // C1：必须是【严格】包含——worktree === worktreesRoot 这个值本身也要被拒绝。
    // 此前 `worktree !== worktreesRoot &&` 这个短路条件恰好放行了最危险的那个
    // 输入：调用方传 worktreesRoot 自己作为 worktreePath，会让整个 worktrees 根
    // （所有任务的 worktree 的共同父目录）变成沙箱的 `allow file-write*` 子路径，
    // 一次调用即可读写任意其他任务的 worktree，AC-3 的跨任务隔离形同虚设。
    // `startsWith(worktreesRoot + sep)` 单独就已经正确表达「严格子路径」：
    // worktree === worktreesRoot 时它没有多出的分隔符可以匹配，天然为 false。
    if (!worktree.startsWith(worktreesRoot + sep)) {
      throw new RunnerError(
        "POLICY_DENIED",
        `worktreePath 必须在 ${worktreesRoot} 之下，收到：${worktree}。` +
          `这条路径会直接成为沙箱的可写根。`,
      );
    }

    // 推进审计句柄到 EXECUTING —— 必须在 spawn 之前成功
    if (!audit.executing()) {
      throw new RunnerError("POLICY_DENIED", "审计句柄推进失败——Policy 未放行或已被他人使用。");
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

    // C3：rejection handler 必须在 createJob 之前接上 run。createJob 可能同步抛出
    // （例如未知 taskId 撞上 job.taskId 的外键约束——ERR_SQLITE_ERROR），若此刻
    // run 还没有 `.catch`、之后又在某个微任务里 reject，Node 24 默认
    // `--unhandled-rejections=throw` 会直接杀掉整个 Gateway 进程。这正是
    // inFlight/safeFinish 那一轮已经在 `.then` 链*内部*修好的失败模式，在链被
    // 真正接上之前的这段窗口原样重现——不是同一处回归，是同一类问题在更早的
    // 时间点又出现了一次。
    const settled = run
      .then((r) => {
        safeWrite(artifactPath, `${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
        // I2：命中输出上限不再是一种 killedBy 原因（sandbox.ts 的 collect() 现在
        // 只截断、不杀进程），所以这里不再有 "output" 分支——一个真实 exit 0 的
        // 通过用例即使输出越过了 cap，也会正常落到下面的 "passed"，`truncated`
        // 字段（见下面 summary）仍然如实反映「日志被截断了」。
        const state: Exclude<JobState, "running"> =
          r.killedBy === "timeout" ? "timeout"
          : r.killedBy === "rss" ? "killed"
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
      .finally(() => { inFlight.delete(jobId); });

    try {
      createJob(db, { jobId, taskId: a.taskId, profile: profile.name, argv: [...profile.argv], pgid });
    } catch (e) {
      // createJob 没能落库：没有任何 job 行记录这个进程组的 pgid，
      // `reconcileRunningJobs` 的探活兜底靠的正是那一列——一行都没有，它永远不会
      // 被扫到，沙箱进程就变成一个真正意义上的孤儿（还在跑，没有任何记录指向它）。
      // 此刻唯一还知道 pgid 的就是这个闭包，必须在这里主动杀掉整个进程组再把
      // 错误抛出去，不能指望调用方或后台收尾路径替它兜底。上面的 `settled` 链
      // 仍然会在 run 结束后跑一次，但只是徒劳地尝试 safeFinish 一个不存在的 job
      // 行——finishJob 对不存在的 jobId 抛 JOB_NOT_FOUND，会被 safeFinish 的
      // try/catch 吞掉、记一条 console.error，不会二次抛出（见 safeFinish）。
      if (pgid) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
      throw e;
    }

    // 成功 spawn 且 createJob() 落库后立即 succeeded()——它标记的是
    // 「这次 EXECUTING 动作本身有没有成功」，不是「命令最终 exit 0 还是非 0」
    audit.succeeded();

    // artifactDir 特意挪到 createJob 成功之后再建（MINOR 修复）：jobTmp 没法这样
    // 处理（上面解释过的顺序依赖），但 artifactDir 在 job 行落库之前完全用不上——
    // 挪到这里之后，createJob 失败时只留一个空目录（jobTmp），不是两个。`settled`
    // 挂的回调保证只会在这次同步调用返回之后才运行（Promise 语义），不存在
    // 「回调抢在 mkdirSync 前面执行」的竞态。
    mkdirSync(artifactDir, { recursive: true });
    inFlight.set(jobId, settled);

    return { jobId, state: "running", pollAfterSeconds: pollHint(profile.timeoutSeconds) };
  } catch (e) {
    audit.failed(String(e instanceof Error ? e.message : e));
    throw e;
  }
}

export interface JobReport {
  truncated: boolean;
  state: JobState;
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
    // curl exit code 6 (DNS) or 7 (connection), with or without sub-code like 65
    /(?:^|\n)curl:\s*\(\s*[67]\d{0,1}\s*\)/m.test(artifactContent) ||
    // Node.js EPERM + connect
    /EPERM.*connect/i.test(artifactContent) ||
    // Generic: Operation not permitted + network syscall
    /Operation not permitted.*(?:connect|socket|sendto|recvfrom|gethostbyname)/i.test(artifactContent)
  );
}

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

  const s = j.summary;

  // 遗留 #1（同源）：判据是「还没进终态」，不是「等于 running」。
  // 下面那些字段（exitCode / durationMs / artifactPath）全是 null 的理由是
  // job 还没结束——**加一个非终态时，落进下面的终态分支读出的会是脏值**，
  // 而不是这里诚实的 null。`state` 回填 j.state，不写死 "running"。
  if (!TERMINAL.has(j.state)) {
    return {
      truncated: false, state: j.state, exitCode: null, outputTruncated: false,
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
