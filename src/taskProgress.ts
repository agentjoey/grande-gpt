import type { DatabaseSync } from "node:sqlite";
import { getExplicitDeliveryTarget } from "./taskDeliveryTarget.ts";
import type { TaskRow } from "./tasks.ts";
import {
  compactTaskProgress as compactCoreTaskProgress,
  projectTaskProgress as projectCoreTaskProgress,
  type TaskLiveness as CoreTaskLiveness,
  type TaskProgress as CoreTaskProgress,
  type TaskProgressOptions,
} from "./taskProgressCore.ts";

export * from "./taskProgressCore.ts";

export type TaskInactivityClass = "active" | "waiting_human" | "waiting_ci" | "waiting_external" | "stalled_agent";
export interface CleanupEligibility { eligible: boolean; reason: string }
export interface TaskLiveness extends CoreTaskLiveness { classification?: TaskInactivityClass }
export interface TaskProgress extends Omit<CoreTaskProgress, "liveness"> { liveness: TaskLiveness; cleanupEligibility?: CleanupEligibility }
const RUNNING_STATES = new Set<string>(["running"]);

function inactivityClass(progress: CoreTaskProgress): TaskInactivityClass {
  if (progress.liveness.inactiveForMs < progress.liveness.stallAfterMs) return "active";
  if (progress.deliveryAuthorization?.state === "READY_FOR_DELIVERY_APPROVAL" || progress.hostVerification.state === "manual-required") return "waiting_human";
  if (progress.phase === "ci") return "waiting_ci";
  if (progress.cleanupRequired || ["merge", "deploy", "verify"].includes(progress.phase)) return "waiting_external";
  if (progress.liveness.state === "stalled") return "stalled_agent";
  return "active";
}

function cleanupEligibility(db: DatabaseSync, task: TaskRow, progress: CoreTaskProgress, dirty: boolean): CleanupEligibility {
  if (progress.completed && task.state === "CLOSED" && !progress.cleanupRequired) return { eligible: false, reason: "Task 已关闭且 worktree 已清理" };
  if (dirty) return { eligible: false, reason: "worktree dirty/uncommitted" };
  const running = [progress.stages.tests.state, progress.stages.deploy.state, progress.stages.verify.state, progress.hostVerification.state].some((state) => RUNNING_STATES.has(state));
  if (running) return { eligible: false, reason: "仍有运行中 job" };
  if (progress.deliveryAuthorization?.state === "DELIVERY_UNCERTAIN") return { eligible: false, reason: "delivery outcome uncertain" };
  if (getExplicitDeliveryTarget(db, task.taskId) === "deploy" && progress.deliveryAuthorization?.state !== "DELIVERY_DONE") return { eligible: false, reason: "delivery unresolved" };
  if (progress.completed && progress.cleanupRequired && progress.stages.merged.state === "done") return { eligible: true, reason: "durable completion 已成立；仍须受控 reconciliation 重新验证 cleanup preconditions" };
  return { eligible: false, reason: "缺少完整 durable completion/cleanup evidence" };
}

/** Task 4 read-only overlay; legacy liveness.state stays compatible while classification adds richer semantics. */
export function projectTaskProgress(db: DatabaseSync, task: TaskRow, options: TaskProgressOptions = {}): TaskProgress {
  const core = projectCoreTaskProgress(db, task, options);
  const exists = options.worktreeExists?.(task.worktreePath) ?? true;
  const archived = core.completed && task.state === "CLOSED" && !exists;
  if (archived) {
    core.stages.code = { state: "done", detail: "Task 已完成并关闭；worktree 已清理" };
    core.stages.tests = { state: "done", detail: "Task 已完成并关闭；保留历史验证证据" };
  }
  let dirty = true;
  try { dirty = archived ? false : (options.workingTreeDirty?.(task.worktreePath) ?? false); } catch { dirty = true; }
  return { ...core, liveness: { ...core.liveness, classification: inactivityClass(core) }, cleanupEligibility: cleanupEligibility(db, task, core, dirty) };
}

export function compactTaskProgress(progress: TaskProgress): string { return compactCoreTaskProgress(progress); }
