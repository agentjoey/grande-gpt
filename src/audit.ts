import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * `PENDING` 是 `beginAudit` 落 INTENT 行时唯一的初始值——Policy 还没有表态。
 * 曾经这里硬编码成 `'ALLOWED'`，等于替「Policy 尚未裁决」这件事编了个假结论：
 * 崩溃发生在 `beginAudit()` 返回之后、`.allowed()`/`.denied()` 之前，会永久
 * 留下一条「看起来已放行」但其实无人批准过的记录——这是账本唯一不能失败开放
 * （fail-open）的地方。没有选 `DENIED` 当默认值：那同样是编造一个 Policy 从未
 * 做出的结论，只是方向相反。`PENDING` 不编造，只陈述「还不知道」这个事实。
 */
export type AuditDecision = "PENDING" | "ALLOWED" | "DENIED";
export type AuditState = "INTENT" | "EXECUTING" | "SUCCEEDED" | "FAILED";

export interface AuditRow {
  opId: string;
  taskId: string | null;
  tool: string;
  inputDigest: string;
  decision: AuditDecision;
  state: AuditState;
  pathsTouched: string[];
  /** DENIED / FAILED 的原因；SUCCEEDED，或终结前，为 null */
  reason: string | null;
  /** 首次写入 INTENT 的时刻，不再变化 */
  at: number;
  updatedAt: number;
}

/**
 * 五个推进方法都返回 `boolean` 而不是 `void`：`true` 表示这次调用真的把行
 * 写了；`false` 表示它输掉了 CAS（compare-and-swap）——行已经被推到别处，
 * 或者调用顺序不对（比如决策已经落定后又调一次 `.allowed()`）。镜像
 * `finishJob`（jobs.ts）的处理方式：返回信号而不是抛错，也不发明一套错误
 * 分类。静默吞掉一次审计写失败，比强迫调用方检查返回值更危险——这正是
 * `AuditHandle` 存在的理由：账本的 forward-only 保证必须在写入路径里强制
 * 生效，不能只靠调用方按顺序调用。
 */
