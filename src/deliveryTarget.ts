import type { DatabaseSync } from "node:sqlite";
import { listAudit } from "./audit.ts";
import { safeGit } from "./gitExec.ts";
import type { TaskProgress, TaskProgressPhase } from "./taskProgress.ts";
import type { TaskRow } from "./tasks.ts";

export type DeliveryTarget = "local" | "pr" | "deploy";

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
 * Phase 8 cannot add deliveryTarget to the public grande_task_open schema without changing
 * the tool digest. Resolve the target from already-trusted task evidence instead. A repo with
 * a GitHub origin defaults to PR; production is selected only after durable deployment evidence
 * exists, meaning Phase 8 never upgrades an ordinary task into a new production side effect.
 */
export function resolveDeliveryTarget(
  db: DatabaseSync,
  task: TaskRow,
  options: DeliveryTargetOptions = {},
): DeliveryTarget {
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

  progress.liveness.phase = progress.phase;
  progress.liveness.nextAction = progress.nextAction;
  if (progress.completed || progress.blocker !== null) progress.liveness.state = "active";
  return progress;
}
