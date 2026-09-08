import type { DatabaseSync } from "node:sqlite";
import { listAudit } from "./audit.ts";
import { safeGit } from "./gitExec.ts";
import { getExplicitDeliveryTarget, type DeliveryTarget } from "./taskDeliveryTarget.ts";
import type { DeliveryAuthorizationProjection, TaskProgress, TaskProgressPhase } from "./taskProgress.ts";
import type { TaskRow } from "./tasks.ts";

// 单一真相源在 taskDeliveryTarget.ts（V2 起 target 可以显式持久化）；
// 这里保留 re-export，既有调用点不用改 import。
export type { DeliveryTarget } from "./taskDeliveryTarget.ts";

export interface DeliveryTargetOptions {
  readOrigin?: (task: TaskRow) => string | null;
}

const HOST_ACTIVE = new Set(["running"]);
const HOST_RUNTIME = new Set([
  "running",
  "failed",
  "retryable-failure",
  "retry-exhausted",
  "integrity-failure",
]);
const HOST_PENDING = new Set(["required", "manual-required"]);
const ACTIVE_PROGRESS = new Set(["running"]);

function defaultReadOrigin(task: TaskRow): string | null {
  try {
    const value = safeGit.local(task.worktreePath, ["remote", "get-url", "origin"]).trim();
    return value || null;
  } catch {
    return null;
  }
}

function isGitHubOrigin(value: string | null): boolean {
  if (!value) return false;
  return /^https:\/\/github\.com\//iu.test(value) || /^git@github\.com:/iu.test(value) || /^ssh:\/\/git@github\.com\//iu.test(value);
}

/**
 * Minimal V2：`grande_task_open` 可以把显式 `deliveryTarget` 持久化到
 * `task_delivery_target`（见 taskDeliveryTarget.ts）——显式行一旦存在就优先，
 * 不可变，不从 repo 内容推断。
 *
 * 没有显式行的旧任务保留 Phase 8 的纯证据投影（仅影响 status 展示，不能凭它
 * 创建 V2 authorization）：有 durable deployment evidence 才算 deploy；repo 有
 * GitHub origin 默认 PR；否则 local。这个默认方向是保守的——legacy 投影永远
 * 不会把一个普通任务升级出新的 production side effect。
 */
export function resolveDeliveryTarget(
  db: DatabaseSync,
  task: TaskRow,
  options: DeliveryTargetOptions = {},
): DeliveryTarget {
  const explicit = getExplicitDeliveryTarget(db, task.taskId);
  if (explicit !== undefined) return explicit;

  const deploymentReceipt = db.prepare("SELECT 1 AS present FROM deployment_receipt WHERE taskId=?").get(task.taskId);
  if (deploymentReceipt) return "deploy";

  const audits = listAudit(db, task.taskId, 500);
  if (audits.some((row) => row.state === "SUCCEEDED" && ["grande_push", "grande_pr_open", "grande_pr_merge"].includes(row.tool))) {
    return "pr";
  }

  const readOrigin = options.readOrigin ?? defaultReadOrigin;
  return isGitHubOrigin(readOrigin(task)) ? "pr" : "local";
}

function notApplicable(detail: string) {
  return { state: "not-applicable" as const, detail };
}

function firstBlocked(progress: TaskProgress, target: DeliveryTarget): string | null {
  const names = target === "local"
    ? (["code", "tests"] as const)
    : target === "pr"
      ? (["code", "tests", "pr", "ci", "merged"] as const)
      : (["code", "tests", "pr", "ci", "merged", "deploy", "verify"] as const);
  for (const name of names) {
    const stage = progress.stages[name];
    if (stage.state === "blocked") return `${name}: ${stage.detail}`;
  }
  return null;
}

function hostBlocker(progress: TaskProgress, target: DeliveryTarget): string | null {
  if (target === "local") return null;
  return progress.blocker?.startsWith("hostVerification:") ? progress.blocker : null;
}

