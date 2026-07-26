import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginAudit, getAudit, listAudit, listUnfinishedAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";

let ws: string;
let ctrl: string;
let db: DatabaseSync;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

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

describe("beginAudit()", () => {
  it("返回前就已落库为 INTENT——想执行就必然先留下痕迹", () => {
    const h = beginAudit(db, { taskId: "task_1", tool: "grande_repo_edit", input: { path: "a.ts" } });
    expect(getAudit(db, h.opId)?.state).toBe("INTENT");
  });

  it("opId 唯一", () => {
    const a = beginAudit(db, { taskId: null, tool: "t", input: {} });
    const b = beginAudit(db, { taskId: null, tool: "t", input: {} });
    expect(a.opId).not.toBe(b.opId);
  });

  it("记录输入摘要而非输入本身——输入可能含大体积内容或敏感值", () => {
    const h = beginAudit(db, { taskId: null, tool: "t", input: { secret: "hunter2" } });
    const row = getAudit(db, h.opId);
    expect(row?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  it("相同输入产生相同摘要，不同输入产生不同摘要", () => {
    const a = beginAudit(db, { taskId: null, tool: "t", input: { x: 1 } });
    const b = beginAudit(db, { taskId: null, tool: "t", input: { x: 1 } });
    const c = beginAudit(db, { taskId: null, tool: "t", input: { x: 2 } });
    expect(getAudit(db, a.opId)?.inputDigest).toBe(getAudit(db, b.opId)?.inputDigest);
    expect(getAudit(db, a.opId)?.inputDigest).not.toBe(getAudit(db, c.opId)?.inputDigest);
  });
});

describe("状态推进", () => {
  it("完整成功路径：INTENT → ALLOWED → EXECUTING → SUCCEEDED", () => {
    const h = beginAudit(db, { taskId: "task_1", tool: "grande_run", input: {} });
    h.allowed();
    h.executing();
    h.succeeded(["/w/a.ts"]);
    const row = getAudit(db, h.opId);
    expect(row?.decision).toBe("ALLOWED");
    expect(row?.state).toBe("SUCCEEDED");
    expect(row?.pathsTouched).toEqual(["/w/a.ts"]);
  });

  it("被 Policy 拒绝时记 DENIED 且停在 FAILED，不进入 EXECUTING", () => {
    const h = beginAudit(db, { taskId: null, tool: "grande_repo_edit", input: {} });
    h.denied("路径不在允许写入范围内");
    const row = getAudit(db, h.opId);
    expect(row?.decision).toBe("DENIED");
    expect(row?.state).toBe("FAILED");
  });

  it("失败路径记录原因", () => {
    const h = beginAudit(db, { taskId: null, tool: "t", input: {} });
    h.allowed();
    h.executing();
    h.failed("STALE_FILE");
    expect(getAudit(db, h.opId)?.state).toBe("FAILED");
  });

  it("updatedAt 随状态推进而变化，at 保持首次写入时刻", async () => {
    const h = beginAudit(db, { taskId: null, tool: "t", input: {} });
    const first = getAudit(db, h.opId)!;
    await new Promise((r) => setTimeout(r, 5));
    h.allowed();
    const second = getAudit(db, h.opId)!;
    expect(second.at).toBe(first.at);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });
});

describe("查询", () => {
  it("listAudit 可按 taskId 过滤，按时间倒序", () => {
    beginAudit(db, { taskId: "task_1", tool: "a", input: {} });
    beginAudit(db, { taskId: "task_2", tool: "b", input: {} });
    beginAudit(db, { taskId: "task_1", tool: "c", input: {} });
    expect(listAudit(db, "task_1").map((r) => r.tool)).toEqual(["c", "a"]);
    expect(listAudit(db).length).toBe(3);
  });

  it("listUnfinishedAudit 找出停在 INTENT/EXECUTING 的记录——它们是崩溃的痕迹", () => {
    const done = beginAudit(db, { taskId: null, tool: "done", input: {} });
    done.allowed(); done.executing(); done.succeeded();
    beginAudit(db, { taskId: null, tool: "stuck-intent", input: {} });
    const midway = beginAudit(db, { taskId: null, tool: "stuck-exec", input: {} });
    midway.allowed(); midway.executing();

    expect(listUnfinishedAudit(db).map((r) => r.tool).sort()).toEqual(["stuck-exec", "stuck-intent"]);
  });

  it("at 撞车时 listAudit 仍然确定性排序——用 rowid 兜底", () => {
    // 直接写原始 SQL 而不是调用 beginAudit()：需要两行的 at 完全相同（而不是
    // 「大概率同一毫秒」），才能确定性地复现 ORDER BY at DESC 单独作为排序键
    // 在打平时的不确定性，而不是靠连续调用撞运气。同一 bug 已在 listJobs /
    // listActiveTasks 出现过两次（见 jobs.ts、tasks.ts 与对应测试）。
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO audit (opId,taskId,tool,inputDigest,decision,state,pathsTouched,at,updatedAt)
       VALUES (?,?,?,?,'ALLOWED','INTENT','[]',?,?)`,
    );
    insert.run("op_a", "task_1", "a", "digest_a", now, now);
    insert.run("op_b", "task_1", "b", "digest_b", now, now);
    expect(listAudit(db, "task_1").map((r) => r.opId)).toEqual(["op_b", "op_a"]);
  });

  it("at 撞车时 listUnfinishedAudit 同样确定性排序", () => {
    // 两行必须是**同一个** state：不同 state 会各自命中 idx_audit_state 的不同
    // 分支，两行在排序前的扫描顺序已经被索引结构分开，即使完全不加 rowid 兜底
    // 也可能凑巧得到期望的顺序——那样这条测试测不出兜底排序有没有生效（已实测：
    // state 分别为 INTENT/EXECUTING 时，本测试对未加 rowid 兜底的实现也是绿的，
    // 属于对 bug 没有分辨力的假阳性）。两行同为 INTENT 才会真的把「同一索引桶内
    // at 撞车」的打平行为逼出来。
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO audit (opId,taskId,tool,inputDigest,decision,state,pathsTouched,at,updatedAt)
       VALUES (?,?,?,?,'ALLOWED','INTENT','[]',?,?)`,
    );
    insert.run("op_x", null, "x", "digest_x", now, now);
    insert.run("op_y", null, "y", "digest_y", now, now);
    expect(listUnfinishedAudit(db).map((r) => r.opId)).toEqual(["op_y", "op_x"]);
  });
});
