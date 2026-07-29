import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const TASK_ID = "task_rollback";
const sha = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

let root: string;
let layout: Layout;
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

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`未注册的工具：${name}`);
  const result = await tool.handler(args);
  return result.structuredContent as Record<string, any>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grande-rollback-"));
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
  const db = openDb(layout);
  const worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
  mkdirSync(worktreeRoot, { recursive: true });
  git(worktreeRoot, "init", "-q", "-b", "main");
  git(worktreeRoot, "config", "user.email", "rollback@example.com");
  git(worktreeRoot, "config", "user.name", "Rollback Test");
  writeFileSync(join(worktreeRoot, "a.txt"), "before\n", "utf8");
  git(worktreeRoot, "add", ".");
  git(worktreeRoot, "commit", "-q", "-m", "initial");
  const baseCommit = git(worktreeRoot, "rev-parse", "HEAD").trim();

  createTask(db, {
    taskId: TASK_ID,
    repoId: "demo",
    branch: "grande/rollback-test",
    baseCommit,
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

describe("grande_rollback", () => {
  it("repo_edit 后 rollback：每个受影响路径恢复到 edit 前，create 文件进入 Trash", async () => {
    const worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
    const original = readFileSync(join(worktreeRoot, "a.txt"));
    const edit = await callTool("grande_repo_edit", {
      taskId: TASK_ID,
      ops: [
        { op: "modify", path: "a.txt", content: "after\n", expectedSha256: sha("before\n") },
        { op: "create", path: "created.txt", content: "created\n" },
      ],
    });
    expect(edit.ok).toBe(true);

    const rollback = await callTool("grande_rollback", {
      taskId: TASK_ID,
      checkpointId: edit.data.checkpointId,
    });

    expect(rollback.ok).toBe(true);
    expect(rollback.data).toEqual({
      taskId: TASK_ID,
      checkpointId: edit.data.checkpointId,
      restoredPaths: ["a.txt", "created.txt"],
    });
    expect(readFileSync(join(worktreeRoot, "a.txt"))).toEqual(original);
    expect(existsSync(join(worktreeRoot, "created.txt"))).toBe(false);

    const trashRoot = join(layout.controlRoot, "trash", TASK_ID);
    const createdCopy = readdirSync(trashRoot)
      .map((batch) => join(trashRoot, batch, "created.txt"))
      .find((path) => existsSync(path));
    expect(createdCopy).toBeDefined();
    expect(readFileSync(createdCopy!, "utf8")).toBe("created\n");
  });

  it("修改已有文件后 rollback：改动后的内容在 Trash 中逐字节保留", async () => {
    const worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
    const original = readFileSync(join(worktreeRoot, "a.txt"));
    const changed = Buffer.from("after\r\n第二版\n", "utf8");
    const edit = await callTool("grande_repo_edit", {
      taskId: TASK_ID,
      ops: [
        {
          op: "modify",
          path: "a.txt",
          content: changed.toString("utf8"),
          expectedSha256: sha("before\n"),
        },
      ],
    });
    expect(edit.ok).toBe(true);

    const rollback = await callTool("grande_rollback", {
      taskId: TASK_ID,
      checkpointId: edit.data.checkpointId,
    });

    expect(rollback.ok).toBe(true);
    expect(readFileSync(join(worktreeRoot, "a.txt"))).toEqual(original);
    const trashRoot = join(layout.controlRoot, "trash", TASK_ID);
    expect(existsSync(trashRoot)).toBe(true);
    const changedCopies = readdirSync(trashRoot)
      .map((batch) => join(trashRoot, batch, "a.txt"))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path));
    expect(changedCopies.some((bytes) => bytes.equals(changed))).toBe(true);
  });

  it("未知 checkpointId 返回明确错误，worktree 逐字节不变，审计落到 FAILED", async () => {
    const worktreeRoot = join(layout.worktreesRoot, "demo", TASK_ID);
    const before = readFileSync(join(worktreeRoot, "a.txt"));

    const result = await callTool("grande_rollback", {
      taskId: TASK_ID,
      checkpointId: "missing-checkpoint",
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(readFileSync(join(worktreeRoot, "a.txt"))).toEqual(before);
    const audit = listAudit(deps.db, TASK_ID).find((row) => row.tool === "grande_rollback");
    expect(audit?.decision).toBe("ALLOWED");
    expect(audit?.state).toBe("FAILED");
  });

  it("未知 taskId 返回 TASK_NOT_FOUND，且不创建 rollback 审计记录", async () => {
    const result = await callTool("grande_rollback", {
      taskId: "task_does_not_exist",
      checkpointId: "anything",
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("TASK_NOT_FOUND");
    expect(listAudit(deps.db, "task_does_not_exist")).toEqual([]);
  });

  it("成功回滚写入 ALLOWED/SUCCEEDED 审计，并记录实际恢复路径", async () => {
    const edit = await callTool("grande_repo_edit", {
      taskId: TASK_ID,
      ops: [{ op: "modify", path: "a.txt", content: "after\n", expectedSha256: sha("before\n") }],
    });
    expect(edit.ok).toBe(true);

    const result = await callTool("grande_rollback", {
      taskId: TASK_ID,
      checkpointId: edit.data.checkpointId,
    });
    expect(result.ok).toBe(true);

    const audit = listAudit(deps.db, TASK_ID).find((row) => row.tool === "grande_rollback");
    expect(audit?.decision).toBe("ALLOWED");
    expect(audit?.state).toBe("SUCCEEDED");
    expect(audit?.pathsTouched).toEqual(["a.txt"]);
  });

  it("注册为第 11 个工具，参数必填且 destructiveHint 保持 false", () => {
    const tools = buildTools(deps);
    const rollback = tools.find((tool) => tool.name === "grande_rollback");

    expect(tools).toHaveLength(11);
    expect(rollback).toBeDefined();
    expect(rollback!.inputSchema.required).toEqual(expect.arrayContaining(["taskId", "checkpointId"]));
    expect(rollback!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});
