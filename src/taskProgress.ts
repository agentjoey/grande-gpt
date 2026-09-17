import { lstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getAttestations } from "./attestation.ts";
import { assertTaskBranch } from "./commit.ts";
import { safeGit } from "./gitExec.ts";
import { listJobs, TERMINAL } from "./jobs.ts";
import { getExplicitDeliveryTarget } from "./taskDeliveryTarget.ts";
import { readTaskPrReceipt } from "./taskPrReceipt.ts";
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

function inactivityClass(progress: CoreTaskProgress, hasLiveJob: boolean): TaskInactivityClass {
  if (hasLiveJob || (progress.completed && !progress.cleanupRequired)) return "active";
  if (progress.liveness.inactiveForMs < progress.liveness.stallAfterMs) return "active";
  if (progress.deliveryAuthorization?.state === "READY_FOR_DELIVERY_APPROVAL" || progress.hostVerification.state === "manual-required") return "waiting_human";
  if (progress.phase === "ci") return "waiting_ci";
  if (progress.cleanupRequired || ["merge", "deploy", "verify"].includes(progress.phase)) return "waiting_external";
  if (progress.liveness.state === "stalled") return "stalled_agent";
  return "active";
}

/** Only ENOENT proves removal. Permission and other I/O failures remain unknown. */
function existingWorktree(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function cleanupEligibility(
  db: DatabaseSync,
  task: TaskRow,
  progress: CoreTaskProgress,
  exists: boolean | undefined,
  dirty: boolean | undefined,
  hasLiveJob: boolean,
): CleanupEligibility {
  if (progress.completed && task.state === "CLOSED" && exists === false) {
    return { eligible: false, reason: "Task 已关闭且 worktree 已清理" };
  }
  if (exists !== true || dirty === undefined || !progress.taskHead) {
    return { eligible: false, reason: "worktree 不存在或无法验证 Git 状态" };
  }
  if (dirty) return { eligible: false, reason: "worktree dirty/uncommitted" };
  const runningStage = [progress.stages.tests.state, progress.stages.deploy.state,
    progress.stages.verify.state, progress.hostVerification.state].some((state) => RUNNING_STATES.has(state));
  if (hasLiveJob || runningStage) return { eligible: false, reason: "仍有非终态 job" };
  if (progress.deliveryAuthorization?.state === "DELIVERY_UNCERTAIN") {
    return { eligible: false, reason: "delivery outcome uncertain" };
  }
  // Missing local config cannot erase durable deployment/authorization obligations.
  const hasDeliveryEvidence = getExplicitDeliveryTarget(db, task.taskId) === "deploy"
    || db.prepare("SELECT 1 FROM deployment_receipt WHERE taskId=?").get(task.taskId) !== undefined
    || db.prepare("SELECT 1 FROM delivery_authorization WHERE taskId=? LIMIT 1").get(task.taskId) !== undefined;
  if (hasDeliveryEvidence && progress.deliveryAuthorization?.state !== "DELIVERY_DONE") {
    return { eligible: false, reason: "delivery unresolved；缺少可信的 exact delivery completion" };
  }
  const receipt = readTaskPrReceipt(db, task.taskId);
  if (task.state === "READY" && progress.completed && progress.cleanupRequired
      && progress.blocker === null && receipt?.mergeSha && receipt.headSha === progress.taskHead) {
    return { eligible: true, reason: "exact merged head 与 clean worktree 一致；仍须受控 reconciliation 重新验证 cleanup preconditions" };
  }
  return { eligible: false, reason: "缺少匹配当前 HEAD 的完整 durable completion/cleanup evidence" };
}

/** Read-only projection. Share actual observations with the core instead of assuming safe defaults. */
export function projectTaskProgress(db: DatabaseSync, task: TaskRow, options: TaskProgressOptions = {}): TaskProgress {
  let exists: boolean | undefined;
  let dirty: boolean | undefined;
  try { exists = (options.worktreeExists ?? existingWorktree)(task.worktreePath); } catch { /* unknown, not removed */ }
  const core = projectCoreTaskProgress(db, task, {
    ...options,
    readHead: options.readHead ?? ((path) => assertTaskBranch(path, task.branch)),
    worktreeExists: () => exists !== false,
    workingTreeDirty: (path) => {
      dirty = options.workingTreeDirty
        ? options.workingTreeDirty(path)
        : safeGit.local(path, ["status", "--porcelain=v1", "--untracked-files=all"]).trim().length > 0;
      return dirty;
    },
  });
  const hasLiveJob = listJobs(db, task.taskId).some((job) => !TERMINAL.has(job.state));
  const archived = core.completed && task.state === "CLOSED" && exists === false && !hasLiveJob;
  if (archived) {
    core.stages.code = { state: "unknown", detail: "worktree 已归档；不再读取或重新验证本地代码" };
    const receipt = readTaskPrReceipt(db, task.taskId);
    const attestation = getAttestations(db, task.taskId).find((row) => row.exitCode === 0 && row.commit === receipt?.headSha);
    core.stages.tests = attestation
      ? { state: "done", detail: `已归档 exact head 的历史 attestation (${attestation.profile})；非本次重跑` }
      : { state: "unknown", detail: "已归档；缺少 exact head 的历史验证证据，不补写 PASS" };
  }
  return {
    ...core,
    liveness: { ...core.liveness, classification: inactivityClass(core, hasLiveJob) },
    cleanupEligibility: cleanupEligibility(db, task, core, exists, dirty, hasLiveJob),
  };
}

export function compactTaskProgress(progress: TaskProgress): string { return compactCoreTaskProgress(progress); }
