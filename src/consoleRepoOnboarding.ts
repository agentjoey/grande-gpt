import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beginAudit, type AuditHandle } from "./audit.ts";
import { openDb } from "./db.ts";
import { safeGit } from "./gitExec.ts";
import { ensureLayout, loadLayout, type Layout } from "./layout.ts";
import { applyRepoOnboarding, inspectRepoOnboarding } from "./onboarding.ts";
import { assertValidId, resolveRepoPath } from "./paths.ts";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function candidatePath(layout: Layout, repoId: string): string {
  // 与 onboarding.ts 一样，只在本次调用里把 repoId 放进 ephemeral set，
  // 复用既有 direct-child / realpath / symlink path security，但不产生注册授权。
  return resolveRepoPath(layout, repoId, new Set([repoId]));
}

function beginAllowedAudit(
  db: ReturnType<typeof openDb>,
  tool: string,
  input: unknown,
): AuditHandle {
  const audit = beginAudit(db, { taskId: null, tool, input });
  if (!audit.allowed()) throw new Error(`${tool} audit 无法落 ALLOWED 决策。`);
  if (!audit.executing()) throw new Error(`${tool} audit 无法进入 EXECUTING。`);
  return audit;
}

function initializeEmptyRepoIfNeeded(
  layout: Layout,
  repoId: string,
  db: ReturnType<typeof openDb>,
): boolean {
  const repoPath = candidatePath(layout, repoId);
  if (readdirSync(repoPath).length !== 0) return false;

  const audit = beginAllowedAudit(db, "grande_repo_init", { repoId });
  try {
    safeGit.local(repoPath, ["init", "-q", "-b", "main"]);
    safeGit.local(repoPath, [
      "-c", "user.name=GrandeGPT",
      "-c", "user.email=grande@localhost",
      "commit", "--allow-empty", "-q", "-m", "chore: initialize repository",
    ]);
    if (!audit.succeeded([repoPath])) throw new Error("grande_repo_init audit 无法落 SUCCEEDED。");
    return true;
  } catch (error) {
    // 输入前提是空目录；若初始化中途失败，只回滚本次产生的 .git，恢复原始空目录。
    rmSync(join(repoPath, ".git"), { recursive: true, force: true });
    audit.failed(errorText(error));
    throw error;
  }
}

function registrationTouched(layout: Layout, proposal: ReturnType<typeof inspectRepoOnboarding>): string[] {
  const touched = [layout.reposConfig];
  if (proposal.profiles.length > 0 || proposal.cloneNodeModules) {
    touched.push(join(layout.configDir, "profiles.yaml"));
  }
  return touched;
}

export type ConsoleRepoRegistrationResult =
  | { ok: true; repoId: string; initialized: boolean; registered: true }
  | { ok: false; code: "invalid_input" | "already_registered" | "repo_not_ready" | "onboarding_failed"; message: string };

/**
 * GrandeGPT 内部给 Console HTTP endpoint 使用的受控 onboarding 语义。
 * 不接受路径，只接受 repoId；空目录可做最小 Git 初始化，真正注册仍走 canonical
 * inspect/apply，并把 init/apply 分别写进 audit。公开 MCP tool surface 完全不变。
 */
export function registerRepoFromConsole(repoId: string): ConsoleRepoRegistrationResult {
  try {
    assertValidId(repoId, "repoId");
  } catch (error) {
    return { ok: false, code: "invalid_input", message: errorText(error) };
  }

  const layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);
  try {
    const initialized = initializeEmptyRepoIfNeeded(layout, repoId, db);
    const proposal = inspectRepoOnboarding(layout, repoId);
    if (proposal.alreadyRegistered) {
      return { ok: false, code: "already_registered", message: `仓库 ${repoId} 已注册；拒绝重复注册。` };
    }
    if (!proposal.readyToRegister) {
      return {
        ok: false,
        code: "repo_not_ready",
        message: `仓库 ${repoId} readiness not ready：${proposal.blockingReasons.join(" ")}`,
      };
    }

    const audit = beginAllowedAudit(db, "grande_repo_add_apply", { repoId, source: "grande-console" });
    try {
      applyRepoOnboarding(layout, proposal);
      if (!audit.succeeded(registrationTouched(layout, proposal))) {
        throw new Error("grande_repo_add_apply audit 无法落 SUCCEEDED。");
      }
      return { ok: true, repoId, initialized, registered: true };
    } catch (error) {
      audit.failed(errorText(error));
      throw error;
    }
  } catch (error) {
    return { ok: false, code: "onboarding_failed", message: errorText(error) };
  } finally {
    db.close();
  }
}

/** 保留窄 CLI 入口，方便本机诊断；产品路径由 Gateway route 调上面的领域函数。 */
export function runConsoleRepoOnboarding(argv: string[], out: (line: string) => void = console.log): number {
  const [action, repoId, ...extra] = argv;
  if (action !== "register" || repoId === undefined || extra.length > 0) {
    out("用法错误：console repo onboarding register <repoId>");
    return 1;
  }
  const result = registerRepoFromConsole(repoId);
  if (result.ok) {
    if (result.initialized) out(`仓库 ${repoId} 已完成最小 Git 初始化：main + baseline commit；未生成业务代码。`);
    out(`仓库 ${repoId} 已注册到 GrandeGPT canonical registry。`);
    return 0;
  }
  out(result.message);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runConsoleRepoOnboarding(process.argv.slice(2));
}
