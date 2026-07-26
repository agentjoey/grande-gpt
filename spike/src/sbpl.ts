import { isAbsolute } from "node:path";

export interface SandboxPaths {
  /** 当前任务 worktree —— 唯一可写的仓库路径 */
  worktree: string;
  /** canonical 仓库的 .git 目录。worktree 里的 .git 是个文件、指向这里，
   *  而 hooks 存放于此且为所有 worktree 共享——必须整体不可写 */
  canonicalGit: string;
  /** 本 job 的临时目录，同时用作 HOME 与 TMPDIR */
  jobTmp: string;
  /** 控制平面根（状态/配置/审计）——被审计者不能读 */
  controlRoot: string;
  /** 全部 worktree 的父目录——先整体拒读，再单独放行本任务的 */
  worktreesRoot: string;
}

/** SBPL 字符串字面量里只需转义反斜杠与双引号 */
function q(path: string): string {
  if (!isAbsolute(path)) throw new Error(`SBPL 的 subpath 必须是绝对路径，收到：${path}`);
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 生成本 job 的 SBPL 策略。
 *
 * 裁决语义（2026-07-25 于 macOS 26.5.1 实测）：**按最具体规则优先，不是按书写顺序**。
 * 因此 `deny (subpath worktreesRoot)` + `allow (subpath worktree)` 能实现
 * 「只见自己、不见他人」，且新建的 worktree 自动被父目录的 deny 覆盖，
 * 无需在每次 job 启动时枚举其他任务。
 *
 * 读权限整体放宽（除控制平面根与他人 worktree 外），因为 node/npm/tsc 会读大量
 * 意想不到的系统路径，逐目录白名单会陷入无穷调试；而全禁网意味着读到的东西出不去。
 */
export function buildProfile(p: SandboxPaths): string {
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "",
    ";; 读：整体放宽，再挖掉两块",
    "(allow file-read*)",
    `(deny file-read* (subpath "${q(p.controlRoot)}"))`,
    `(deny file-read* (subpath "${q(p.worktreesRoot)}"))`,
    `(allow file-read* (subpath "${q(p.worktree)}"))`,
    "",
    ";; 写：只有本任务 worktree 与本 job 临时目录",
    `(allow file-write* (subpath "${q(p.worktree)}"))`,
    `(allow file-write* (subpath "${q(p.jobTmp)}"))`,
    `(deny file-write* (subpath "${q(p.canonicalGit)}"))`,
    `(deny file-write* (subpath "${q(p.worktree)}/.git"))`,
    "",
    ";; 执行",
    '(allow process-exec (subpath "/usr/bin") (subpath "/bin") (subpath "/usr/sbin") (subpath "/opt/homebrew"))',
    "(allow process-fork)",
    "(allow sysctl-read)",
    "",
  ].join("\n");
}
