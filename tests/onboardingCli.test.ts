import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { loadProfiles } from "../src/profiles.ts";
import { loadRegistry, registeredIds } from "../src/registry.ts";
import { openWorktree } from "../src/worktree.ts";

let ws: string;
let ctrl: string;
let lines: string[];
let savedWs: string | undefined;
let savedCtrl: string | undefined;
const out = (line: string): void => void lines.push(line);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function syncCli(argv: string[]): number {
  const result = runCli(argv, out);
  if (typeof result !== "number") throw new Error("onboarding CLI 应保持同步");
  return result;
}

function initRepo(repo: string, withCommit = true): void {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run", build: "vite build" } }),
    "utf8",
  );
  if (withCommit) {
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
  }
}

function controlSnapshot(): { repos: string | null; profiles: string | null } {
  const layout = loadLayout();
  return {
    repos: existsSync(layout.reposConfig) ? readFileSync(layout.reposConfig, "utf8") : null,
    profiles: existsSync(join(layout.configDir, "profiles.yaml"))
      ? readFileSync(join(layout.configDir, "profiles.yaml"), "utf8")
      : null,
  };
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
  initRepo(join(ws, "fresh"));
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("grande repo add", () => {
  it("正常 Git repo + main + HEAD 的 proposal 显示 development lifecycle ready", () => {
    expect(syncCli(["repo", "add", "fresh"])).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("Git repository");
    expect(text).toContain("HEAD");
    expect(text).toContain("Branch");
    expect(text).toContain("main");
    expect(text).toContain("Worktree lifecycle");
    expect(text).toContain("Ready to register: YES");
  });

  it("默认只展示 onboarding proposal，不产生 repo registration/profile 授权", () => {
    const before = controlSnapshot();
    expect(syncCli(["repo", "add", "fresh"])).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("fresh");
    expect(text).toContain("pnpm");
    expect(text).toContain("test");
    expect(text).toContain("--apply");
    expect(loadRegistry(loadLayout()).has("fresh")).toBe(false);
    expect(loadProfiles(loadLayout(), "fresh").size).toBe(0);
    expect(controlSnapshot()).toEqual(before);
  });

  it("empty Git repo 没有 HEAD：proposal 明确 blocker，--apply fail closed 且 control plane 不变", () => {
    rmSync(join(ws, "fresh"), { recursive: true, force: true });
    initRepo(join(ws, "fresh"), false);

    expect(syncCli(["repo", "add", "fresh"])).toBe(0);
    const proposalText = lines.join("\n");
    expect(proposalText).toContain("no baseline commit");
    expect(proposalText).toContain("Ready to register: NO");

    lines = [];
    const before = controlSnapshot();
    expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(1);
    expect(controlSnapshot()).toEqual(before);
    expect(loadRegistry(loadLayout()).has("fresh")).toBe(false);
  });

  it("detached HEAD 是 blocker，--apply fail closed", () => {
    const repo = join(ws, "fresh");
    const sha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", sha);

    const before = controlSnapshot();
    expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(1);
    expect(lines.join("\n")).toContain("detached");
    expect(controlSnapshot()).toEqual(before);
  });

  it.each(["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "index.lock"])(
    "canonical busy marker %s 是 blocker，--apply fail closed",
    (marker) => {
      const path = join(ws, "fresh", ".git", marker);
      if (marker.startsWith("rebase-")) mkdirSync(path, { recursive: true });
      else writeFileSync(path, "busy\n", "utf8");

      const before = controlSnapshot();
      expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(1);
      expect(lines.join("\n")).toContain(marker);
      expect(controlSnapshot()).toEqual(before);
    },
  );

  it("symlink candidate 继续由既有 path security fail closed", () => {
    rmSync(join(ws, "fresh"), { recursive: true, force: true });
    initRepo(join(ws, "real-sibling"));
    symlinkSync("real-sibling", join(ws, "fresh"), "dir");

    expect(syncCli(["repo", "add", "fresh"])).toBe(1);
    expect(lines.join("\n")).toMatch(/PATH_ESCAPE|不是工作区下的真实目录|符号链接/);
  });

  it("只有显式 --apply 才由 Human Owner 把 ready proposal 写进 control plane", () => {
    expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(0);
    expect(loadRegistry(loadLayout()).get("fresh")?.registered).toBe(true);
    expect(loadProfiles(loadLayout(), "fresh").get("test")?.argv).toEqual(["pnpm", "run", "test"]);
    expect(lines.join("\n")).toContain("已写入可信控制平面");
  });

  it("apply 后 registeredIds 包含 repo，且 openWorktree 能立即进入 task lifecycle", () => {
    const layout = loadLayout();
    expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(0);
    expect(registeredIds(layout).has("fresh")).toBe(true);

    const info = openWorktree(layout, "fresh", "onboarded", "task_onboarded");
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(info.baseCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("已注册 repo 重复 apply 保持 idempotent，不覆盖已有 trusted profile", () => {
    const layout = loadLayout();
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      [
        "repos:",
        "  fresh:",
        "    test:",
        "      argv: [pnpm, run, unit-selfhost]",
        "      timeoutSeconds: 321",
        "",
      ].join("\n"),
      "utf8",
    );

    expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(0);
    lines = [];
    expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(0);

    const profiles = loadProfiles(layout, "fresh");
    expect(profiles.get("test")?.argv).toEqual(["pnpm", "run", "unit-selfhost"]);
    expect(profiles.get("test")?.timeoutSeconds).toBe(321);
    expect(profiles.get("build")?.argv).toEqual(["pnpm", "run", "build"]);
  });

  it("profiles config validation failure 发生在 registry mutation 之前", () => {
    const layout = loadLayout();
    writeFileSync(join(layout.configDir, "profiles.yaml"), "repos: []\n", "utf8");
    const before = controlSnapshot();

    expect(syncCli(["repo", "add", "fresh", "--apply"])).toBe(1);
    expect(controlSnapshot()).toEqual(before);
    expect(loadRegistry(layout).has("fresh")).toBe(false);
  });
});
