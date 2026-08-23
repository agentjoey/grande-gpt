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
import { listAudit } from "../src/audit.ts";
import { runConsoleRepoOnboarding } from "../src/consoleRepoOnboarding.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { loadRegistry } from "../src/registry.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;
let lines: string[];
const out = (line: string): void => void lines.push(line);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function run(repoId: string): number {
  return runConsoleRepoOnboarding(["register", repoId], out);
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-q", "-m", "init");
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "console-onboard-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "console-onboard-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  lines = [];
  ensureLayout(loadLayout());
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("console-safe repo onboarding helper", () => {
  it("空 direct-child 目录一键完成最小 Git 初始化并注册", () => {
    const repo = join(ws, "empty-project");
    mkdirSync(repo);

    expect(run("empty-project")).toBe(0);
    expect(loadRegistry(loadLayout()).get("empty-project")?.registered).toBe(true);
    expect(lines.join("\n")).toContain("已完成最小 Git 初始化");
    expect(lines.join("\n")).toContain("已注册");

    const db = openDb(loadLayout());
    try {
      const rows = listAudit(db);
      const init = rows.find((item) => item.tool === "grande_repo_init");
      const apply = rows.find((item) => item.tool === "grande_repo_add_apply");
      expect(init).toMatchObject({ decision: "ALLOWED", state: "SUCCEEDED" });
      expect(init?.pathsTouched).toHaveLength(1);
      expect(apply).toMatchObject({ decision: "ALLOWED", state: "SUCCEEDED" });
      expect(apply?.pathsTouched.some((path) => path.endsWith("repos.yaml"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("非空且不是有效 Git repo 时 fail closed，既有内容不动", () => {
    const repo = join(ws, "not-ready");
    mkdirSync(repo);
    const marker = join(repo, "README.md");
    writeFileSync(marker, "keep me\n", "utf8");

    expect(run("not-ready")).toBe(1);
    expect(readFileSync(marker, "utf8")).toBe("keep me\n");
    expect(existsSync(join(repo, ".git"))).toBe(false);
    expect(loadRegistry(loadLayout()).has("not-ready")).toBe(false);
    expect(lines.join("\n")).toMatch(/not ready|valid Git repository|readiness/i);
  });

  it("path security 拒绝 symlink candidate，真实目录不被初始化", () => {
    const real = join(ws, "real-empty");
    mkdirSync(real);
    symlinkSync("real-empty", join(ws, "link-empty"), "dir");

    expect(run("link-empty")).toBe(1);
    expect(existsSync(join(real, ".git"))).toBe(false);
    expect(loadRegistry(loadLayout()).has("link-empty")).toBe(false);
    expect(lines.join("\n")).toMatch(/PATH_ESCAPE|不是工作区下的真实目录|符号链接/);
  });

  it("普通 ready Git repo 不做初始化，只走 canonical registration + audit", () => {
    const repo = join(ws, "fresh");
    initRepo(repo);

    expect(run("fresh")).toBe(0);
    expect(loadRegistry(loadLayout()).get("fresh")?.registered).toBe(true);
    expect(lines.join("\n")).not.toContain("已完成最小 Git 初始化");

    const db = openDb(loadLayout());
    try {
      const rows = listAudit(db);
      expect(rows.some((item) => item.tool === "grande_repo_init")).toBe(false);
      const apply = rows.find((item) => item.tool === "grande_repo_add_apply");
      expect(apply?.decision).toBe("ALLOWED");
      expect(apply?.state).toBe("SUCCEEDED");
    } finally {
      db.close();
    }
  });
});
