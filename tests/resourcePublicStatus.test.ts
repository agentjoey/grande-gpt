import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { registerJobCancellation } from "../src/jobCancellation.ts";
import { getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { toMcpTextResult } from "../src/mcpToolResult.ts";
import { saveRegistry } from "../src/registry.ts";
import { reserveManagedJob } from "../src/resourceAdmission.ts";
import { saveTaskBrief } from "../src/taskBrief.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { recordTaskPrMerged } from "../src/taskPrReceipt.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let root: string;
let deps: ToolDeps;
const TASK = "task_status_history";
const HEAD = "a".repeat(40);
const toolchain = JSON.stringify({ node: "v24", pnpm: "10", lockfileSha256: "lock" });
function task(taskId: string, state: "READY" | "CLOSED" = "READY") {
  return createTask(deps.db, { taskId, repoId: "demo", branch: `grande/${taskId}`,
    baseCommit: "b".repeat(40), worktreePath: join(deps.layout.worktreesRoot, "demo", taskId), state });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "public-status-"));
  mkdirSync(join(root, "workspace", "demo"), { recursive: true }); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  const layout = loadLayout(); ensureLayout(layout);
  saveRegistry(layout, [{ repoId: "demo", path: join(layout.workspaceRoot, "demo"), registered: true }]);
  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  task(TASK); saveExplicitDeliveryTarget(deps.db, TASK, "pr");
});
afterEach(() => { vi.restoreAllMocks(); deps.db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function status(args: Record<string, unknown> = {}) {
  const tool = buildTools(deps).find((entry) => entry.name === "grande_task_status")!;
  const payload = (await tool.handler(args)).structuredContent as {
    ok: boolean; truncated: boolean; nextCursor: string | null; hint: string;
    data: { activeTasks?: Array<{ taskId: string; progress: { blocker: string | null } }>; jobs?: Array<{ jobId: string }>;
      attestations?: Array<{ attestationId: string }>; progress?: unknown; content?: string; brief?: unknown; briefAvailable?: boolean };
  };
  expect(Buffer.byteLength(JSON.stringify(toMcpTextResult(payload)))).toBeLessThanOrEqual(32 * 1024);
  return payload;
}

function history(count: number) {
  const insertJob = deps.db.prepare(`INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,hostToolchain)
    VALUES (?,?,'unit','[]','passed',0,?,?,?)`);
  const insertAttestation = deps.db.prepare(`INSERT INTO attestation (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
    VALUES (?, ?, ?, 'unit', ?, 0, ?, ?, ?)`);
  deps.db.exec("BEGIN");
  try {
    for (let i = 0; i < count; i++) {
      const id = `job_history_${String(i).padStart(4, "0")}`;
      insertJob.run(id, TASK, 100 + i, 200 + i, toolchain);
      insertAttestation.run(`att_${i}`, TASK, HEAD, id, 100 + i, 200 + i, toolchain);
    }
    deps.db.exec("COMMIT");
  } catch (error) {
    try { deps.db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  }
}

describe("B2-5 public bounded status", () => {
  it("pages active tasks before projecting them and retains blockers", async () => {
    for (let i = 0; i < 45; i++) task(`task_page_${String(i).padStart(3, "0")}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await status({ view: "overview", pageSize: 7, ...(cursor ? { cursor } : {}) });
      expect(result.ok).toBe(true);
      expect(result.data.activeTasks!.length).toBeLessThanOrEqual(7);
      for (const row of result.data.activeTasks!) { seen.push(row.taskId); expect(row.progress.blocker).not.toBeNull(); }
      cursor = result.nextCursor;
      expect(++pages).toBeLessThan(20);
    } while (cursor);
    expect(new Set(seen).size).toBe(46);
    expect(seen).toHaveLength(46);
  });

  it("keeps new tasks out of an existing page sequence", async () => {
    for (let i = 0; i < 10; i++) task(`task_before_${i}`);
    const first = await status({ pageSize: 3 });
    expect(first.ok).toBe(true);
    task("task_arrived_later");
    const seen = first.data.activeTasks!.map((row) => row.taskId);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await status({ pageSize: 3, cursor });
      seen.push(...next.data.activeTasks!.map((row) => row.taskId)); cursor = next.nextCursor;
    }
    expect(seen).toHaveLength(11);
    expect(seen).not.toContain("task_arrived_later");
  });

  it("bounds default detail database materialization, not just output JSON", async () => {
    history(250);
    recordTaskPrMerged(deps.db, { taskId: TASK, prNumber: 1, prUrl: "https://github.com/example/demo/pull/1",
      headSha: HEAD, baseRef: "main", baseSha: "b".repeat(40), mergeSha: "c".repeat(40) });
    deps.db.prepare("UPDATE task SET state='CLOSED' WHERE taskId=?").run(TASK);
    const sizes: number[] = [];
    const original = deps.db.prepare.bind(deps.db);
    vi.spyOn(deps.db, "prepare").mockImplementation((sql) => {
      const statement = original(sql);
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = Reflect.apply(all, statement, args) as ReturnType<typeof statement.all>;
        sizes.push(rows.length); return rows;
      };
      return statement;
    });
    const before = deps.db.prepare("SELECT total_changes() n").get();
    const result = await status({ taskId: TASK });
    expect(result.ok).toBe(true);
    expect(result.data.progress).toMatchObject({ completed: true, blocker: null });
    expect(result.data.attestations!.length).toBeLessThanOrEqual(5);
    expect(sizes.every((size) => size <= 51)).toBe(true);
    expect(deps.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  });

  it.each(["jobs", "attestations"])("returns all scoped %s history through keyset continuation", async (view) => {
    history(63);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await status({ taskId: TASK, view, pageSize: 9, ...(cursor ? { cursor } : {}) });
      expect(result.ok).toBe(true);
      const rows = view === "jobs" ? result.data.jobs!.map((row) => row.jobId) : result.data.attestations!.map((row) => row.attestationId);
      expect(rows.length).toBeLessThanOrEqual(9); seen.push(...rows); cursor = result.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(63);
    expect(new Set(seen).size).toBe(63);
  });

  it("binds cursor identity to view and task", async () => {
    history(12); task("task_other_history");
    const first = await status({ taskId: TASK, view: "jobs", pageSize: 2 });
    expect(first.ok).toBe(true);
    expect((await status({ taskId: TASK, view: "attestations", cursor: first.nextCursor })).ok).toBe(false);
    expect((await status({ taskId: "task_other_history", view: "jobs", cursor: first.nextCursor })).ok).toBe(false);
  });

  it.each([{ pageSize: 0 }, { pageSize: 51 }, { cursor: "../state.db" }, { view: "jobs" }, { taskId: TASK, pid: 1 }])(
    "rejects malformed or ambiguous status input %j", async (args) => {
      expect((await status(args)).ok).toBe(false);
    },
  );

  it("does not attach an unbounded brief to every status page and preserves explicit readback", async () => {
    const brief = { source: { type: "text" }, request: "草地🧪".repeat(6000), findings: [], plan: ["one"], acceptanceCriteria: ["done"] };
    saveTaskBrief(deps.db, TASK, brief);
    const detail = await status({ taskId: TASK });
    expect(detail.ok).toBe(true);
    expect(detail.data.brief).toBeUndefined();
    expect(detail.data.briefAvailable).toBe(true);
    let content = "";
    let cursor: string | null = null;
    do {
      const result = await status({ taskId: TASK, view: "brief", ...(cursor ? { cursor } : {}) });
      expect(result.ok).toBe(true);
      content += result.data.content; cursor = result.nextCursor;
    } while (cursor);
    expect(JSON.parse(content)).toEqual(brief);
  });
});

describe("B2-5 narrow public cancellation", () => {
  it("exposes one explicit write tool and does not alter the read-only result tool", () => {
    const tools = buildTools(deps);
    const cancel = tools.find((tool) => tool.name === "grande_job_cancel");
    expect(cancel).toBeDefined();
    expect(cancel!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(Object.keys(cancel!.inputSchema.properties).sort()).toEqual(["jobId", "taskId"]);
    expect(tools.find((tool) => tool.name === "grande_run_result")!.annotations.readOnlyHint).toBe(true);
  });

  it("records intent but leaves the slot running until its owner settles", async () => {
    reserveManagedJob(deps.db, deps.layout, { jobId: "job_cancel_public", taskId: TASK, profile: "unit", argv: [], kind: "sandbox" });
    const control = registerJobCancellation(deps.db, "job_cancel_public");
    try {
      const cancel = buildTools(deps).find((tool) => tool.name === "grande_job_cancel")!;
      expect(cancel).toBeDefined();
      const result = (await cancel.handler({ taskId: TASK, jobId: "job_cancel_public" })).structuredContent;
      expect(result).toMatchObject({ ok: true });
      expect(control.signal.aborted).toBe(true);
      expect(getJob(deps.db, "job_cancel_public")?.state).toBe("running");
      const rejected = (await cancel.handler({ taskId: TASK, jobId: "job_cancel_public", signal: "SIGKILL" })).structuredContent;
      expect(rejected).toMatchObject({ ok: false });
    } finally { control.dispose(); }
  });
});
