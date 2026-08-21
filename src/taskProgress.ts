import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAttestations } from "./attestation.ts";
import { listAudit } from "./audit.ts";
import { safeGit } from "./gitExec.ts";
import { listJobs, TERMINAL } from "./jobs.ts";
import type { TaskRow } from "./tasks.ts";

export type ProgressState = "done" | "pending" | "running" | "blocked" | "unknown" | "not-applicable";

export interface ProgressStage {
  state: ProgressState;
  detail: string;
}

export interface TaskProgress {
  stages: {
    code: ProgressStage;
    tests: ProgressStage;
    pr: ProgressStage;
    ci: ProgressStage;
    merged: ProgressStage;
    deploy: ProgressStage;
    verify: ProgressStage;
  };
  completed: boolean;
  cleanupRequired: boolean;
  blocker: string | null;
  nextAction: string;
}

export interface TaskProgressOptions {
  readHead?: (worktreePath: string) => string;
  filesChanged?: (task: TaskRow) => number;
  workingTreeDirty?: (worktreePath: string) => boolean;
  deployConfigured?: (worktreePath: string) => boolean;
  worktreeExists?: (worktreePath: string) => boolean;
}

interface ReceiptProjection {
  deployComplete?: boolean;
  deployJobId?: string;
  verifyComplete?: boolean;
  verifyJobId?: string;
  rolledBackAt?: number;
}

const ACTIVE_PROGRESS = new Set<ProgressState>(["running"]);

function git(worktreePath: string, args: string[]): string {
  return safeGit.local(worktreePath, args).trim();
}

function defaultReadHead(worktreePath: string): string {
  return git(worktreePath, ["rev-parse", "HEAD"]);
}

