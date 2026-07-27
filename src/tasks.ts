import type { DatabaseSync } from "node:sqlite";
import { assertTaskId } from "./paths.ts";

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
  // C4：taskId 从这里落库后，会被 runner.ts 的 startJob 直接拼进 artifactDir
  // （`join(layout.artifactsDir, taskId, jobId)`）——那里现在也校验了，但「能做
  // 成硬约束的绝不做成软约束」（铁律三）：不能指望每一个把 taskId 拼进路径的
  // 调用点都记得自己校验一遍，落库这道口子本身就应该拒绝形状非法的 taskId。
  assertTaskId(t.taskId);
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

/**
 * 按 `createdAt` 倒序；与 `listJobs`（见 `jobs.ts`）同样的 tiebreak 需要——
 * `createdAt` 用 `Date.now()`（毫秒精度），同一毫秒内创建的多个 task 会打平，
 * 单靠 `ORDER BY createdAt DESC` 顺序不确定。用 `rowid`（SQLite 隐式的插入
 * 序，`task` 表未声明 WITHOUT ROWID）做第二排序键，倒序即“后插入的排前面”，
 * 与“创建时间倒序”的语义一致。
 *
 * `grande status` 这类只读 CLI 直接把这个列表渲染给人看排障——调试时的不确
 * 定顺序比大多数地方更容易误导人，所以即使目前没有测试断言多个同时创建的
 * active task 之间的顺序，这里也不留这个口子。
 */
export function listActiveTasks(db: DatabaseSync): TaskRow[] {
  return db
    .prepare("SELECT * FROM task WHERE state != 'CLOSED' ORDER BY createdAt DESC, rowid DESC")
    .all()
    .map((r) => toRow(r as Record<string, unknown>));
}

/**
 * 乐观并发：只有携带当前 `stateVersion` 才能改状态。
 *
 * 规格 §7 的 `stateVersion` 是为了防止旧客户端覆盖新状态——ChatGPT 的对话可能
 * 分叉、重试、跨会话恢复，同一个 task 会被多个持有旧快照的调用方触及。
 *
 * 本函数不做状态转移合法性校验（例如是否允许从 `CLOSED` 转到 `RUNNING`）——
 * 这是有意为之：转移图校验是调用方（工具处理层）在调用本函数之前的职责，
 * 这里只保证 `stateVersion` 的 CAS 语义正确。调用方不能假设本函数会替它挡下
 * 非法的状态转移。
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