function nextForPr(progress: TaskProgress, taskId: string | null): string {
  const host = progress.hostVerification;
  if (progress.localState === "merged-local-stale") {
    return "再次调用 grande_pr_merge；只重试本地 reconciliation，不会重复 remote merge";
  }
  if (progress.stages.tests.state !== "done") {
    return "运行合适的验证 profile；通过后 grande_commit 生成当前 SHA attestation";
  }
  if (progress.stages.pr.state !== "done") return "grande_push 后 grande_pr_open";
  if (HOST_ACTIVE.has(host.state)) {
    return `等待 verifier job ${host.jobId ?? "当前 job"} 进入终态；随后直接再次调用 grande_pr_merge，无需重复 Human confirmation`;
  }
  if (host.state === "retryable-failure") {
    return "再次调用 grande_pr_merge；只允许一次受限 verifier infrastructure retry";
  }
  if (host.state === "required") {
    return "直接调用 grande_pr_merge 创建或观察当前 exact-SHA host verifier";
  }
  if (host.state === "manual-required") {
    return taskId ? `运行 grande outer-test --task ${taskId} --run` : "执行当前 task 的 manual host verification";
  }
  if (progress.stages.merged.state !== "done") {
    return "直接调用 grande_pr_merge；merge gate 会现查 exact PR head、CI、attestation 与 host receipt";
  }
  return "无待处理动作";
}

function phaseForPr(progress: TaskProgress): TaskProgressPhase {
  if (progress.localState === "merged-local-stale" || progress.cleanupRequired) return "cleanup";
  if (progress.stages.code.state !== "done") return "code";
  if (progress.stages.tests.state !== "done") return "tests";
  if (progress.stages.pr.state !== "done") return "pr";
  if (HOST_RUNTIME.has(progress.hostVerification.state)) return "host-verification";
  if (HOST_PENDING.has(progress.hostVerification.state)) return "host-verification";
  if (progress.stages.merged.state !== "done") return "merge";
  return "completed";
}

/**
 * V2：有 DeliveryAuthorizationProjection 时，deploy target 的 nextAction 由授权状态机
 * 唯一决定——READY 停下等 Human Console 审批，FAILED/UNCERTAIN 停止一切自动工作。
 */
function deliveryAuthorizationNextAction(p: DeliveryAuthorizationProjection): string {
  switch (p.state) {
    case "READY_FOR_DELIVERY_APPROVAL":
      return "停止自动执行；等待 Human Console 审批该 delivery authorization";
    case "DELIVERY_APPROVED":
      return "调用 grande_pr_merge";
    case "DELIVERY_EXECUTING":
      switch (p.stage) {
        case "merge": return "调用或重入观察 grande_pr_merge 的 delivery merge";
        case "deploy": return "调用 grande_deploy";
        case "verify": return "调用 grande_deploy_verify";
        case "rollback": return "调用 grande_deploy_rollback";
      }
    case "DELIVERY_FAILED":
      return "停止自动工作；delivery authorization 已 FAILED，需 Human 处理后开新审批";
    case "DELIVERY_UNCERTAIN":
      return "停止自动工作；delivery authorization 处于 UNCERTAIN，Human 先确认外部真实状态";
    case "DELIVERY_DONE":
      return "无待处理动作";
  }
}

/**
 * Mask lifecycle stages that are irrelevant to the selected delivery target and recompute the
 * single blocker/nextAction projection. This deliberately does not add a lifecycle table/state.
 */
