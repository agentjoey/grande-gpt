import type { DatabaseSync } from "node:sqlite";
import { beginAudit } from "./audit.ts";
import { StateError } from "./errors.ts";
import { getJob, TERMINAL, type JobRow, type JobState } from "./jobs.ts";
import { getTask } from "./tasks.ts";

interface Owner {
  instance: string;
  pid: number;
  kind: "sandbox" | "dependency-bootstrap" | "host-verifier";
  cancelRequestedAt?: number;
}
interface LiveControl {
  taskId: string;
  owner: Owner;
  controller: AbortController;
}
const controls = new WeakMap<DatabaseSync, Map<string, LiveControl>>();

function ownerOf(job: JobRow): Owner | null {
  const value = job.summary?.resourceOwner;
  if (!value || typeof value !== "object") return null;
  const owner = value as Record<string, unknown>;
  if (typeof owner.instance !== "string" || owner.pid !== process.pid
      || (owner.kind !== "sandbox" && owner.kind !== "dependency-bootstrap" && owner.kind !== "host-verifier")) return null;
  return owner as unknown as Owner;
}

export interface JobCancellationControl {
  readonly signal: AbortSignal;
  dispose(): void;
  quarantine(): void;
}

/** Only an in-memory supervisor of this exact reserved job obtains a signal. No PID-based fallback. */
export function registerJobCancellation(db: DatabaseSync, jobId: string): JobCancellationControl {
  const job = getJob(db, jobId);
  const owner = job ? ownerOf(job) : null;
  if (!job || TERMINAL.has(job.state) || !owner) throw new StateError("POLICY_DENIED", "job 没有当前进程的可信取消所有权。");
  let map = controls.get(db);
  if (!map) { map = new Map(); controls.set(db, map); }
  if (map.has(jobId)) throw new StateError("STALE_STATE", "job 已注册 supervisor；不能重复接管。");
  const current: LiveControl = { taskId: job.taskId, owner, controller: new AbortController() };
  map.set(jobId, current);
  const dispose = () => { if (map!.get(jobId) === current) map!.delete(jobId); };
  return {
    signal: current.controller.signal,
    dispose,
    quarantine() {
      try {
        db.prepare(`UPDATE job SET summary=json_set(summary,
          '$.resourceOwner.phase','uncertain','$.reason','process_supervision_uncertain')
          WHERE jobId=? AND state='running' AND json_extract(summary,'$.resourceOwner.instance')=?`)
          .run(jobId, owner.instance);
      } finally { dispose(); }
    },
  };
}

export interface JobCancellationResult {
  taskId: string;
  jobId: string;
  state: JobState;
  requested: boolean;
  alreadyRequested: boolean;
}

/** Atomically record a cancellation request before notifying its actual owning supervisor. */
export function requestJobCancellation(
  db: DatabaseSync,
  taskId: string,
  jobId: string,
  options: { auditTool?: "grande_job_cancel" | "console_kill_job" } = {},
): JobCancellationResult {
  if (!getTask(db, taskId)) throw new StateError("TASK_NOT_FOUND", "取消请求的 task 不存在。");
  let live: LiveControl | undefined;
  let result: JobCancellationResult;
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = getJob(db, jobId);
    if (!job) throw new StateError("JOB_NOT_FOUND", "取消请求的 job 不存在。");
    if (job.taskId !== taskId) throw new StateError("POLICY_DENIED", "取消请求的 task/job 绑定不一致。");
    if (TERMINAL.has(job.state)) {
      db.exec("COMMIT");
      return { taskId, jobId, state: job.state, requested: false, alreadyRequested: false };
    }
    live = controls.get(db)?.get(jobId);
    const owner = ownerOf(job);
    if (!live || !owner || live.taskId !== taskId || live.owner.instance !== owner.instance || live.owner.kind !== owner.kind) {
      throw new StateError("POLICY_DENIED", "当前 Gateway 不拥有该 job 的可取消 supervisor；不允许按旧 PID 猜测终止，也不支持普通入口取消 production deployment。");
    }
    const alreadyRequested = typeof owner.cancelRequestedAt === "number";
    if (!alreadyRequested) {
      const audit = beginAudit(db, { taskId, tool: "grande_job_cancel",
        input: { jobId, phase: "cancellation_request", kind: owner.kind } });
      if (!audit.allowed() || !audit.executing()) throw new StateError("STALE_STATE", "取消审计无法进入执行状态。");
      const changed = db.prepare(`UPDATE job SET summary=json_set(summary,'$.resourceOwner.cancelRequestedAt',?)
        WHERE jobId=? AND taskId=? AND state='running' AND json_extract(summary,'$.resourceOwner.instance')=?`)
        .run(Date.now(), jobId, taskId, owner.instance);
      if (Number(changed.changes) !== 1 || !audit.succeeded([])) {
        throw new StateError("STALE_STATE", "取消请求未能原子持久化；不会发送信号。");
      }
    }
    result = { taskId, jobId, state: job.state, requested: true, alreadyRequested };
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* original error */ }
    throw error;
  }
  // Request acceptance is not process extinction or a terminal job result.
  if (!live.controller.signal.aborted) live.controller.abort(new Error("job cancellation requested"));
  return result;
}
