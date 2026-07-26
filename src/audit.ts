import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AuditDecision = "ALLOWED" | "DENIED";
export type AuditState = "INTENT" | "EXECUTING" | "SUCCEEDED" | "FAILED";

export interface AuditRow {
  opId: string;
  taskId: string | null;
  tool: string;
  inputDigest: string;
  decision: AuditDecision;
  state: AuditState;
  pathsTouched: string[];
  /** 首次写入 INTENT 的时刻，不再变化 */
  at: number;
  updatedAt: number;
}

export interface AuditHandle {
  opId: string;
  allowed(): void;
  denied(reason: string): void;
  executing(): void;
  succeeded(pathsTouched?: string[]): void;
  failed(reason: string, pathsTouched?: string[]): void;
}

function toRow(r: Record<string, unknown>): AuditRow {
  return {
    opId: r.opId as string,
    taskId: (r.taskId as string | null) ?? null,
    tool: r.tool as string,
    inputDigest: r.inputDigest as string,
    decision: r.decision as AuditDecision,
    state: r.state as AuditState,
    pathsTouched: JSON.parse((r.pathsTouched as string) || "[]") as string[],
    at: r.at as number,
    updatedAt: r.updatedAt as number,
  };
}

/** 稳定摘要：键序不影响结果，相同输入必得相同摘要 */
function digest(input: unknown): string {
  const stable = JSON.stringify(input, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  return createHash("sha256").update(stable ?? "null", "utf8").digest("hex");
}

/**
 * 开一条审计记录。**返回之前 `INTENT` 已经落库** —— 调用方想执行就必然先留下痕迹，
 * 这是规格 §8.1「先写 INTENT 再执行」的落点。
 *
 * 只记录输入的 **sha256 摘要**而非输入本身：工具入参可能含几十 KB 的文件内容，
 * 也可能含不该进审计库的值。摘要足以证明「同一个请求」而不承载内容。
 *
 * 业务执行与审计不是单一事务，因此崩溃会留下停在 INTENT/EXECUTING 的记录 ——
 * 那不是缺陷，正是设计意图：`listUnfinishedAudit` 能把它们找出来。
 */
export function beginAudit(
  db: DatabaseSync,
  a: { taskId: string | null; tool: string; input: unknown },
): AuditHandle {
  const opId = `op_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO audit (opId,taskId,tool,inputDigest,decision,state,pathsTouched,at,updatedAt)
     VALUES (?,?,?,?,'ALLOWED','INTENT','[]',?,?)`,
  ).run(opId, a.taskId, a.tool, digest(a.input), now, now);

  const setState = (state: AuditState, decision?: AuditDecision, paths?: string[]): void => {
    if (decision !== undefined && paths !== undefined) {
      db.prepare("UPDATE audit SET state=?, decision=?, pathsTouched=?, updatedAt=? WHERE opId=?")
        .run(state, decision, JSON.stringify(paths), Date.now(), opId);
    } else if (decision !== undefined) {
      db.prepare("UPDATE audit SET state=?, decision=?, updatedAt=? WHERE opId=?")
        .run(state, decision, Date.now(), opId);
    } else if (paths !== undefined) {
      db.prepare("UPDATE audit SET state=?, pathsTouched=?, updatedAt=? WHERE opId=?")
        .run(state, JSON.stringify(paths), Date.now(), opId);
    } else {
      db.prepare("UPDATE audit SET state=?, updatedAt=? WHERE opId=?").run(state, Date.now(), opId);
    }
  };

  return {
    opId,
    allowed: () => setState("INTENT", "ALLOWED"),
    // 被 Policy 拒绝的操作从不进入 EXECUTING：它没有执行过，直接终结为 FAILED
    denied: () => setState("FAILED", "DENIED"),
    executing: () => setState("EXECUTING"),
    succeeded: (paths = []) => setState("SUCCEEDED", undefined, paths),
    failed: (_reason, paths = []) => setState("FAILED", undefined, paths),
  };
}

export function getAudit(db: DatabaseSync, opId: string): AuditRow | undefined {
  const r = db.prepare("SELECT * FROM audit WHERE opId = ?").get(opId);
  return r ? toRow(r as Record<string, unknown>) : undefined;
}

/**
 * 按 `at` 倒序，可选按 taskId 过滤；`at` 是毫秒精度的 `Date.now()`，同一毫秒内
 * 写入的多条记录会打平——用 `rowid`（SQLite 隐式插入序，audit 表未声明
 * WITHOUT ROWID）做第二排序键兜底，倒序即“后写入的排前面”，与“时间倒序”的语义
 * 一致。同一缺陷已在 listJobs（jobs.ts）与 listActiveTasks（tasks.ts）出现过
 * 两次；这里用简报给定的测试原样实测复现——三次连续 beginAudit() 调用之间没有
 * await，几乎总落在同一毫秒，"listAudit 可按 taskId 过滤，按时间倒序" 在约
 * 2/3 的运行中失败（退化为插入序而不是要求的反序）。
 */
export function listAudit(db: DatabaseSync, taskId?: string, limit = 100): AuditRow[] {
  const rows = taskId
    ? db.prepare("SELECT * FROM audit WHERE taskId = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(taskId, limit)
    : db.prepare("SELECT * FROM audit ORDER BY at DESC, rowid DESC LIMIT ?").all(limit);
  return rows.map((r) => toRow(r as Record<string, unknown>));
}

/**
 * 停在 INTENT / EXECUTING 的记录：崩溃或中断的痕迹，S4 的恢复器会消费它们。
 * 同样带 `rowid DESC` 兜底排序，理由与 listAudit 相同（`at` 撞车时排序不确定）——
 * 恢复器与人工排障都会按这个列表的顺序处理，不确定顺序在这两个场景都比大多数
 * 地方更容易误导人，不留这个口子。
 */
export function listUnfinishedAudit(db: DatabaseSync): AuditRow[] {
  return db
    .prepare("SELECT * FROM audit WHERE state IN ('INTENT','EXECUTING') ORDER BY at DESC, rowid DESC")
    .all()
    .map((r) => toRow(r as Record<string, unknown>));
}