export function projectDeliveryTargetProgress(
  source: TaskProgress,
  target: DeliveryTarget,
  taskId: string | null = null,
): TaskProgress {
  const progress: TaskProgress = {
    ...source,
    stages: {
      code: { ...source.stages.code },
      tests: { ...source.stages.tests },
      pr: { ...source.stages.pr },
      ci: { ...source.stages.ci },
      merged: { ...source.stages.merged },
      deploy: { ...source.stages.deploy },
      verify: { ...source.stages.verify },
    },
    hostVerification: { ...source.hostVerification },
    liveness: { ...source.liveness },
  };

  if (target === "local") {
    progress.stages.pr = notApplicable("deliveryTarget=local，不需要 PR");
    progress.stages.ci = notApplicable("deliveryTarget=local，不需要 CI");
    progress.stages.merged = notApplicable("deliveryTarget=local，不需要 merge");
    progress.stages.deploy = notApplicable("deliveryTarget=local，不需要 deploy");
    progress.stages.verify = notApplicable("deliveryTarget=local，不需要 production verify");
    progress.completed = progress.stages.code.state === "done" && progress.stages.tests.state === "done";
    progress.cleanupRequired = false;
    progress.localState = progress.completed ? "completed" : "active";
    progress.blocker = firstBlocked(progress, target);
    progress.nextAction = progress.blocker
      ? `先处理阻塞：${progress.blocker}`
      : progress.stages.code.state !== "done"
        ? "完成当前任务改动；随后运行合适的验证 profile"
        : progress.stages.tests.state !== "done"
          ? "运行合适的验证 profile；通过后 grande_commit 生成当前 SHA attestation"
          : "无待处理动作（deliveryTarget=local 已完成）";
    progress.phase = progress.stages.code.state !== "done"
      ? "code"
      : progress.stages.tests.state !== "done"
        ? "tests"
        : "completed";
  } else {
    if (target === "pr") {
      progress.stages.deploy = notApplicable("deliveryTarget=pr，不需要 deploy");
      progress.stages.verify = notApplicable("deliveryTarget=pr，不需要 production verify");
    } else if (progress.stages.deploy.state === "not-applicable") {
      progress.stages.deploy = { state: "blocked", detail: "deliveryTarget=deploy 但 repo 未配置可信 .grande/deploy.yaml" };
      progress.stages.verify = { state: "pending", detail: "等待可信 deploy spec" };
    }

    const merged = progress.stages.merged.state === "done";
    progress.completed = target === "pr"
      ? merged
      : merged && progress.stages.verify.state === "done";
    progress.cleanupRequired = progress.localState === "merged-local-stale"
      || (progress.completed && progress.localState !== "completed");
    if (progress.completed && !progress.cleanupRequired) progress.localState = "completed";

    progress.blocker = progress.localState === "merged-local-stale"
      ? "cleanup: remote merged but local reconciliation is stale"
      : hostBlocker(progress, target) ?? firstBlocked(progress, target);

    if (progress.blocker) {
      progress.nextAction = progress.localState === "merged-local-stale"
        ? nextForPr(progress, taskId)
        : source.blocker?.startsWith("hostVerification:")
          ? source.nextAction
          : `先处理阻塞：${progress.blocker}`;
    } else if (progress.cleanupRequired) {
      progress.nextAction = "闭环证据已完成，但 worktree/task 仍保留；显式 grande_task_close 完成 cleanup";
    } else if (!merged) {
      progress.nextAction = nextForPr(progress, taskId);
    } else if (target === "deploy") {
      if (progress.stages.deploy.state === "pending") progress.nextAction = "调用 grande_deploy";
      else if (ACTIVE_PROGRESS.has(progress.stages.deploy.state) || ACTIVE_PROGRESS.has(progress.stages.verify.state)) {
        progress.nextAction = "等待当前 deployment job 结束后重入 grande_deploy_verify";
      } else if (progress.stages.verify.state === "pending") progress.nextAction = "调用 grande_deploy_verify";
      else progress.nextAction = "无待处理动作";
    } else {
      progress.nextAction = "无待处理动作";
    }

    if (!merged) {
      progress.phase = phaseForPr(progress);
    } else if (progress.cleanupRequired) {
      progress.phase = "cleanup";
    } else if (target === "deploy" && progress.stages.deploy.state !== "done") {
      progress.phase = "deploy";
    } else if (target === "deploy" && progress.stages.verify.state !== "done") {
      progress.phase = "verify";
    } else {
      progress.phase = "completed";
    }
  }

  if (target === "deploy" && progress.deliveryAuthorization) {
    progress.nextAction = deliveryAuthorizationNextAction(progress.deliveryAuthorization);
  }
  progress.liveness.phase = progress.phase;
  progress.liveness.nextAction = progress.nextAction;
  if (progress.completed || progress.blocker !== null) progress.liveness.state = "active";
  return progress;
}
