import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { loadProfiles } from "../src/profiles.ts";
import { loadRegistry } from "../src/registry.ts";

let ws: string;
let ctrl: string;
let lines: string[];
let savedWs: string | undefined;
let savedCtrl: string | undefined;
const out = (line: string): void => void lines.push(line);

function syncCli(argv: string[]): number {
  const result = runCli(argv, out);
  if (typeof result !== "number") throw new Error("onboarding CLI 应保持同步");
  return result;
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "onboard-cli-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "onboard-cli-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  lines = [];
  ensureLayout(loadLayout());

  const repo = join(ws, "fresh");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run", build: "vite build" } }), "utf8");
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("grande repo add", () => {
  it("默认只展示 onboarding proposal，不产生 repo registration/profile 授权", () => {
    expect(syncCli(["repo", "add", "fresh"])).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("fresh");
    expect(text).toContain("pnpm");
    expect(text).toContain("test");
    expect(text).toContain("--apply");
    expect(loadRegistry(loadLayout()).has("fresh")).toBe(false);
    expect(loadProfiles(loadLayout(), "fresh").size).toBe(0);
  });

  it("只有显式 --apply 才由 Human Owner 把 proposal 写进 control plane", () => {
    expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(0);
    expect(loadRegistry(loadLayout()).get("fresh")?.registered).toBe(true);
    expect(loadProfiles(loadLayout(), "fresh").get("test")?.argv).toEqual(["pnpm", "run", "test"]);
    expect(lines.join("\n")).toContain("已写入可信控制平面");
  });
});
