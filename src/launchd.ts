import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const GATEWAY_LAUNCHD_LABEL = "ai.agentjoey.grande-gateway";

export interface GatewayLaunchdIdentity {
  uid: number;
  homeDir: string;
}

export interface GatewayLaunchdInstallConfig extends GatewayLaunchdIdentity {
  workspaceRoot: string;
  controlRoot: string;
  issuer: string;
  nodePath: string;
  repoRoot: string;
  pathEnv: string;
}

export interface LaunchctlResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type LaunchctlExec = (args: string[]) => LaunchctlResult;
export type GatewayReadinessProbe = () => boolean;

export interface GatewayLaunchdCommandResult {
  code: number;
  lines: string[];
}

export type GatewayLaunchdManageAction = "start" | "stop" | "restart" | "status" | "uninstall";

const BOOTSTRAP_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_DELAY_MS = 100;
const READINESS_ATTEMPTS = 5;
const READINESS_RETRY_DELAY_MS = 200;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchAgentPath(identity: GatewayLaunchdIdentity): string {
  return join(identity.homeDir, "Library", "LaunchAgents", `${GATEWAY_LAUNCHD_LABEL}.plist`);
}

function serviceTarget(identity: GatewayLaunchdIdentity): string {
  return `gui/${identity.uid}/${GATEWAY_LAUNCHD_LABEL}`;
}

function domainTarget(identity: GatewayLaunchdIdentity): string {
  return `gui/${identity.uid}`;
}

function logPaths(controlRoot: string): { stdout: string; stderr: string } {
  const dir = join(controlRoot, "logs");
  return {
    stdout: join(dir, "gateway.stdout.log"),
    stderr: join(dir, "gateway.stderr.log"),
  };
}

export function renderGatewayLaunchAgentPlist(config: GatewayLaunchdInstallConfig): string {
  const logs = logPaths(config.controlRoot);
  const mainPath = join(config.repoRoot, "src", "main.ts");
  const env = [
    ["GRANDE_WORKSPACE", config.workspaceRoot],
    ["GRANDE_CONTROL", config.controlRoot],
    ["GRANDE_ISSUER", config.issuer],
    ["GRANDE_HOST", "127.0.0.1"],
    ["PORT", "8787"],
    ["PATH", config.pathEnv],
  ] as const;
  const envXml = env
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(GATEWAY_LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(config.nodePath)}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${escapeXml(mainPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(config.repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logs.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logs.stderr)}</string>
</dict>
</plist>
`;
}

export const execLaunchctl: LaunchctlExec = (args) => {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) {
    return { status: 1, stdout: result.stdout ?? "", stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

function commandFailed(action: string, result: LaunchctlResult): GatewayLaunchdCommandResult {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
  return { code: 1, lines: [`launchctl ${action} 失败：${detail}`] };
}

function loaded(identity: GatewayLaunchdIdentity, exec: LaunchctlExec): LaunchctlResult {
  return exec(["print", serviceTarget(identity)]);
}

function pause(ms: number): void {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(state, 0, 0, ms);
}

function bootstrap(
  identity: GatewayLaunchdIdentity,
  exec: LaunchctlExec,
): GatewayLaunchdCommandResult {
  const plistPath = launchAgentPath(identity);
  let result: LaunchctlResult | undefined;
  for (let attempt = 0; attempt < BOOTSTRAP_ATTEMPTS; attempt += 1) {
    result = exec(["bootstrap", domainTarget(identity), plistPath]);
    if (result.status === 0) {
      return { code: 0, lines: [`Gateway LaunchAgent 已启动：${serviceTarget(identity)}`] };
    }
    if (result.status !== 5 || attempt + 1 >= BOOTSTRAP_ATTEMPTS) break;
    pause(BOOTSTRAP_RETRY_DELAY_MS);
  }
  const failed = commandFailed("bootstrap", result!);
  if (result!.status !== 5) return failed;
  return {
    code: 1,
    lines: [
      ...failed.lines,
      `launchctl bootstrap error 5 已重试 ${BOOTSTRAP_ATTEMPTS} 次，Gateway 仍未成功加载。`,
      "请运行 grande gateway status；若仍未加载，再运行 grande gateway start。",
    ],
  };
}

function gatewayEndpointReady(): boolean {
  const result = spawnSync("/usr/bin/curl", [
    "--fail",
    "--silent",
    "--max-time",
    "1",
    "http://127.0.0.1:8787/.well-known/oauth-authorization-server",
  ], { encoding: "utf8" });
  return result.status === 0;
}

function awaitGatewayReadiness(probe: GatewayReadinessProbe): boolean {
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
    if (probe()) return true;
    if (attempt + 1 < READINESS_ATTEMPTS) pause(READINESS_RETRY_DELAY_MS);
  }
  return false;
}

export function installGatewayLaunchAgent(
  config: GatewayLaunchdInstallConfig,
  exec: LaunchctlExec = execLaunchctl,
): GatewayLaunchdCommandResult {
  const mainPath = join(config.repoRoot, "src", "main.ts");
  if (!existsSync(mainPath)) {
    return { code: 1, lines: [`Gateway 入口不存在：${mainPath}`] };
  }
  if (!config.issuer) {
    return { code: 1, lines: ["GRANDE_ISSUER 未设置，无法生成 production LaunchAgent。"] };
  }

  const plistPath = launchAgentPath(config);
  mkdirSync(join(config.homeDir, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(config.controlRoot, "logs"), { recursive: true });

  const tempPath = `${plistPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, renderGatewayLaunchAgentPlist(config), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, plistPath);
  } finally {
    rmSync(tempPath, { force: true });
  }

  // install 是幂等替换：旧 service 不存在时 bootout 的非零退出码可以忽略。
  exec(["bootout", serviceTarget(config)]);
  const started = bootstrap(config, exec);
  if (started.code !== 0) return started;
  return {
    code: 0,
    lines: [
      `Gateway LaunchAgent 已安装：${plistPath}`,
      `Gateway LaunchAgent 已启动：${serviceTarget(config)}`,
    ],
  };
}

