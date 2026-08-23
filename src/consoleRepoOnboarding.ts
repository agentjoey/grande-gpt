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
  out: (line: string) => void,
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
    if (!audit.succeeded([repoPath])) throw new Error("grande_repo_init audit 无法落 SUCCEEDED。 ");
    out(`仓库 ${repoId} 已完成最小 Git 初始化：main + baseline commit；未生成业务代码。`);
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

/**
 * grande-console 专用的窄本机 onboarding 边界。
 *
 * 它不接受绝对路径、不改公开 MCP tool surface，也不让 Console 直接写 GrandeGPT
 * 控制平面。Human 在 Console 点击“注册”后，Console 只需调用：
 *   node src/consoleRepoOnboarding.ts register <repoId>
 *
 * register 会：空目录时做最小 Git 初始化 → readiness proposal → canonical apply。
 */
export function runConsoleRepoOnboarding(argv: string[], out: (line: string) => void = console.log): number {
  const [action, repoId, ...extra] = argv;
  if (action !== "register" || repoId === undefined || extra.length > 0) {
    out("用法错误：console repo onboarding register <repoId>");
    return 1;
  }

  try {
    assertValidId(repoId, "repoId");
  } catch (error) {
    out(`用法错误：${errorText(error)}`);
    return 1;
  }

  const layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);
  try {
    initializeEmptyRepoIfNeeded(layout, repoId, db, out);

    const proposal = inspectRepoOnboarding(layout, repoId);
    if (proposal.alreadyRegistered) {
      out(`仓库 ${repoId} 已注册；拒绝重复注册。`);
      return 1;
    }
    if (!proposal.readyToRegister) {
      out(`仓库 ${repoId} readiness not ready：${proposal.blockingReasons.join(" ")}`);
      return 1;
    }

    const audit = beginAllowedAudit(db, "grande_repo_add_apply", { repoId, source: "grande-console" });
    try {
      // applyRepoOnboarding 内部再次检查真实 path 与 canonical Git readiness；
      // 不允许 Console 自己写 repos.yaml/profiles.yaml。
      applyRepoOnboarding(layout, proposal);
      if (!audit.succeeded(registrationTouched(layout, proposal))) {
        throw new Error("grande_repo_add_apply audit 无法落 SUCCEEDED。 ");
      }
      out(`仓库 ${repoId} 已注册到 GrandeGPT canonical registry。`);
      return 0;
    } catch (error) {
      audit.failed(errorText(error));
      throw error;
    }
  } catch (error) {
    out(errorText(error));
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runConsoleRepoOnboarding(process.argv.slice(2));
}
