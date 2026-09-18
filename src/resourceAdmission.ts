import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import { createJob, getJob, listNonterminalJobs, setRunningJobSummary, type JobRow } from "./jobs.ts";
import type { Layout } from "./layout.ts";
import { assertDiskHeadroom, loadResourcePolicy } from "./resourcePolicy.ts";
import { getTaskCloseIntent } from "./taskCloseIntent.ts";
import { getTask } from "./tasks.ts";

export type ManagedJobKind = "sandbox" | "dependency-bootstrap" | "dependency-cache-materialize" | "host-verifier" | "deployment-host";
const OWNER_INSTANCE = randomUUID();

/** Reserve the existing job row atomically. Preparing jobs consume capacity before any spawn/copy. */
export function reserveManagedJob(
  db: DatabaseSync,
  layout: Layout,
  input: { jobId: string; taskId: string; profile: string; argv: string[]; kind: ManagedJobKind },
  additionalRoots: readonly string[] = [],
): JobRow {
  const policy = loadResourcePolicy(layout);
  assertDiskHeadroom(layout, policy, additionalRoots);
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = getTask(db, input.taskId);
    if (!task || task.state !== "READY") throw new StateError("STALE_STATE", "资源准入要求仍处于 READY 的真实 task。");
    if (getTaskCloseIntent(db, input.taskId)) throw new StateError("STALE_STATE", "task 已有 durable close intent；拒绝新执行，先完成关闭对账。");
    const active = listNonterminalJobs(db);
    const own = active.filter((job) => job.taskId === input.taskId);
    if (own.length >= policy.perTaskJobs) {
      throw new StateError("JOB_RUNNING", `任务已有执行占位 ${own[0]!.jobId}；per-task capacity=${policy.perTaskJobs}，请查询现有 job。`);
    }
    const verifier = input.kind === "host-verifier" ? active.find((job) => job.profile === "host-verifier") : undefined;
    if (verifier) throw new StateError("JOB_RUNNING", `已有 host verifier ${verifier.jobId}；全局只允许一个 verifier。`);
    if (active.length >= policy.globalJobs) {
      throw new StateError("RESOURCE_EXHAUSTED", `全局 execution capacity=${policy.globalJobs} 已满；请查询 ${active[0]!.jobId}，不要创建重复 job。`);
    }
    createJob(db, { jobId: input.jobId, taskId: input.taskId, profile: input.profile, argv: input.argv, pgid: null });
    setRunningJobSummary(db, input.jobId, { resourceOwner: {
      instance: OWNER_INSTANCE, pid: process.pid, kind: input.kind, phase: "preparing",
    } });
    const job = getJob(db, input.jobId)!;
    db.exec("COMMIT");
    return job;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  }
}

/** Mark the crash window before handing control to a process/copy adapter. Never expire it by TTL. */
export function markManagedJobLaunching(db: DatabaseSync, jobId: string): void {
  const result = db.prepare(`UPDATE job SET summary=json_set(summary,'$.resourceOwner.phase','launching')
    WHERE jobId=? AND state='running' AND json_extract(summary,'$.resourceOwner.instance')=?`)
    .run(jobId, OWNER_INSTANCE);
  if (Number(result.changes) !== 1) throw new StateError("STALE_STATE", "job 准入占位已失效；禁止启动执行。");
}
