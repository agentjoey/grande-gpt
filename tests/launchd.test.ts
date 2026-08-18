import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type InstallConfig = {
  uid: number;
  homeDir: string;
  workspaceRoot: string;
  controlRoot: string;
  issuer: string;
  nodePath: string;
  repoRoot: string;
  pathEnv: string;
};

type LaunchctlResult = { status: number; stdout: string; stderr: string };
type LaunchctlExec = (args: string[]) => LaunchctlResult;
type CommandResult = { code: number; lines: string[] };
type LaunchdModule = {
  GATEWAY_LAUNCHD_LABEL: string;
  renderGatewayLaunchAgentPlist(config: InstallConfig): string;
  installGatewayLaunchAgent(config: InstallConfig, exec: LaunchctlExec): CommandResult;
  manageGatewayLaunchAgent(
    action: "start" | "stop" | "restart" | "status" | "uninstall",
    identity: { uid: number; homeDir: string },
    exec: LaunchctlExec,
  ): CommandResult;
};

const roots: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function makeConfig(): InstallConfig {
  const homeDir = temp("grande-home-");
  const workspaceRoot = temp("grande-ws-");
  const controlRoot = temp("grande-ctrl-");
  const repoRoot = join(workspaceRoot, "grande-gpt");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "main.ts"), "// fixture\n");
  return {
    uid: 501,
    homeDir,
    workspaceRoot,
    controlRoot,
    issuer: "https://grande.example.test/?a=1&b=<prod>",
    nodePath: "/opt/node/bin/node",
    repoRoot,
    pathEnv: "/opt/node/bin:/usr/bin:/bin&tools",
  };
}

async function loadLaunchd(): Promise<LaunchdModule | null> {
  const modulePath = `../src/${"launchd"}.ts`;
  try {
    return await import(modulePath) as unknown as LaunchdModule;
  } catch {
    return null;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Gateway LaunchAgent plist", () => {
  it("固定现有 production 启动方式、必要环境变量、KeepAlive/RunAtLoad 与控制平面日志", async () => {
    const launchd = await loadLaunchd();
    expect(launchd, "src/launchd.ts 尚未实现").not.toBeNull();
    if (!launchd) return;

    const c = makeConfig();
    const xml = launchd.renderGatewayLaunchAgentPlist(c);

    expect(xml).toContain(`<string>${launchd.GATEWAY_LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>/opt/node/bin/node</string>");
    expect(xml).toContain(`<string>${join(c.repoRoot, "src", "main.ts")}</string>`);
    expect(xml).toContain(`<string>${c.repoRoot}</string>`);
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>GRANDE_WORKSPACE</key>");
    expect(xml).toContain(`<string>${c.workspaceRoot}</string>`);
    expect(xml).toContain("<key>GRANDE_CONTROL</key>");
    expect(xml).toContain(`<string>${c.controlRoot}</string>`);
    expect(xml).toContain("<key>GRANDE_ISSUER</key>");
    expect(xml).toContain("https://grande.example.test/?a=1&amp;b=&lt;prod&gt;");
    expect(xml).toContain("/opt/node/bin:/usr/bin:/bin&amp;tools");
    expect(xml).toContain(`<string>${join(c.controlRoot, "logs", "gateway.stdout.log")}</string>`);
    expect(xml).toContain(`<string>${join(c.controlRoot, "logs", "gateway.stderr.log")}</string>`);
  });
});

describe("Gateway LaunchAgent lifecycle", () => {
  it("install 落盘 plist，忽略旧 service 不存在的 bootout，并用 gui/<uid> bootstrap", async () => {
    const launchd = await loadLaunchd();
    expect(launchd, "src/launchd.ts 尚未实现").not.toBeNull();
    if (!launchd) return;

    const c = makeConfig();
    const calls: string[][] = [];
    const exec: LaunchctlExec = (args) => {
      calls.push(args);
      if (args[0] === "bootout") return { status: 3, stdout: "", stderr: "not loaded" };
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = launchd.installGatewayLaunchAgent(c, exec);
    const plistPath = join(c.homeDir, "Library", "LaunchAgents", `${launchd.GATEWAY_LAUNCHD_LABEL}.plist`);

    expect(result.code).toBe(0);
    expect(existsSync(plistPath)).toBe(true);
    expect(readFileSync(plistPath, "utf8")).toContain(launchd.GATEWAY_LAUNCHD_LABEL);
    expect(calls).toEqual([
      ["bootout", `gui/${c.uid}/${launchd.GATEWAY_LAUNCHD_LABEL}`],
      ["bootstrap", `gui/${c.uid}`, plistPath],
    ]);
  });

  it("start/status/restart/stop/uninstall 只通过 launchctl argv 管理用户级 service", async () => {
    const launchd = await loadLaunchd();
    expect(launchd, "src/launchd.ts 尚未实现").not.toBeNull();
    if (!launchd) return;

    const c = makeConfig();
    const identity = { uid: c.uid, homeDir: c.homeDir };
    const plistPath = join(c.homeDir, "Library", "LaunchAgents", `${launchd.GATEWAY_LAUNCHD_LABEL}.plist`);
    mkdirSync(join(c.homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath, "fixture");

    const startCalls: string[][] = [];
    const startExec: LaunchctlExec = (args) => {
      startCalls.push(args);
      return args[0] === "print"
        ? { status: 3, stdout: "", stderr: "not loaded" }
        : { status: 0, stdout: "", stderr: "" };
    };
    expect(launchd.manageGatewayLaunchAgent("start", identity, startExec).code).toBe(0);
    expect(startCalls).toEqual([
      ["print", `gui/${c.uid}/${launchd.GATEWAY_LAUNCHD_LABEL}`],
      ["bootstrap", `gui/${c.uid}`, plistPath],
    ]);

    const loadedCalls: string[][] = [];
    const loadedExec: LaunchctlExec = (args) => {
      loadedCalls.push(args);
      if (args[0] === "print") return { status: 0, stdout: "state = running\npid = 123\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const status = launchd.manageGatewayLaunchAgent("status", identity, loadedExec);
    expect(status.code).toBe(0);
    expect(status.lines.join("\n")).toContain("state=running");

    loadedCalls.length = 0;
    expect(launchd.manageGatewayLaunchAgent("restart", identity, loadedExec).code).toBe(0);
    expect(loadedCalls).toEqual([
      ["print", `gui/${c.uid}/${launchd.GATEWAY_LAUNCHD_LABEL}`],
      ["bootout", `gui/${c.uid}/${launchd.GATEWAY_LAUNCHD_LABEL}`],
      ["bootstrap", `gui/${c.uid}`, plistPath],
    ]);

    const stoppedCalls: string[][] = [];
    const stoppedExec: LaunchctlExec = (args) => {
      stoppedCalls.push(args);
      return { status: 3, stdout: "", stderr: "not loaded" };
    };
    expect(launchd.manageGatewayLaunchAgent("stop", identity, stoppedExec).code).toBe(0);
    expect(stoppedCalls).toEqual([["print", `gui/${c.uid}/${launchd.GATEWAY_LAUNCHD_LABEL}`]]);

    loadedCalls.length = 0;
    expect(launchd.manageGatewayLaunchAgent("uninstall", identity, loadedExec).code).toBe(0);
    expect(loadedCalls).toEqual([
      ["print", `gui/${c.uid}/${launchd.GATEWAY_LAUNCHD_LABEL}`],
      ["bootout", `gui/${c.uid}/${launchd.GATEWAY_LAUNCHD_LABEL}`],
    ]);
    expect(existsSync(plistPath)).toBe(false);
  });
});