export function manageGatewayLaunchAgent(
  action: GatewayLaunchdManageAction,
  identity: GatewayLaunchdIdentity,
  exec: LaunchctlExec = execLaunchctl,
  readinessProbe: GatewayReadinessProbe = gatewayEndpointReady,
): GatewayLaunchdCommandResult {
  const plistPath = launchAgentPath(identity);
  const target = serviceTarget(identity);
  const current = loaded(identity, exec);
  const isLoaded = current.status === 0;

  if (action === "status") {
    if (!isLoaded) {
      return { code: 1, lines: [`Gateway LaunchAgent 未加载：${target}`, `plist: ${plistPath}`] };
    }
    const state = /^\s*state\s*=\s*(\S+)/m.exec(current.stdout)?.[1] ?? "loaded";
    return { code: 0, lines: [`Gateway LaunchAgent 已加载：${target} state=${state}`, `plist: ${plistPath}`] };
  }

  if (action === "stop") {
    if (!isLoaded) return { code: 0, lines: [`Gateway LaunchAgent 已停止：${target}`] };
    const result = exec(["bootout", target]);
    if (result.status !== 0) return commandFailed("bootout", result);
    return { code: 0, lines: [`Gateway LaunchAgent 已停止：${target}`] };
  }

  if (action === "uninstall") {
    if (isLoaded) {
      const result = exec(["bootout", target]);
      if (result.status !== 0) return commandFailed("bootout", result);
    }
    rmSync(plistPath, { force: true });
    return { code: 0, lines: [`Gateway LaunchAgent 已卸载：${plistPath}`] };
  }

  if (!existsSync(plistPath)) {
    return { code: 1, lines: [`LaunchAgent 尚未安装：${plistPath}`, "请先运行 grande gateway install。"] };
  }

  if (action === "start") {
    if (isLoaded) {
      const result = exec(["kickstart", "-k", target]);
      if (result.status !== 0) return commandFailed("kickstart", result);
      return { code: 0, lines: [`Gateway LaunchAgent 已启动：${target}`] };
    }
    return bootstrap(identity, exec);
  }

  if (isLoaded) {
    const restarted = exec(["kickstart", "-k", target]);
    if (restarted.status !== 0) return commandFailed("kickstart", restarted);
  } else {
    const started = bootstrap(identity, exec);
    if (started.code !== 0) return started;
  }

  if (!awaitGatewayReadiness(readinessProbe)) {
    return { code: 1, lines: [`Gateway endpoint 在 LaunchAgent restart 后未就绪：${target}`] };
  }
  return { code: 0, lines: [`Gateway LaunchAgent 已重启并就绪：${target}`] };
}
