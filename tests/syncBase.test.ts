import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let ws: string;
let ctrl: string;
let layout: Layout;
let canonical: string;
let worktree: string;
let deps: ToolDeps;
let baseCommit: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content, "utf8");
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD").trim();
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "sync-base-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "sync-base-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  writeFileSync(
    join(layout.configDir, "identity.yaml"),
    "commit:\n  name: GrandeGPT\n  email: grande@ymmn\n",
    "utf8",
  );

  canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  baseCommit = commit(canonical, "shared.txt", "base\n", "base");
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  worktree = join(layout.worktreesRoot, "demo", "task_sync");
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/sync-test", worktree, baseCommit);
  const db = openDb(layout);
  createTask(db, {
    taskId: "task_sync",
    repoId: "demo",
    branch: "grande/sync-test",
    baseCommit,
    worktreePath: worktree,
    state: "READY",
  });
  deps = { db, layout, defaultRepoId: "demo" };
});

afterEach(() => {
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

async function sync(): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_sync_base");
  if (!tool) throw new Error("grande_sync_base 未注册");
  const result = await tool.handler({ taskId: "task_sync" });
  return result.structuredContent as Record<string, any>;
}

function snapshot(paths: string[]): Map<string, Buffer> {
  return new Map(paths.map((path) => [path, readFileSync(join(worktree, path))]));
}

describe("grande_sync_base", () => {
  it("AC-S2-10：任务分支没有自己的提交时可快进，worktree 内容更新", async () => {
    const canonicalHead = commit(canonical, "canonical.txt", "from canonical\n", "canonical");

    const result = await sync();

    expect(result.ok).toBe(true);
    expect(result.data.action).toBe("fast-forward");
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(canonicalHead);
    expect(readFileSync(join(worktree, "canonical.txt"), "utf8")).toBe("from canonical\n");
  });

  it("AC-S2-11：真实冲突被拒，列出文件，merge --abort 后 worktree 逐字节回到操作前", async () => {
    commit(canonical, "shared.txt", "canonical\n", "canonical change");
    commit(worktree, "shared.txt", "task\n", "task change");
    const beforeHead = git(worktree, "rev-parse", "HEAD").trim();
    const paths = git(worktree, "ls-files", "-z").split("\0").filter(Boolean);
    const before = snapshot(paths);

    const result = await sync();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("MERGE_CONFLICT");
    expect(result.error.message).toContain("shared.txt");
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(beforeHead);
    expect(git(worktree, "status", "--porcelain=v1")).toBe("");
    for (const [path, bytes] of before) {
      expect(readFileSync(join(worktree, path)), path).toEqual(bytes);
    }
    expect(existsSync(join(worktree, ".git", "MERGE_HEAD"))).toBe(false);
    const checkpointRoot = join(layout.controlRoot, "checkpoints", "task_sync");
    expect(readdirSync(checkpointRoot).length).toBeGreaterThan(0);
  });

  it("AC-S2-12：双方无冲突改动产生 merge commit，两边内容都保留", async () => {
    const canonicalHead = commit(canonical, "canonical.txt", "canonical\n", "canonical");
    const taskHead = commit(worktree, "task.txt", "task\n", "task");

    const result = await sync();

    expect(result.ok).toBe(true);
    expect(result.data.action).toBe("merged");
    expect(readFileSync(join(worktree, "canonical.txt"), "utf8")).toBe("canonical\n");
    expect(readFileSync(join(worktree, "task.txt"), "utf8")).toBe("task\n");
    const parents = git(worktree, "show", "-s", "--format=%P", "HEAD").trim().split(" ");
    expect(parents).toEqual([taskHead, canonicalHead]);
  });

  it("已最新时无操作，不产生多余 commit", async () => {
    const before = git(worktree, "rev-parse", "HEAD").trim();

    const result = await sync();

    expect(result.ok).toBe(true);
    expect(result.data.action).toBe("up-to-date");
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("工具注解与参数符合写工具契约", () => {
    const tool = buildTools(deps).find((candidate) => candidate.name === "grande_sync_base");
    expect(tool?.inputSchema.required).toContain("taskId");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