export interface AuditHandle {
  opId: string;
  allowed(): boolean;
  denied(reason: string): boolean;
  executing(): boolean;
  succeeded(pathsTouched?: string[]): boolean;
  failed(reason: string, pathsTouched?: string[]): boolean;
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
    reason: (r.reason as string | null) ?? null,
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
 * 这是规格 §8.1「先写 INTENT 再执行」的落点。`decision` 落 `PENDING`：Policy
 * 还没表态，账本不能替它编结论（见 `AuditDecision` 上的注释）。
 *
 * 只记录输入的 **sha256 摘要**而非输入本身：工具入参可能含几十 KB 的文件内容，
 * 也可能含不该进审计库的值。摘要足以证明「同一个请求」而不承载内容。
 *
 * 业务执行与审计不是单一事务，因此崩溃会留下停在 INTENT/EXECUTING 的记录 ——
 * 那不是缺陷，正是设计意图：`listUnfinishedAudit` 能把它们找出来。
 *
 * **forward-only 是写入路径的强制，不是调用方自律。** 返回的句柄里每个方法各带
 * 一个 CAS（compare-and-swap）谓词：只有此刻这一行处于该方法允许的起始状态，
 * `UPDATE` 才会真的生效；谓词是本函数写死的字面量，不经过调用方输入拼接，没有
 * 注入面。三组谓词：
 *
 * - `executing()`：`state='INTENT'`。只有还停在 INTENT 的行才能进入执行；
 *   已经在 EXECUTING 或已终结的行再调用是 no-op。
 * - `succeeded()` / `failed()`：`state NOT IN ('SUCCEEDED','FAILED')`。行还
 *   没到终态就能被它们终结，但终态一旦落定就不能被另一个终态覆盖——堵死
 *   「SUCCEEDED 被改写成 FAILED」反过来也一样。
 * - `allowed()` / `denied()`（Policy 的决策步）：`decision='PENDING' AND
 *   state='INTENT'`。选它而不是单独一个 `decision='PENDING'`，是因为决策和
 *   「行还没被 executing() 推走」这两件事必须同时成立——`state='INTENT'` 这
 *   一半正是防止旧实现那个真实 bug 的关键：旧的 `allowed()` 不带任何谓词地
 *   把 `state` 写回 `'INTENT'`，如果在 `executing()` 之后误调用，会把
 *   EXECUTING 拉回 INTENT，状态倒退。谓词一旦要求 `state='INTENT'`，这次
 *   写入在 EXECUTING 之后必然 no-op，`state` 列压根不会被触碰。
 *   `decision='PENDING'` 这一半保证决策只能落一次：不管落的是 ALLOWED 还是
 *   DENIED，后续再调用 `.allowed()`/`.denied()` 都无法改写或推翻已经落定的
 *   决策。
 *
 * 这组谓词联合起来还顺带堵死了一种自相矛盾的记录：`pathsTouched` 只有
 * `succeeded()`/`failed()` 会写，而它们的谓词要求行「还没到终态」——一旦
 * 其中一个成功写入，那次写入本身就已经把行变成了终态；而 `denied()` 的谓词
 * 要求 `state='INTENT'`，行一旦离开 INTENT 就回不去。所以「先执行、留下
 * pathsTouched，再事后补一条 DENIED 把它伪装成从未执行过」和反过来「先
 * DENIED 终结，再假装它执行过」两个方向，各自都会在其中一步被谓词挡住。
 * `decision='DENIED'` 与非空 `pathsTouched` 因此不可能共存于同一行——不是
 * 靠调用方自律，是这组 CAS 谓词的交集为空。
 */
export function beginAudit(
  db: DatabaseSync,
  a: { taskId: string | null; tool: string; input: unknown },
): AuditHandle {
  const opId = `op_${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO audit (opId,taskId,tool,inputDigest,decision,state,pathsTouched,at,updatedAt)
     VALUES (?,?,?,?,'PENDING','INTENT','[]',?,?)`,
  ).run(opId, a.taskId, a.tool, digest(a.input), now, now);

  const allowed = (): boolean => {
    const res = db
      .prepare(
        "UPDATE audit SET decision='ALLOWED', updatedAt=? " +
          "WHERE opId=? AND decision='PENDING' AND state='INTENT'",
      )
      .run(Date.now(), opId);
    return res.changes > 0;
  };

  // 被 Policy 拒绝的操作从不进入 EXECUTING：它没有执行过，直接终结为 FAILED。
  const denied = (reason: string): boolean => {
    const res = db
      .prepare(
        "UPDATE audit SET decision='DENIED', state='FAILED', reason=?, updatedAt=? " +
          "WHERE opId=? AND decision='PENDING' AND state='INTENT'",
      )
      .run(reason, Date.now(), opId);
    return res.changes > 0;
  };

  const executing = (): boolean => {
    const res = db
      .prepare("UPDATE audit SET state='EXECUTING', updatedAt=? WHERE opId=? AND state='INTENT'")
      .run(Date.now(), opId);
    return res.changes > 0;
  };

  const succeeded = (paths: string[] = []): boolean => {
    const res = db
      .prepare(
        "UPDATE audit SET state='SUCCEEDED', pathsTouched=?, updatedAt=? " +
          "WHERE opId=? AND state NOT IN ('SUCCEEDED','FAILED')",
      )
      .run(JSON.stringify(paths), Date.now(), opId);
    return res.changes > 0;
  };

  const failed = (reason: string, paths: string[] = []): boolean => {
    const res = db
      .prepare(
        "UPDATE audit SET state='FAILED', pathsTouched=?, reason=?, updatedAt=? " +
          "WHERE opId=? AND state NOT IN ('SUCCEEDED','FAILED')",
      )
      .run(JSON.stringify(paths), reason, Date.now(), opId);
    return res.changes > 0;
  };

  return { opId, allowed, denied, executing, succeeded, failed };
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
