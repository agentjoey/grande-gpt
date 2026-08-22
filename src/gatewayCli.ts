import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectStateDbBackup, restoreStateDbBackup } from "./controlBackup.ts";
import { ensureLayout, loadLayout } from "./layout.ts";
import {
  installGatewayLaunchAgent,
  manageGatewayLaunchAgent,
  type GatewayLaunchdManageAction,
} from "./launchd.ts";

const ACTIONS = ["install", "start", "stop", "restart", "status", "uninstall"] as const;
type GatewayAction = typeof ACTIONS[number];

const ACTION_SET = new Set<string>(ACTIONS);

function printUsage(out: (line: string) => void): void {
  out("用法：");
  out("  grande gateway install    安装/更新 LaunchAgent 并启动");
  out("  grande gateway start      启动已安装的 LaunchAgent");
  out("  grande gateway stop       停止 LaunchAgent（不会被 KeepAlive 拉起）");
  out("  grande gateway restart    重启 LaunchAgent");
  out("  grande gateway status     查看 LaunchAgent 是否已加载/运行");
  out("  grande gateway uninstall  停止并删除 LaunchAgent plist");
  out("  grande gateway restore-state <backup> [--yes]  验证/恢复受管 state DB backup（默认 dry-run）");
}

function identity(out: (line: string) => void): { uid: number; homeDir: string } | null {
  if (process.platform !== "darwin") {
    out("grande gateway 仅支持 macOS launchd。");
    return null;
  }
  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    out("当前 Node 运行时无法取得用户 uid，不能管理用户级 LaunchAgent。");
    return null;
  }
  return { uid: getuid(), homeDir: homedir() };
}

function isGatewayAction(value: string): value is GatewayAction {
  return ACTION_SET.has(value);
}

function runRestoreState(args: string[], out: (line: string) => void): number {
  const [backupPath, ...flags] = args;
  if (backupPath === undefined || flags.some((flag) => flag !== "--yes")) {
    out("用法错误：grande gateway restore-state <managed-backup-path> [--yes]");
    return 1;
  }

  let layout;
  try {
    layout = loadLayout();
    ensureLayout(layout);
    const inspected = inspectStateDbBackup(layout, backupPath);
    out(`backup=${inspected.path}`);
    out(`user_version=${inspected.schemaVersion}`);
    out(`integrity_check=${inspected.integrityCheck}`);

    if (!flags.includes("--yes")) {
      out("dry-run：backup 已验证；未修改 state DB。确认 Gateway/相关进程已停止后加 --yes 恢复。");
      return 0;
    }

    const restored = restoreStateDbBackup(layout, inspected.path);
    out(`已恢复：${restored.stateDb}`);
    out(`source=${restored.backupPath}`);
    out(`user_version=${restored.schemaVersion}`);
    return 0;
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export function runGatewayCli(args: string[], out: (line: string) => void): number {
  if (args[0] === "restore-state") {
    return runRestoreState(args.slice(1), out);
  }

  if (args.length !== 1 || !isGatewayAction(args[0] ?? "")) {
    if (args.length > 0) out(`未知 gateway action：${args.join(" ")}`);
    printUsage(out);
    return 1;
  }

  const action = args[0];
  const id = identity(out);
  if (!id) return 1;

  if (action !== "install") {
    const result = manageGatewayLaunchAgent(action as GatewayLaunchdManageAction, id);
    for (const line of result.lines) out(line);
    return result.code;
  }

  const issuer = process.env.GRANDE_ISSUER;
  if (!issuer) {
    out("GRANDE_ISSUER 未设置。install 时需要把 production issuer 固化进 LaunchAgent。");
    out("例如：GRANDE_ISSUER=https://grande.agentjoey.ai grande gateway install");
    return 1;
  }

  let layout;
  try {
    layout = loadLayout();
    ensureLayout(layout);
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const repoPath = join(layout.workspaceRoot, "grande-gpt");
  const mainPath = join(repoPath, "src", "main.ts");
  if (!existsSync(mainPath)) {
    out(`canonical grande-gpt Gateway 入口不存在：${mainPath}`);
    return 1;
  }

  const repoRoot = realpathSync(repoPath);
  const nodePath = realpathSync(process.execPath);
  const result = installGatewayLaunchAgent({
    ...id,
    workspaceRoot: layout.workspaceRoot,
    controlRoot: layout.controlRoot,
    issuer,
    nodePath,
    repoRoot,
    pathEnv: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  });
  for (const line of result.lines) out(line);
  return result.code;
}
