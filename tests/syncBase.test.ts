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
  it("AC-S2-10 / S16：canonical ahead 时 relation=canonical_ahead，并 fast-forward task", async () => {
    const canonicalHead = commit(canonical, "canonical.txt", "from canonical\n", "canonical");

    const result = await sync();

    expect(result.ok).toBe(true);
    expect(result.data.relation).toBe("canonical_ahead");
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

  it("AC-S2-12 / S16：双方无冲突改动 relation=diverged，merge 后两边内容都保留", async () => {
    const canonicalHead = commit(canonical, "canonical.txt", "canonical\n", "canonical");
    const taskHead = commit(worktree, "task.txt", "task\n", "task");

    const result = await sync();

    expect(result.ok).toBe(true);
    expect(result.data.relation).toBe("diverged");
    expect(result.data.action).toBe("merged");
    expect(readFileSync(join(worktree, "canonical.txt"), "utf8")).toBe("canonical\n");
    expect(readFileSync(join(worktree, "task.txt"), "utf8")).toBe("task\n");
    const parents = git(worktree, "show", "-s", "--format=%P", "HEAD").trim().split(" ");
    expect(parents).toEqual([taskHead, canonicalHead]);
  });

  it("S16：canonical == task 时 relation=equal，action=none", async () => {
    const before = git(worktree, "rev-parse", "HEAD").trim();

    const result = await sync();

    expect(result.ok).toBe(true);
    expect(result.data.relation).toBe("equal");
    expect(result.data.action).toBe("none");
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("S16：task ahead 时 relation=task_ahead，不再返回 up-to-date 或声称 HEAD 一致", async () => {
    const taskHead = commit(worktree, "task.txt", "task\n", "task ahead");

    const result = await sync();

    expect(result.ok).toBe(true);
    expect(result.data.relation).toBe("task_ahead");
    expect(result.data.action).toBe("none");
    expect(result.data.before).toBe(taskHead);
    expect(result.data.after).toBe(taskHead);
    expect(result.hint).toContain("已包含当前 canonical HEAD");
    expect(result.hint).not.toContain("保持一致");
    expect(result.hint).not.toContain("up-to-date");
  });

  it("worktree 已切到其他分支时拒绝同步，不把 canonical 合进错误分支", async () => {
    git(worktree, "switch", "-q", "-c", "grande/wrong-sync-branch");
    const before = git(worktree, "rev-parse", "HEAD").trim();
    commit(canonical, "canonical.txt", "canonical\n", "canonical ahead");

    const result = await sync();

    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/grande\/sync-test|分支|branch/);
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(before);
    expect(git(worktree, "status", "--porcelain=v1")).toBe("");
  });

  it("工具描述明确 canonical → task，且绝不暗示 task → canonical", () => {
    const tool = buildTools(deps).find((candidate) => candidate.name === "grande_sync_base");
    expect(tool?.description).toContain("canonical HEAD 合入或快进到任务 worktree");
    expect(tool?.description).toContain("绝不修改 canonical");
    expect(tool?.inputSchema.required).toContain("taskId");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
