import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;
let savedIssuer: string | undefined;
let lines: string[];
const out = (line: string): void => void lines.push(line);

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  savedIssuer = process.env.GRANDE_ISSUER;
  ws = mkdtempSync(join(tmpdir(), "ready-cli-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "ready-cli-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  delete process.env.GRANDE_ISSUER;
  lines = [];

  const layout = loadLayout();
  ensureLayout(layout);
  const repo = join(ws, "demo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  saveRegistry(layout, [{ repoId: "demo", path: repo, registered: true }]);
  writeFileSync(join(layout.configDir, "profiles.yaml"), [
    "repos:",
    "  demo:",
    "    test: { argv: [pnpm, test], timeoutSeconds: 60 }",
    "",
  ].join("\n"), "utf8");
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  if (savedIssuer === undefined) delete process.env.GRANDE_ISSUER; else process.env.GRANDE_ISSUER = savedIssuer;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("grande doctor --repo", () => {
  it("输出 Development / PR-CI / Deploy / Gateway readiness；缺配置时明确红灯而不是要求翻日志", async () => {
    const result = runCli(["doctor", "--repo", "demo"], out);
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(1);

    const text = lines.join("\n");
    expect(text).toContain("Development");
    expect(text).toContain("PR/CI");
    expect(text).toContain("Deploy");
    expect(text).toContain("Gateway");
    expect(text).toContain("GitHub credential/access");
    expect(text).toContain("未配置");
    expect(text).toContain("GRANDE_ISSUER");
  });

  it("--repo 悬空时是用法错误，不进入普通 doctor", () => {
    const result = runCli(["doctor", "--repo"], out);
    expect(typeof result).toBe("number");
    expect(result).toBe(1);
    expect(lines.join("\n")).toContain("--repo");
  });
});
