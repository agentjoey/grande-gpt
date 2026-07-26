import type { DatabaseSync } from "node:sqlite";

export type JobState = "running" | "passed" | "failed" | "timeout" | "killed" | "cancelled";

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

export function finishJob(
  db: DatabaseSync,
  jobId: string,
  r: {
    state: JobState;
    exitCode: number | null;
    artifactPath: string | null;
    summary: Record<string, unknown> | null;
  },
): JobRow {
  db.prepare(
    "UPDATE job SET state=?, exitCode=?, endedAt=?, artifactPath=?, summary=? WHERE jobId=?",
  ).run(
    r.state, r.exitCode, Date.now(), r.artifactPath,
    r.summary ? JSON.stringify(r.summary) : null, jobId,
  );
  const updated = getJob(db, jobId);
  if (!updated) throw new Error(`JOB_NOT_FOUND: ${jobId}`);
  return updated;
}

/**
 * 重启后对账：把「记录里还在 running、但进程组已经不在」的 job 收敛掉。
 *
 * 规格 AC-11 要求 Gateway 重启后不留下永远停在 running 的 job——那种记录会让
 * CLI 与将来的报告都误以为有任务在跑。没有 pgid 的 running job 无法探活，
 * 同样收敛（它多半是记录写了但进程没起来）。
 *
 * @param isAlive 由调用方注入的探活函数，便于测试；生产实现是 `process.kill(-pgid, 0)`
 * @returns 被收敛的条数
 */
export function reconcileRunningJobs(db: DatabaseSync, isAlive: (pgid: number) => boolean): number {
  let n = 0;
  for (const j of listJobs(db)) {
    if (TERMINAL.has(j.state)) continue;
    if (j.pgid !== null && isAlive(j.pgid)) continue;
    finishJob(db, j.jobId, {
      state: "killed", exitCode: null, artifactPath: j.artifactPath,
      summary: { reconciled: true, reason: j.pgid === null ? "无 pgid，无法探活" : "进程组已消失" },
    });
    n++;
  }
  return n;
}
