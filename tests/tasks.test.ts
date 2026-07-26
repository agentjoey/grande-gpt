import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask, getTask, listActiveTasks, updateTaskState } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let db: DatabaseSync;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

const base = { repoId: "demo", branch: "grande/x-1", baseCommit: "abc123", worktreePath: "/w/1", state: "READY" as const };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  const l = loadLayout();
  ensureLayout(l);
  db = openDb(l);
});

afterEach(() => {
  db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("task 读写", () => {
  it("创建后可读回，stateVersion 从 1 起", () => {
    const t = createTask(db, { taskId: "task_1", ...base });
    expect(t.stateVersion).toBe(1);
    expect(getTask(db, "task_1")?.branch).toBe("grande/x-1");
  });

  it("未知 taskId 返回 undefined", () => {
    expect(getTask(db, "nope")).toBeUndefined();
  });

  it("重复 taskId 被主键约束拒绝", () => {
    createTask(db, { taskId: "task_1", ...base });
    expect(() => createTask(db, { taskId: "task_1", ...base })).toThrow();
  });

  it("状态变更递增 stateVersion", () => {
    createTask(db, { taskId: "task_1", ...base });
    expect(updateTaskState(db, "task_1", "RUNNING", 1).stateVersion).toBe(2);
  });

  it("版本不匹配时拒绝更新——防止旧客户端覆盖新状态", () => {
    createTask(db, { taskId: "task_1", ...base });
    updateTaskState(db, "task_1", "RUNNING", 1);
    expect(() => updateTaskState(db, "task_1", "CLOSED", 1)).toThrow(/STALE_STATE/);
    expect(getTask(db, "task_1")?.state).toBe("RUNNING");
  });

  it("listActiveTasks 排除 CLOSED", () => {
    createTask(db, { taskId: "task_1", ...base });
    createTask(db, { taskId: "task_2", ...base });
    updateTaskState(db, "task_2", "CLOSED", 1);
    expect(listActiveTasks(db).map((t) => t.taskId)).toEqual(["task_1"]);
  });

  it("createdAt 撞车时仍然确定性排序——用 rowid 兜底", () => {
    // 直接写原始 SQL 而不是调用 createTask()：需要两行的 createdAt 完全相同
    // （而不是「大概率同一毫秒」），才能确定性地复现 ORDER BY createdAt DESC
    // 单独作为排序键在打平时的不确定性，而不是靠连续调用两次撞运气。
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO task (taskId,repoId,branch,baseCommit,worktreePath,state,createdAt,updatedAt,stateVersion)
       VALUES (?,?,?,?,?,?,?,?,1)`,
    );
    insert.run("task_a", base.repoId, base.branch, base.baseCommit, "/w/a", base.state, now, now);
    insert.run("task_b", base.repoId, base.branch, base.baseCommit, "/w/b", base.state, now, now);
    expect(listActiveTasks(db).map((t) => t.taskId)).toEqual(["task_b", "task_a"]);
  });
});
