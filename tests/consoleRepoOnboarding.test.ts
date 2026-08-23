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
import { registerConsoleRepo } from "../src/consoleRepoOnboarding.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { loadRegistry } from "../src/registry.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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
  ensureLayout(loadLayout());
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("console-safe repo onboarding", () => {
  it("空 direct-child 目录完成最小 Git 初始化、canonical registration 与 audit", () => {
    const repo = join(ws, "empty-project");
    mkdirSync(repo);
    const layout = loadLayout();
    const db = openDb(layout);
    try {
      const result = registerConsoleRepo(db, layout, "empty-project");
      expect(result).toEqual({ repoId: "empty-project", initialized: true, registered: true });
      expect(git(repo, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
      expect(git(repo, "rev-parse", "--verify", "HEAD").trim().length).toBeGreaterThan(0);
      expect(loadRegistry(layout).get("empty-project")?.registered).toBe(true);

      const rows = listAudit(db);
      const init = rows.find((item) => item.tool === "grande_repo_init");
      const apply = rows.find((item) => item.tool === "grande_repo_add_apply");
      expect(init).toMatchObject({ decision: "ALLOWED", state: "SUCCEEDED" });
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
    const layout = loadLayout();
    const db = openDb(layout);
    try {
      expect(() => registerConsoleRepo(db, layout, "not-ready")).toThrow(/Git repository|readiness|非空/i);
      expect(readFileSync(marker, "utf8")).toBe("keep me\n");
      expect(existsSync(join(repo, ".git"))).toBe(false);
      expect(loadRegistry(layout).has("not-ready")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("path security 拒绝 symlink candidate，真实目录不被初始化", () => {
    const real = join(ws, "real-empty");
    mkdirSync(real);
    symlinkSync("real-empty", join(ws, "link-empty"), "dir");
    const layout = loadLayout();
    const db = openDb(layout);
    try {
      expect(() => registerConsoleRepo(db, layout, "link-empty")).toThrow();
      expect(existsSync(join(real, ".git"))).toBe(false);
      expect(loadRegistry(layout).has("link-empty")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("普通 ready Git repo 不初始化，只走 canonical registration + apply audit", () => {
    const repo = join(ws, "fresh");
    initRepo(repo);
    const layout = loadLayout();
    const db = openDb(layout);
    try {
      const result = registerConsoleRepo(db, layout, "fresh");
      expect(result).toEqual({ repoId: "fresh", initialized: false, registered: true });
      expect(loadRegistry(layout).get("fresh")?.registered).toBe(true);
      const rows = listAudit(db);
      expect(rows.some((item) => item.tool === "grande_repo_init")).toBe(false);
      expect(rows.find((item) => item.tool === "grande_repo_add_apply")).toMatchObject({
        decision: "ALLOWED",
        state: "SUCCEEDED",
      });
    } finally {
      db.close();
    }
  });
});
