import type { DatabaseSync } from "node:sqlite";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beginAudit } from "./audit.ts";
import { safeGit } from "./gitExec.ts";
import type { Layout } from "./layout.ts";
import { applyRepoOnboarding, inspectRepoOnboarding, type RepoOnboardingProposal } from "./onboarding.ts";
import { PathSecurityError } from "./paths.ts";

export type ConsoleRepoOnboardingCode =
  | "already_registered"
  | "repo_not_ready"
  | "initialization_failed"
  | "registration_failed";

export class ConsoleRepoOnboardingError extends Error {
  readonly code: ConsoleRepoOnboardingCode;

  constructor(code: ConsoleRepoOnboardingCode, message: string) {
    super(message);
    this.name = `ConsoleRepoOnboardingError [${code}]`;
    this.code = code;
  }
}

export interface ConsoleRepoOnboardingResult {
  repoId: string;
  initialized: boolean;
  registered: true;
}

function inspectCandidate(layout: Layout, repoId: string): RepoOnboardingProposal {
  try {
    return inspectRepoOnboarding(layout, repoId);
  } catch (error) {
    if (error instanceof PathSecurityError) {
      throw new ConsoleRepoOnboardingError(
        "repo_not_ready",
        "项目路径未通过 workspace direct-child 安全校验。",
      );
    }
    throw error;
  }
}

function emptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    throw new ConsoleRepoOnboardingError("repo_not_ready", "项目目录无法读取，不能安全注册。");
  }
}

function minimalGitInit(db: DatabaseSync, proposal: RepoOnboardingProposal): void {
  const audit = beginAudit(db, {
    taskId: null,
    tool: "grande_repo_init",
    input: { repoId: proposal.repoId },
  });
  audit.allowed();
  if (!audit.executing()) {
    throw new ConsoleRepoOnboardingError("initialization_failed", "项目初始化审计无法进入 EXECUTING。");
  }

  const gitDir = join(proposal.repoPath, ".git");
  try {
    safeGit.local(proposal.repoPath, ["init", "-q", "-b", "main"]);
    safeGit.local(proposal.repoPath, [
      "-c", "user.name=GrandeGPT",
      "-c", "user.email=grande@localhost",
      "commit", "--allow-empty", "-q", "-m", "chore: initialize repository",
    ]);
    audit.succeeded([proposal.repoPath]);
  } catch (error) {
    // 本函数只会在确认目录为空、且之前不存在有效 Git repository 时进入。
    // 若 init/commit 中途失败，回滚本次创建的 .git，避免留下半初始化 repo。
    rmSync(gitDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    audit.failed(message, [proposal.repoPath]);
    throw new ConsoleRepoOnboardingError("initialization_failed", "最小 Git 初始化失败；已回滚本次初始化。");
  }
}

function readinessMessage(proposal: RepoOnboardingProposal): string {
  if (!proposal.git.repository) {
    return "目录非空，但不是有效 Git repository；请先初始化或修复仓库后再注册。";
  }
  const detail = proposal.blockingReasons.join(" ").trim();
  return detail.length > 0
    ? `Repository is not ready for GrandeGPT development lifecycle: ${detail}`
    : "Repository is not ready for GrandeGPT development lifecycle.";
}

/**
 * Console 的单次显式注册动作。执行权仍在 GrandeGPT Gateway：
 * path security/readiness 复用 canonical onboarding primitive，Console 不直接写 repos.yaml。
 */
export function registerConsoleRepo(
  db: DatabaseSync,
  layout: Layout,
  repoId: string,
): ConsoleRepoOnboardingResult {
  let proposal = inspectCandidate(layout, repoId);
  if (proposal.alreadyRegistered) {
    throw new ConsoleRepoOnboardingError("already_registered", `仓库 ${repoId} 已注册；拒绝重复注册。`);
  }

  let initialized = false;
  if (!proposal.git.repository) {
    if (!emptyDirectory(proposal.repoPath)) {
      throw new ConsoleRepoOnboardingError("repo_not_ready", readinessMessage(proposal));
    }
    minimalGitInit(db, proposal);
    initialized = true;
    proposal = inspectCandidate(layout, repoId);
  }

  if (!proposal.readyToRegister) {
    throw new ConsoleRepoOnboardingError("repo_not_ready", readinessMessage(proposal));
  }

  const audit = beginAudit(db, {
    taskId: null,
    tool: "grande_repo_add_apply",
    input: { repoId },
  });
  audit.allowed();
  if (!audit.executing()) {
    throw new ConsoleRepoOnboardingError("registration_failed", "项目注册审计无法进入 EXECUTING。");
  }

  try {
    applyRepoOnboarding(layout, proposal);
    const touched = [layout.reposConfig];
    if (proposal.profiles.length > 0 || proposal.cloneNodeModules) {
      touched.push(join(layout.configDir, "profiles.yaml"));
    }
    audit.succeeded(touched);
    return { repoId, initialized, registered: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit.failed(message);
    throw new ConsoleRepoOnboardingError(
      "registration_failed",
      "GrandeGPT canonical registration 失败；项目未被标记为成功注册。",
    );
  }
}
