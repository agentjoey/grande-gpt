import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const TASK_ID = "task_policy_write";

let root: string;
let layout: Layout;
let worktreeRoot: string;
let deps: ToolDeps;
let previousWorkspace: string | undefined;
let previousControl: string | undefined;

function writeGlobalPolicy(yaml: string): void {
  writeFileSync(join(layout.configDir, "deny.yaml"), yaml, "utf8");
}

function writeRepoPolicy(yaml: string): void {
  const dir = join(worktreeRoot, ".grande");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "policy.yaml"), yaml, "utf8");
}

function file(relativePath: string, content = "content\n"): void {
  const path = join(worktreeRoot, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

async function callEdit(ops: Record<string, unknown>[]): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_repo_edit")!;
  const result = await tool.handler({ taskId: TASK_ID, ops });
  return result.structuredContent as Record<string, any>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grande-policy-write-"));
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
  const db = openDb(layout);
  createTask(db, {
    taskId: TASK_ID,
    repoId: "demo",
    branch: "grande/policy-write-test",
    baseCommit: "0000000000000000000000000000000000000000",
    worktreePath: worktreeRoot,
    state: "READY",
  });
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

describe("grande_repo_edit readOnlyPaths", () => {
  it("AC-S15-3：repo 省略全局规则也不能放宽；命中时整批零改动", async () => {
    writeGlobalPolicy("readOnlyPaths:\n  - protected/**\n");
    writeRepoPolicy("readOnlyPaths: []\npairedEdits: []\n");

    const result = await callEdit([
      { op: "create", path: "safe-before.ts", content: "safe\n" },
      { op: "create", path: "protected/a.ts", content: "blocked\n" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("POLICY_DENIED");
    expect(result.error.message).toContain("protected/**");
    expect(existsSync(join(worktreeRoot, "safe-before.ts"))).toBe(false);
    expect(existsSync(join(worktreeRoot, "protected", "a.ts"))).toBe(false);
    expect(existsSync(join(layout.controlRoot, "checkpoints", TASK_ID))).toBe(false);
    expect(existsSync(join(layout.controlRoot, "trash", TASK_ID))).toBe(false);
  });

  it("未匹配 readOnlyPaths 的路径正常写入", async () => {
    writeGlobalPolicy("readOnlyPaths:\n  - protected/**\n");

    const result = await callEdit([
      { op: "create", path: "src/allowed.ts", content: "export {};\n" },
    ]);

    expect(result.ok).toBe(true);
    expect(existsSync(join(worktreeRoot, "src", "allowed.ts"))).toBe(true);
  });

  it("move 的 from 或 to 任一命中都拒绝，源文件保持原位", async () => {
    writeGlobalPolicy("readOnlyPaths:\n  - locked/**\n");
    file("locked/source.ts", "locked source\n");
    file("safe/source.ts", "safe source\n");

    const blockedFrom = await callEdit([
      { op: "move", from: "locked/source.ts", to: "safe/from-result.ts" },
    ]);
    expect(blockedFrom.ok).toBe(false);
    expect(blockedFrom.error.code).toBe("POLICY_DENIED");
    expect(blockedFrom.error.message).toContain("locked/**");
    expect(existsSync(join(worktreeRoot, "locked", "source.ts"))).toBe(true);
    expect(existsSync(join(worktreeRoot, "safe", "from-result.ts"))).toBe(false);

    const blockedTo = await callEdit([
      { op: "move", from: "safe/source.ts", to: "locked/to-result.ts" },
    ]);
    expect(blockedTo.ok).toBe(false);
    expect(blockedTo.error.code).toBe("POLICY_DENIED");
    expect(blockedTo.error.message).toContain("locked/**");
    expect(existsSync(join(worktreeRoot, "safe", "source.ts"))).toBe(true);
    expect(existsSync(join(worktreeRoot, "locked", "to-result.ts"))).toBe(false);
  });

  it("repo policy 新增的 readOnlyPaths 确实生效", async () => {
    writeGlobalPolicy("readOnlyPaths: []\n");
    writeRepoPolicy("readOnlyPaths:\n  - repo-locked/**\n");

    const result = await callEdit([
      { op: "create", path: "repo-locked/a.ts", content: "blocked\n" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("POLICY_DENIED");
    expect(result.error.message).toContain("repo-locked/**");
    expect(existsSync(join(worktreeRoot, "repo-locked", "a.ts"))).toBe(false);
  });
});