function defaultFilesChanged(task: TaskRow): number {
  const output = safeGit.diff(task.worktreePath, ["diff", "--name-only", task.baseCommit, "--"]).trim();
  const committedOrTracked = output ? output.split("\n").filter(Boolean) : [];
  const untracked = git(task.worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  const untrackedPaths = untracked ? untracked.split("\n").filter(Boolean) : [];
  return new Set([...committedOrTracked, ...untrackedPaths]).size;
}

function defaultWorkingTreeDirty(worktreePath: string): boolean {
  return git(worktreePath, ["status", "--porcelain", "--untracked-files=normal"]).length > 0;
}

function loadReceipt(db: DatabaseSync, taskId: string): ReceiptProjection | null {
  const row = db.prepare("SELECT receiptJson FROM deployment_receipt WHERE taskId=?").get(taskId) as
    | { receiptJson: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.receiptJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ReceiptProjection
      : null;
  } catch {
    return null;
  }
}

function succeededTool(db: DatabaseSync, taskId: string, tool: string): boolean {
  return listAudit(db, taskId, 500).some((row) => row.tool === tool && row.state === "SUCCEEDED");
}

function stageFromJob(
  db: DatabaseSync,
  taskId: string,
  jobId: string | undefined,
  role: "deploy" | "verify",
): ProgressStage {
  if (!jobId) return { state: "pending", detail: `${role} 尚未启动` };
  const job = listJobs(db, taskId).find((candidate) => candidate.jobId === jobId);
  if (!job) return { state: "blocked", detail: `${role} receipt 引用了不存在的 job ${jobId}` };
  if (!TERMINAL.has(job.state)) return { state: "running", detail: `${role} job ${jobId} 仍在运行` };
  if (job.state === "passed" && job.exitCode === 0) {
    return { state: "pending", detail: `${role} job 已通过，等待 grande_deploy_verify 固化 receipt` };
  }
  return { state: "blocked", detail: `${role} job ${jobId} ${job.state} (exit=${job.exitCode ?? "-"})` };
}

function firstBlocked(stages: TaskProgress["stages"]): string | null {
  for (const [name, stage] of Object.entries(stages)) {
    if (stage.state === "blocked") return `${name}: ${stage.detail}`;
  }
  return null;
}

/**
 * S10：只从既有 Task/job/audit/attestation/deployment receipt 投影日常状态。
 * 不写数据库、不引入新 lifecycle state，也不替 grande_pr_status 猜 live CI。
 */
export function projectTaskProgress(
  db: DatabaseSync,
  task: TaskRow,
  options: TaskProgressOptions = {},
): TaskProgress {
  const readHead = options.readHead ?? defaultReadHead;
  const filesChanged = options.filesChanged ?? defaultFilesChanged;
  const workingTreeDirty = options.workingTreeDirty ?? defaultWorkingTreeDirty;
  const deployConfigured = options.deployConfigured ?? ((path) => existsSync(join(path, ".grande", "deploy.yaml")));
  const worktreeExists = options.worktreeExists ?? existsSync;

  let head = "";
  let changed = 0;
  let dirty = true;
  try {
    head = readHead(task.worktreePath);
    changed = filesChanged(task);
    dirty = workingTreeDirty(task.worktreePath);
  } catch {
    // status projection 不应把单个损坏 worktree 变成整个 task_status 的异常；用 blocked 信号表达。
  }

  const attestations = getAttestations(db, task.taskId);
  const headAttested = head.length > 0 && attestations.some((candidate) => candidate.commit === head);
  const jobs = listJobs(db, task.taskId);
  const latestJob = jobs[0];
  const prOpened = succeededTool(db, task.taskId, "grande_pr_open");
  const merged = succeededTool(db, task.taskId, "grande_pr_merge");

  const code: ProgressStage = head.length === 0
    ? { state: "blocked", detail: "无法读取 task worktree HEAD" }
    : head !== task.baseCommit || changed > 0
      ? { state: "done", detail: `${changed} 个文件相对 base 有变化` }
      : { state: "pending", detail: "尚无相对 base 的代码变化" };

  let tests: ProgressStage;
  if (dirty) {
    tests = { state: "pending", detail: "worktree 有未提交变化；当前 HEAD 的旧 attestation 不能覆盖这些改动" };
  } else if (headAttested) {
    const attestation = attestations.find((candidate) => candidate.commit === head)!;
    tests = { state: "done", detail: `当前 HEAD 有 attestation (${attestation.profile})` };
  } else if (latestJob && !TERMINAL.has(latestJob.state)) {
    tests = { state: "running", detail: `最近 job ${latestJob.jobId}/${latestJob.profile} 仍在运行` };
  } else if (latestJob && latestJob.state !== "passed") {
    tests = { state: "blocked", detail: `最近 job ${latestJob.jobId}/${latestJob.profile} ${latestJob.state}` };
  } else {
    tests = { state: "pending", detail: "当前 HEAD 尚无 attestation；需要通过验证并 commit" };
  }

  const pr: ProgressStage = merged || prOpened
    ? { state: "done", detail: merged ? "已有成功 merge 记录" : "PR 已由 GrandeGPT 打开" }
    : { state: "pending", detail: "尚无成功 grande_pr_open 记录" };
  const ci: ProgressStage = merged
    ? { state: "done", detail: "成功 grande_pr_merge 证明当时 exact-head CI gate 已通过或 CI=none" }
    : prOpened
      ? { state: "unknown", detail: "live CI 不缓存；调用 grande_pr_status 读取当前 PR head" }
      : { state: "pending", detail: "PR 尚未打开" };
  const mergedStage: ProgressStage = merged
    ? { state: "done", detail: "PR 已通过 GrandeGPT merge gate" }
    : { state: "pending", detail: "尚未 merge" };

  const hasDeploy = deployConfigured(task.worktreePath);
  const receipt = hasDeploy ? loadReceipt(db, task.taskId) : null;
  let deploy: ProgressStage;
  let verify: ProgressStage;
  if (!hasDeploy) {
    deploy = { state: "not-applicable", detail: "repo 未配置 .grande/deploy.yaml" };
    verify = { state: "not-applicable", detail: "无 deploy spec，不需要 production verify" };
  } else if (!receipt) {
    deploy = { state: "pending", detail: "deploy 已配置但尚无 deployment receipt" };
    verify = { state: "pending", detail: "等待 deploy" };
  } else {
    deploy = receipt.deployComplete
      ? { state: "done", detail: "deployment receipt 标记 deploy complete" }
      : stageFromJob(db, task.taskId, receipt.deployJobId, "deploy");
    verify = receipt.verifyComplete
      ? { state: "done", detail: "deployment receipt 标记 verify complete (DONE)" }
      : deploy.state === "blocked"
        ? { state: "pending", detail: "deploy 未通过，verify 尚不能完成" }
        : stageFromJob(db, task.taskId, receipt.verifyJobId, "verify");
    if (receipt.rolledBackAt !== undefined) {
      deploy = { state: "blocked", detail: "最近 deployment receipt 已 rollback；需要新的 Task/部署闭环" };
      verify = { state: "pending", detail: "rollback 后不再把旧 verify 当作 DONE" };
    }
  }

  const stages = { code, tests, pr, ci, merged: mergedStage, deploy, verify };
  const completed = merged && (deploy.state === "not-applicable" || verify.state === "done");
  const cleanupRequired = completed && task.state !== "CLOSED" && worktreeExists(task.worktreePath);
  const blocker = firstBlocked(stages);

  let nextAction: string;
  if (blocker) nextAction = `先处理阻塞：${blocker}`;
  else if (cleanupRequired) nextAction = `闭环证据已完成，但 worktree/task 仍保留；Human 确认后显式 grande_task_close`;
  else if (tests.state !== "done") nextAction = "运行合适的验证 profile；通过后 grande_commit 生成当前 SHA attestation";
  else if (pr.state !== "done") nextAction = "grande_push 后 grande_pr_open";
  else if (ci.state === "unknown") nextAction = "调用 grande_pr_status 查看当前 exact-head CI；失败则按 bounded diagnostics 修复";
  else if (mergedStage.state !== "done") nextAction = "CI/attestation 门禁满足后 grande_pr_merge";
  else if (deploy.state === "pending") nextAction = "调用 grande_deploy";
  else if (ACTIVE_PROGRESS.has(deploy.state) || ACTIVE_PROGRESS.has(verify.state)) nextAction = "等待当前 deployment job 结束后重入 grande_deploy_verify";
  else if (verify.state === "pending") nextAction = "调用 grande_deploy_verify";
  else nextAction = "无待处理动作";

  return { stages, completed, cleanupRequired, blocker, nextAction };
}

export function compactTaskProgress(progress: TaskProgress): string {
  const glyph = (state: ProgressState): string => {
    if (state === "done") return "✓";
    if (state === "not-applicable") return "—";
    if (state === "blocked") return "✗";
    if (ACTIVE_PROGRESS.has(state)) return "↻";
    if (state === "unknown") return "?";
    return "·";
  };
  const s = progress.stages;
  return [
    `Code ${glyph(s.code.state)}`,
    `Tests ${glyph(s.tests.state)}`,
    `PR ${glyph(s.pr.state)}`,
    `CI ${glyph(s.ci.state)}`,
    `Merged ${glyph(s.merged.state)}`,
    `Deploy ${glyph(s.deploy.state)}`,
    `Verify ${glyph(s.verify.state)}`,
  ].join("  ");
}
