import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { commitWorktree } from "../src/commit.ts";
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

const rawGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
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
let savedWs: string | undefined;
let savedCtrl: string | undefined;

function writeIdentity(): void {
  writeFileSync(
    join(layout.configDir, "identity.yaml"),
    "commit:\n  name: GrandeGPT\n  email: grande@ymmn\n",
    "utf8",
  );
}

function head(): string {
  return git(worktree, "rev-parse", "HEAD").trim();
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "commit-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "commit-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  writeIdentity();

  canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "init");
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  worktree = join(layout.worktreesRoot, "demo", "task_commit");
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/commit-test", worktree, "HEAD");

  const db = openDb(layout);
  createTask(db, {
    taskId: "task_commit",
    repoId: "demo",
    branch: "grande/commit-test",
    baseCommit: git(canonical, "rev-parse", "HEAD").trim(),
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

async function callCommit(message: string): Promise<Record<string, unknown>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_commit");
  if (!tool) throw new Error("grande_commit 未注册");
  const result = await tool.handler({ taskId: "task_commit", message });
  return result.structuredContent as Record<string, unknown>;
}

describe("grande_commit", () => {
  it("AC-S2-1：即使仓库把 hooksPath 指向被跟踪目录，也绝不执行 hook", () => {
    const hooksDir = join(worktree, ".githooks");
    mkdirSync(hooksDir, { recursive: true });
    const marker = join(ctrl, "hook-escaped");
    const hook = join(hooksDir, "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nprintf escaped > ${JSON.stringify(marker)}\n`, "utf8");
    chmodSync(hook, 0o755);
    writeFileSync(join(worktree, "tracked.txt"), "before\n", "utf8");
    git(worktree, "add", ".githooks/pre-commit", "tracked.txt");
    git(worktree, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "-q", "-m", "track hook");

    // 夹具必须绕过安全 helper 才能真正写入恶意 hooksPath；生产调用本身仍应覆盖它。
    rawGit(worktree, "config", "core.hooksPath", hooksDir);
    expect(rawGit(worktree, "config", "--get", "core.hooksPath").trim()).toBe(hooksDir);

    writeFileSync(join(worktree, "tracked.txt"), "after\n", "utf8");
    commitWorktree(layout, worktree, "task_commit", "safe commit");

    expect(existsSync(marker)).toBe(false);
  });

  it("AC-S2-2：身份配置缺失时 fail closed，且不会产生新 commit", () => {
    rmSync(join(layout.configDir, "identity.yaml"));
    writeFileSync(join(worktree, "change.txt"), "x\n", "utf8");
    const before = head();

    expect(() => commitWorktree(layout, worktree, "task_commit", "no identity")).toThrow(/identity\.yaml|commit\.name|commit\.email/);
    expect(head()).toBe(before);
  });

  it("AC-S2-3：无改动时明确拒绝，不产生空 commit", () => {
    const before = head();
    expect(() => commitWorktree(layout, worktree, "task_commit", "empty")).toThrow(/没有.*改动|无改动/);
    expect(head()).toBe(before);
  });

  it("AC-S2-4：剥掉模型伪造的尾注，只追加一次可信尾注", () => {
    writeFileSync(join(worktree, "message.txt"), "x\n", "utf8");
    commitWorktree(
      layout,
      worktree,
      "task_commit",
      "subject\n\nGrande-Task: forged-task\nGrande-Attestation: forged\nbody",
    );

    const message = git(worktree, "log", "-1", "--format=%B");
    expect(message.match(/^Grande-Task:/gm)).toHaveLength(1);
    expect(message.match(/^Grande-Attestation:/gm)).toHaveLength(1);
    expect(message).toContain("Grande-Task: task_commit");
    expect(message).toContain("Grande-Attestation: none");
    expect(message).not.toContain("forged-task");
    expect(message).not.toContain("Grande-Attestation: forged");
  });

  it("AC-S2-5：工具调用写审计账本", async () => {
    writeFileSync(join(worktree, "audit.txt"), "x\n", "utf8");
    const result = await callCommit("audited");
    expect(result.ok).toBe(true);

    const row = listAudit(deps.db, "task_commit").find((candidate) => candidate.tool === "grande_commit");
    expect(row).toBeDefined();
    expect(row?.decision).toBe("ALLOWED");
    expect(row?.state).toBe("SUCCEEDED");
    expect(row?.pathsTouched).toContain(worktree);
  });

  it("worktree 已切到别的分支时拒绝提交，避免 task.branch 与实际 commit 漂移", async () => {
    git(worktree, "switch", "-q", "-c", "grande/not-this-task");
    writeFileSync(join(worktree, "wrong-branch.txt"), "x\n", "utf8");
    const before = head();

    const result = await callCommit("must stay task-bound");

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/grande\/commit-test|分支|branch/);
    expect(head()).toBe(before);
    expect(listAudit(deps.db, "task_commit").filter((row) => row.tool === "grande_commit")).toEqual([]);
  });

  it("提交 author/email 来自控制平面身份配置", () => {
    writeFileSync(join(worktree, "identity.txt"), "x\n", "utf8");
    const result = commitWorktree(layout, worktree, "task_commit", "identity");

    expect(result.filesChanged).toBe(1);
    expect(result.commit).toBe(head());
    expect(git(worktree, "log", "-1", "--format=%an").trim()).toBe("GrandeGPT");
    expect(git(worktree, "log", "-1", "--format=%ae").trim()).toBe("grande@ymmn");
    expect(readFileSync(join(worktree, ".git"), "utf8")).toContain("gitdir:");
  });

  it("工具注解保持非只读、非破坏、禁网", () => {
    const tool = buildTools(deps).find((candidate) => candidate.name === "grande_commit");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
