import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";

function syncCli(argv: string[]): { code: number; text: string } {
  const lines: string[] = [];
  const result = runCli(argv, (line) => lines.push(line));
  if (typeof result !== "number") throw new Error("gateway 命令应同步返回退出码");
  return { code: result, text: lines.join("\n") };
}

describe("grande gateway", () => {
  it("缺少或给错 action 时列出完整的最小运维动作，包括 Human restore-state", () => {
    for (const argv of [["gateway"], ["gateway", "bogus"]]) {
      const result = syncCli(argv);
      expect(result.code).toBe(1);
      expect(result.text).toContain("gateway install");
      expect(result.text).toContain("gateway start");
      expect(result.text).toContain("gateway stop");
      expect(result.text).toContain("gateway restart");
      expect(result.text).toContain("gateway status");
      expect(result.text).toContain("gateway uninstall");
      expect(result.text).toContain("gateway restore-state");
    }
  });

  it("status 进入 LaunchAgent 管理路径，而不是落回未知命令", () => {
    const result = syncCli(["gateway", "status"]);
    expect(result.text).not.toContain("未知命令：gateway");
    expect(result.text).toContain("Gateway LaunchAgent");
  });
});
