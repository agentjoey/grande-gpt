import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let root: string;
let ws: string;
let ctrl: string;
let layout: Layout;
let canonical: string;
let origin: string;
let writer: string;
let deps: ToolDeps;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content, "utf8");
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

async function taskOpen(taskId = "task_refresh"): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_task_open");
  if (!tool) throw new Error("grande_task_open 未注册");
  const result = await tool.handler({ taskId, repoId: "demo", slug: "refresh" });
  return result.structuredContent as Record<string, any>;
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  root = mkdtempSync(join(tmpdir(), "task-open-refresh-"));
  ws = join(root, "ws");
  ctrl = join(root, "ctrl");
  mkdirSync(ws, { recursive: true });
  mkdirSync(ctrl, { recursive: true });
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);

  origin = join(root, "origin.git");
  git(root, "init", "--bare", "-q", "--initial-branch=main", origin);

  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  commit(seed, "shared.txt", "base\n", "base");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "-u", "origin", "main");

  canonical = join(layout.workspaceRoot, "demo");
  git(layout.workspaceRoot, "clone", "-q", origin, canonical);
  git(canonical, "config", "user.name", "T");
  git(canonical, "config", "user.email", "t@example.com");

  writer = join(root, "writer");
  git(root, "clone", "-q", origin, writer);
  git(writer, "config", "user.name", "T");
  git(writer, "config", "user.email", "t@example.com");

  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
});

describe("grande_task_open canonical freshness", () => {
  it("S16 Case A/D：remote main ahead 时先 fast-forward canonical，再从最新 SHA 创建 task", async () => {
    const remoteHead = commit(writer, "remote.txt", "remote\n", "remote ahead");
    git(writer, "push", "-q", "origin", "main");
    const oldLocal = git(canonical, "rev-parse", "HEAD").trim();
    expect(oldLocal).not.toBe(remoteHead);

    const result = await taskOpen();

    expect(result.ok).toBe(true);
    expect(result.data.baseCommit).toBe(remoteHead);
    expect(git(canonical, "rev-parse", "HEAD").trim()).toBe(remoteHead);
    expect(git(result.data.worktreePath, "rev-parse", "HEAD").trim()).toBe(remoteHead);
  });

  it("S16 Case B：canonical dirty 时 fail closed，不覆盖本地改动也不开 task", async () => {
    writeFileSync(join(canonical, "shared.txt"), "dirty local\n", "utf8");
    commit(writer, "remote.txt", "remote\n", "remote ahead");
    git(writer, "push", "-q", "origin", "main");
    const before = git(canonical, "rev-parse", "HEAD").trim();

    const result = await taskOpen();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CANONICAL_DIRTY");
    expect(git(canonical, "rev-parse", "HEAD").trim()).toBe(before);
    expect(git(canonical, "status", "--porcelain=v1")).toContain("shared.txt");
  });

  it("S16 Case C：canonical 与 origin/main diverged 时 fail closed，不自动 merge", async () => {
    const localHead = commit(canonical, "local.txt", "local\n", "local only");
    commit(writer, "remote.txt", "remote\n", "remote only");
    git(writer, "push", "-q", "origin", "main");

    const result = await taskOpen();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CANONICAL_DIVERGED");
    expect(git(canonical, "rev-parse", "HEAD").trim()).toBe(localHead);
    expect(git(canonical, "status", "--porcelain=v1")).toBe("");
  });
});
