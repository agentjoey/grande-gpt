import type { DatabaseSync } from "node:sqlite";

export type TaskState = "CREATING" | "READY" | "RUNNING" | "CLOSED";

export interface TaskRow {
  taskId: string;
  repoId: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  stateVersion: number;
}

function toRow(r: Record<string, unknown>): TaskRow {
  return {
    taskId: r.taskId as string,
    repoId: r.repoId as string,
    branch: r.branch as string,
    baseCommit: r.baseCommit as string,
    worktreePath: r.worktreePath as string,
    state: r.state as TaskState,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    stateVersion: r.stateVersion as number,
  };
}

export function createTask(
  db: DatabaseSync,
  t: Omit<TaskRow, "createdAt" | "updatedAt" | "stateVersion">,
): TaskRow {
  const now = Date.now();
  db.prepare(
    `INSERT INTO task (taskId,repoId,branch,baseCommit,worktreePath,state,createdAt,updatedAt,stateVersion)
     VALUES (?,?,?,?,?,?,?,?,1)`,
  ).run(t.taskId, t.repoId, t.branch, t.baseCommit, t.worktreePath, t.state, now, now);
  return { ...t, createdAt: now, updatedAt: now, stateVersion: 1 };
}

export function getTask(db: DatabaseSync, taskId: string): TaskRow | undefined {
  const r = db.prepare("SELECT * FROM task WHERE taskId = ?").get(taskId);
  return r ? toRow(r as Record<string, unknown>) : undefined;
}

export function listActiveTasks(db: DatabaseSync): TaskRow[] {
  return db
    .prepare("SELECT * FROM task WHERE state != 'CLOSED' ORDER BY createdAt DESC")
    .all()
    .map((r) => toRow(r as Record<string, unknown>));
}

/**
 * 乐观并发：只有携带当前 `stateVersion` 才能改状态。
 *
 * 规格 §7 的 `stateVersion` 是为了防止旧客户端覆盖新状态——ChatGPT 的对话可能
 * 分叉、重试、跨会话恢复，同一个 task 会被多个持有旧快照的调用方触及。
 */
export function updateTaskState(
  db: DatabaseSync,
  taskId: string,
  state: TaskState,
  expectedVersion: number,
): TaskRow {
  const now = Date.now();
  const res = db
    .prepare(
      `UPDATE task SET state = ?, updatedAt = ?, stateVersion = stateVersion + 1
       WHERE taskId = ? AND stateVersion = ?`,
    )
    .run(state, now, taskId, expectedVersion);

  if (res.changes === 0) {
    const cur = getTask(db, taskId);
    if (!cur) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    throw new Error(
      `STALE_STATE: 任务 ${taskId} 的 stateVersion 已是 ${cur.stateVersion}，` +
        `而本次更新携带的是 ${expectedVersion}。请重新读取状态后再试。`,
    );
  }
  const updated = getTask(db, taskId);
  if (!updated) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
  return updated;
}
