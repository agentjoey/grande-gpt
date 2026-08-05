import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import type { JobState as ContractJobState } from "./contract.ts";

/**
 * 单一真相源在 `contract.ts`。**控制台的图表按同一份枚举分类**——
 * 上一版两边各写一遍，结果控制台只认三个值，墙钟超时的 job 在图上没有名字。
 */
export type JobState = ContractJobState;

export interface JobRow {
  jobId: string;
  taskId: string;
  profile: string;
  argv: string[];
  state: JobState;
  pgid: number | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  artifactPath: string | null;
  summary: Record<string, unknown> | null;
}

const TERMINAL: ReadonlySet<JobState> = new Set(["passed", "failed", "timeout", "killed", "cancelled"]);

function toRow(r: Record<string, unknown>): JobRow {
  return {
    jobId: r.jobId as string,
    taskId: r.taskId as string,
    profile: r.profile as string,
    argv: JSON.parse((r.argv as string) || "[]") as string[],
    state: r.state as JobState,
    pgid: (r.pgid as number | null) ?? null,
    exitCode: (r.exitCode as number | null) ?? null,
    startedAt: r.startedAt as number,
    endedAt: (r.endedAt as number | null) ?? null,
    artifactPath: (r.artifactPath as string | null) ?? null,
    summary: r.summary ? (JSON.parse(r.summary as string) as Record<string, unknown>) : null,
  };
}

export function createJob(
  db: DatabaseSync,
  j: { jobId: string; taskId: string; profile: string; argv: string[]; pgid: number | null },
): JobRow {
  const now = Date.now();
  db.prepare(
    "INSERT INTO job (jobId,taskId,profile,argv,state,pgid,startedAt) VALUES (?,?,?,?,'running',?,?)",
  ).run(j.jobId, j.taskId, j.profile, JSON.stringify(j.argv), j.pgid, now);
  return {
    ...j, state: "running", exitCode: null, startedAt: now,
    endedAt: null, artifactPath: null, summary: null,
  };
}

export function getJob(db: DatabaseSync, jobId: string): JobRow | undefined {
  const r = db.prepare("SELECT * FROM job WHERE jobId = ?").get(jobId);
  return r ? toRow(r as Record<string, unknown>) : undefined;
}

/**
 * 按 `startedAt` 倒序；`startedAt` 用 `Date.now()`（毫秒精度），同一毫秒内创建的
 * 多个 job 会打平——用 `rowid`（SQLite 隐式的插入序，job 表未声明 WITHOUT ROWID）
 * 做第二排序键，倒序即“后插入的排前面”，与“开始时间倒序”的语义一致。
 * 原始实现缺这个 tiebreak：在真实测试里两次连续 `createJob()` 几乎总落在
 * 同一毫秒，导致 `listJobs` 顺序不确定（实测退化为插入序，与测试要求的反序相反）。
 */
export function listJobs(db: DatabaseSync, taskId?: string): JobRow[] {
  const rows = taskId
    ? db.prepare("SELECT * FROM job WHERE taskId = ? ORDER BY startedAt DESC, rowid DESC").all(taskId)
    : db.prepare("SELECT * FROM job ORDER BY startedAt DESC, rowid DESC").all();
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

/**
 * 把 job 写成终态。CAS（compare-and-swap）语义：`UPDATE` 带 `AND state='running'`
 * ——只有这一行「此刻仍是 running」才会真的写入。
 *
 * 为什么需要 CAS：`reconcileRunningJobs` 的 read（`listJobs` 快照）与 write
 * （这里的 `finishJob`）之间没有任何东西保证原子性——job 可能在这两步之间，
 * 由它自己的正常退出路径抢先写完了真实结果。没有 CAS，后写入的一方（无论是
 * reconcile 还是另一次 finishJob）会用自己的结果盲目覆盖已经写好的终态，
 * 真实结果永久丢失且没有任何报错。
 *
 * `state='running'` 而不是 `state NOT IN (<终态集合>)`：`JobState` 里唯一的
 * 非终态就是 `running`，两种写法在当前类型下完全等价；选前者是因为它直接
 * 表达了本函数的意图（“把一个正在跑的 job 收尾”），不用把 `TERMINAL` 集合
 * 拼进 SQL 参数列表。
 *
 * @param r.state 收尾状态，类型上排除 `"running"`——`finishJob` 是收尾调用，
 *   写出一行「同时是 running、又带非空 endedAt」的矛盾状态没有意义，让它在
 *   类型层就不可表达，好过留给运行时检查。
 * @returns 这次调用真的把行从 running 改成终态时，返回更新后的行；行存在但
 *   此刻已经不是 running（CAS 输给了别的写者——可能是真实完成路径，也可能是
 *   并发的另一次收尾调用）时，返回 `undefined`，调用方据此区分“这次是我记录
 *   的结果”和“别人先到了”。`jobId` 根本不存在时仍然抛 `JOB_NOT_FOUND`：那不
 *   是竞态，是调用方传错了 id。
 */
export function finishJob(
  db: DatabaseSync,
  jobId: string,
  r: {
    state: Exclude<JobState, "running">;
    exitCode: number | null;
    artifactPath: string | null;
    summary: Record<string, unknown> | null;
  },
): JobRow | undefined {
  const res = db.prepare(
    "UPDATE job SET state=?, exitCode=?, endedAt=?, artifactPath=?, summary=? WHERE jobId=? AND state='running'",
  ).run(
    r.state, r.exitCode, Date.now(), r.artifactPath,
    r.summary ? JSON.stringify(r.summary) : null, jobId,
  );
  if (res.changes === 0) {
    if (!getJob(db, jobId)) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
    return undefined;
  }
  const updated = getJob(db, jobId);
  if (!updated) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
  return updated;
}

/**
 * 重启后对账：把「记录里还在 running、但进程组已经不在」的 job 收敛掉。
 *
 * 规格 AC-11 要求 Gateway 重启后不留下永远停在 running 的 job——那种记录会让
 * CLI 与将来的报告都误以为有任务在跑。没有 pgid 的 running job 无法探活，
 * 同样收敛（它多半是记录写了但进程没起来）。
 *
 * 并发契约：本函数的读（`listJobs` 快照）与写（`finishJob`）之间不是原子的
 * ——job 可能在这两步之间由它自己的正常退出路径抢先写完真实结果。这是安全
 * 的：`finishJob` 内部的 CAS（`WHERE state='running'`）保证这种情况下本函数
 * 发起的收尾调用是 no-op（返回 `undefined`，不计入 `n`），不会覆盖那个真实
 * 结果。因此本函数可以被安全地调用不止一次——不只是重启时那一次；将来加一
 * 个周期性自愈扫描，或者与另一次 reconcile 并发跑，都不会破坏已经落地的真实
 * job 结果。
 *
 * @param isAlive 由调用方注入的探活函数，便于测试；生产实现是 `process.kill(-pgid, 0)`
 * @returns 这次调用真正收敛（`finishJob` 的 CAS 写入成功）的条数——不是「尝试
 *   收敛的条数」；输给并发写者的行不计入。
 */
export function reconcileRunningJobs(db: DatabaseSync, isAlive: (pgid: number) => boolean): number {
  let n = 0;
  for (const j of listJobs(db)) {
    if (TERMINAL.has(j.state)) continue;
    if (j.pgid !== null && isAlive(j.pgid)) continue;
    const result = finishJob(db, j.jobId, {
      state: "killed", exitCode: null, artifactPath: j.artifactPath,
      summary: { reconciled: true, reason: j.pgid === null ? "无 pgid，无法探活" : "进程组已消失" },
    });
    if (result) n++;
  }
  return n;
}
