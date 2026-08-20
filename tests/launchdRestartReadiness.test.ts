import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type LaunchctlResult = { status: number; stdout: string; stderr: string };
type LaunchctlExec = (args: string[]) => LaunchctlResult;
type CommandResult = { code: number; lines: string[] };
type EndpointProbe = () => boolean;
type LaunchdModule = {
  GATEWAY_LAUNCHD_LABEL: string;
  manageGatewayLaunchAgent(
    action: "start" | "stop" | "restart" | "status" | "uninstall",
    identity: { uid: number; homeDir: string },
    exec: LaunchctlExec,
    endpointProbe?: EndpointProbe,
  ): CommandResult;
};

const roots: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function loadLaunchd(): Promise<LaunchdModule> {
  return await import("../src/launchd.ts") as unknown as LaunchdModule;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("S17-3-3 production restart readiness", () => {
  it("loaded restart 不能在 replacement endpoint 仍不可用时宣告成功", async () => {
    const launchd = await loadLaunchd();
    const homeDir = temp("grande-restart-ready-");
    const identity = { uid: 501, homeDir };
    const plistPath = join(homeDir, "Library", "LaunchAgents", `${launchd.GATEWAY_LAUNCHD_LABEL}.plist`);
    mkdirSync(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath, "fixture");

    const target = `gui/${identity.uid}/${launchd.GATEWAY_LAUNCHD_LABEL}`;
    const calls: string[][] = [];
    let probeCalls = 0;
    const exec: LaunchctlExec = (args) => {
      calls.push(args);
      if (args[0] === "print") {
        return { status: 0, stdout: "state = running\npid = 123\n", stderr: "" };
      }
      if (args[0] === "kickstart") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: `unexpected ${args[0]}` };
    };
    const endpointProbe: EndpointProbe = () => {
      probeCalls += 1;
      return false;
    };

    const result = launchd.manageGatewayLaunchAgent("restart", identity, exec, endpointProbe);

    expect(calls.slice(0, 2)).toEqual([
      ["print", target],
      ["kickstart", "-k", target],
    ]);
    expect(probeCalls).toBeGreaterThan(0);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("endpoint");
  });
});
