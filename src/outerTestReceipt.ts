import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import { getTask } from "./tasks.ts";

export interface OuterTestReceipt {
  taskId: string;
  commit: string;
  profile: string;
  files: string[];
  passedAt: number;
}

/**
 * 读取最近一次 host outer-test receipt。损坏/旧格式 receipt 一律按不存在处理：
 * merge gate 必须 fail closed，不能让不可解析的本机状态替当前 SHA 背书。
 */
export function getOuterTestReceipt(db: DatabaseSync, taskId: string): OuterTestReceipt | null {
  const row = db.prepare("SELECT receiptJson FROM outer_test_receipt WHERE taskId=?").get(taskId) as
    | { receiptJson: string }
    | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.receiptJson) as Partial<OuterTestReceipt>;
    if (
      value.taskId !== taskId ||
      typeof value.commit !== "string" || value.commit.length === 0 ||
      typeof value.profile !== "string" || value.profile.length === 0 ||
      !Array.isArray(value.files) || !value.files.every((file) => typeof file === "string") ||
      typeof value.passedAt !== "number" || !Number.isFinite(value.passedAt)
    ) {
      return null;
    }
    return value as OuterTestReceipt;
  } catch {
    return null;
  }
}

export function hasCurrentOuterTestReceipt(db: DatabaseSync, taskId: string, commit: string): boolean {
  return getOuterTestReceipt(db, taskId)?.commit === commit;
}

function assertTaskWorktree(db: DatabaseSync, taskId: string, worktreePath: string): void {
  const task = getTask(db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  if (task.worktreePath !== worktreePath) {
    throw new StateError("INVALID_INPUT", `任务 ${taskId} 的 worktree 与 outer-test 验收目标不一致。`);
  }
}

function readCleanHead(taskId: string, worktreePath: string): string {
  let status: string;
  try {
    status = execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    throw new StateError(
      "INVALID_INPUT",
      `检查 outer-test task worktree 失败：${e.stderr ? String(e.stderr).trim() : e.message}`,
    );
  }
  if (status.trim().length > 0) {
    throw new StateError(
      "POLICY_DENIED",
      `任务 ${taskId} 的 worktree 有未提交变化；拒绝为当前 HEAD 签发 outer-test receipt。`,
    );
  }

  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const e = error as { stderr?: Buffer | string; message: string };
    throw new StateError(
      "INVALID_INPUT",
      `读取 outer-test task HEAD 失败：${e.stderr ? String(e.stderr).trim() : e.message}`,
    );
  }
}

/** host outer-test 启动前锁定一个 clean task HEAD；成功后必须仍是同一 SHA。 */
export function prepareOuterTestRun(db: DatabaseSync, taskId: string, worktreePath: string): string {
  assertTaskWorktree(db, taskId, worktreePath);
  return readCleanHead(taskId, worktreePath);
}

/**
 * 在 host outer-test 已经成功之后，把该结果绑定到 task 当前 HEAD。
 * 调用方只传测试元数据；commit 必须由可信本机 Git 状态读取，不能由模型/CLI 参数提供。
 * expectedCommit 来自同一次 outer-test 启动前的 prepareOuterTestRun；前后 SHA 不一致即拒绝。
 */
export function recordOuterTestPass(
  db: DatabaseSync,
  taskId: string,
  worktreePath: string,
  profile: string,
  files: string[],
  passedAt = Date.now(),
  expectedCommit?: string,
): OuterTestReceipt {
  assertTaskWorktree(db, taskId, worktreePath);
  const commit = readCleanHead(taskId, worktreePath);
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new StateError(
      "STALE_STATE",
      `任务 ${taskId} 的 HEAD 在 outer-test 运行期间从 ${expectedCommit} 变化为 ${commit}；拒绝签发 receipt。`,
    );
  }

  const receipt: OuterTestReceipt = { taskId, commit, profile, files: [...files], passedAt };
  db.prepare(
    `INSERT INTO outer_test_receipt (taskId,receiptJson,updatedAt)
     VALUES (?,?,?)
     ON CONFLICT(taskId) DO UPDATE SET receiptJson=excluded.receiptJson, updatedAt=excluded.updatedAt`,
  ).run(taskId, JSON.stringify(receipt), passedAt);
  return receipt;
}
