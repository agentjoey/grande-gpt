import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { listJobs } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const TASK_ID = "task_policy_run";

let root: string;
let layout: Layout;
let worktreeRoot: string;
let deps: ToolDeps;
let previousWorkspace: string | undefined;
let previousControl: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeGlobalPolicy(yaml: string): void {
  writeFileSync(join(layout.configDir, "deny.yaml"), yaml, "utf8");
}

function writeRepoPolicy(yaml: string): void {
  const dir = join(worktreeRoot, ".grande");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "policy.yaml"), yaml, "utf8");
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`未注册的工具：${name}`);
  const result = await tool.handler(args);
  return result.structuredContent as Record<string, any>;
}

async function editCreate(path: string, content = "content\n"): Promise<Record<string, any>> {
  return callTool("grande_repo_edit", {
    taskId: TASK_ID,
    ops: [{ op: "create", path, content }],
  });
}

async function probeRun(): Promise<Record<string, any>> {
  return callTool("grande_run", { taskId: TASK_ID, profile: "missing-profile" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grande-policy-run-"));
  previousWorkspace = process.env.GRANDE_WORKSPACE;
  previousControl = process.env.GRANDE_CONTROL;
  const workspaceRoot = join(root, "workspace");
  const controlRoot = join(root, "control");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspaceRoot;
  process.env.GRANDE_CONTROL = controlRoot;

  layout = loadLayout();
  ensureLayout(layout);
  worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
  mkdirSync(worktreeRoot, { recursive: true });
  git(worktreeRoot, "init", "-q", "-b", "main");
  git(worktreeRoot, "config", "user.email", "policy-run@example.com");
  git(worktreeRoot, "config", "user.name", "Policy Run Test");
  writeFileSync(join(worktreeRoot, "README.md"), "base\n", "utf8");
  git(worktreeRoot, "add", ".");
  git(worktreeRoot, "commit", "-q", "-m", "base");
  const baseCommit = git(worktreeRoot, "rev-parse", "HEAD").trim();

  const db = openDb(layout);
  createTask(db, {
    taskId: TASK_ID,
    repoId: "demo",
    branch: "grande/policy-run-test",
    baseCommit,
    worktreePath: worktreeRoot,
    state: "READY",
  });
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    'repos:\n  demo:\n    ok: { argv: ["/bin/sh", "-c", "exit 0"], timeoutSeconds: 30 }\n',
    "utf8",
  );
  deps = { db, layout };
});

afterEach(() => {
  deps.db.close();
  if (previousWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = previousWorkspace;
  if (previousControl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = previousControl;
  rmSync(root, { recursive: true, force: true });
});

describe("grande_run pairedEdits", () => {
  it("AC-S15-4/5：只改 src 时 edit 成功而 run 被拒；补 tests 后 policy 放行到 profile 校验", async () => {
    writeGlobalPolicy("pairedEdits:\n  - when: src/**\n    require: tests/**\n");

    const implementationEdit = await editCreate("src/x.ts", "export const x = 1;\n");
    expect(implementationEdit.ok).toBe(true);

    const blocked = await probeRun();
    expect(blocked.ok).toBe(false);
    expect(blocked.error.code).toBe("POLICY_DENIED");
    expect(blocked.error.message).toContain("tests/**");
    expect(listJobs(deps.db, TASK_ID)).toEqual([]);

    const testEdit = await editCreate("tests/x.test.ts", "export {};\n");
    expect(testEdit.ok).toBe(true);

    const allowed = await probeRun();
    expect(allowed.ok).toBe(false);
    expect(allowed.error.code).toBe("PROFILE_NOT_FOUND");
    expect(listJobs(deps.db, TASK_ID)).toEqual([]);
  });

  it("没有 pairedEdits 时 grande_run 不受影响", async () => {
    expect((await editCreate("src/only.ts")).ok).toBe(true);

    const result = await probeRun();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("PROFILE_NOT_FOUND");
  });

  it("全局与 repo 两条规则同时缺失时全部列出；补一条后只报告仍缺的那条", async () => {
    writeGlobalPolicy("pairedEdits:\n  - when: src/**\n    require: tests/**\n");
    writeRepoPolicy("pairedEdits:\n  - when: schema/**\n    require: generated/**\n");
    expect((await editCreate("src/x.ts")).ok).toBe(true);
    expect((await editCreate("schema/x.yaml")).ok).toBe(true);

    const bothMissing = await probeRun();
    expect(bothMissing.ok).toBe(false);
    expect(bothMissing.error.code).toBe("POLICY_DENIED");
    expect(bothMissing.error.message).toContain("tests/**");
    expect(bothMissing.error.message).toContain("generated/**");

    expect((await editCreate("tests/x.test.ts")).ok).toBe(true);
    const oneMissing = await probeRun();
    expect(oneMissing.ok).toBe(false);
    expect(oneMissing.error.code).toBe("POLICY_DENIED");
    expect(oneMissing.error.message).not.toContain("tests/**");
    expect(oneMissing.error.message).toContain("generated/**");
    expect(listJobs(deps.db, TASK_ID)).toEqual([]);
  });
});
