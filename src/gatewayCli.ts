import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectStateDbBackup, restoreStateDbBackup } from "./controlBackup.ts";
import { openDb } from "./db.ts";
import { runProductionGatewayActivation } from "./gatewayActivation.ts";
import { ensureLayout, loadLayout } from "./layout.ts";
import {
  installGatewayLaunchAgent,
  manageGatewayLaunchAgent,
  type GatewayLaunchdManageAction,
} from "./launchd.ts";
import { selfCheck } from "./selfcheck.ts";
import { buildTools } from "./tools.ts";
import { gatewayBuildIdentity, toolsetIdentity, type ToolsetIdentity } from "./toolsetIdentity.ts";

const ACTIONS = ["install", "start", "stop", "restart", "status", "uninstall"] as const;
type GatewayAction = typeof ACTIONS[number];

const ACTION_SET = new Set<string>(ACTIONS);

export interface GatewayCliOptions {
  /** Test seam; production resolves the current macOS user identity. */
  resolveIdentity?: (out: (line: string) => void) => { uid: number; homeDir: string } | null;
  /** Test seam; production always uses the launchd implementation. */
  manageLaunchAgent?: typeof manageGatewayLaunchAgent;
  /** Test seam; production always performs the real trusted HTTP selfCheck. */
  readProbe?: typeof selfCheck;
  /** Test seam only. Production derives this from canonical HEAD + local public tool contract. */
  targetIdentity?: ToolsetIdentity;
}

function printUsage(out: (line: string) => void): void {
  out("用法：");
  out("  grande gateway install    安装/更新 LaunchAgent 并启动");
  out("  grande gateway start      启动已安装的 LaunchAgent");
  out("  grande gateway stop       停止 LaunchAgent（不会被 KeepAlive 拉起）");
  out("  grande gateway restart    重启 LaunchAgent，验证 runtime identity 并记录 production activation receipt");
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

async function runRestartActivation(
  id: { uid: number; homeDir: string },
  out: (line: string) => void,
  options: GatewayCliOptions,
): Promise<number> {
  const issuer = process.env.GRANDE_ISSUER;
  if (!issuer) {
    out("GRANDE_ISSUER 未设置。restart activation 需要用 production issuer 执行 trusted read probe。");
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

  const db = openDb(layout);
  try {
    let target = options.targetIdentity;
    if (!target) {
      const repoPath = realpathSync(join(layout.workspaceRoot, "grande-gpt"));
      const targetBuild = gatewayBuildIdentity(process.env, repoPath);
      target = toolsetIdentity(buildTools({ db, layout }), targetBuild);
    }

    const manage = options.manageLaunchAgent ?? manageGatewayLaunchAgent;
    const probe = options.readProbe ?? selfCheck;
    const result = await runProductionGatewayActivation(db, target, {
      restart: () => manage("restart", id),
      status: () => manage("status", id),
      readProbe: () => probe({
        issuer,
        db,
        keyPath: join(layout.controlRoot, "secrets", "oauth-key"),
        baseUrl: "http://127.0.0.1:8787",
      }),
    });
    for (const line of result.lines) out(line);
    return result.code;
  } catch (error) {
    out(`Production activation 未完成：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

export function runGatewayCli(
  args: string[],
  out: (line: string) => void,
  options: GatewayCliOptions = {},
): number | Promise<number> {
  if (args[0] === "restore-state") {
    return runRestoreState(args.slice(1), out);
  }

  if (args.length !== 1 || !isGatewayAction(args[0] ?? "")) {
    if (args.length > 0) out(`未知 gateway action：${args.join(" ")}`);
    printUsage(out);
    return 1;
  }

  const action = args[0];
  const resolveIdentity = options.resolveIdentity ?? identity;
  const id = resolveIdentity(out);
  if (!id) return 1;

  if (action === "restart") {
    return runRestartActivation(id, out, options);
  }

  if (action !== "install") {
    const manage = options.manageLaunchAgent ?? manageGatewayLaunchAgent;
    const result = manage(action as GatewayLaunchdManageAction, id);
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
