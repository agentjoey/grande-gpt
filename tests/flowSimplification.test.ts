import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { addFlowSimplification, RUN_BOUNDED_WAIT_MS } from "../src/flowSimplification.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import type { TaskProgress } from "../src/taskProgress.ts";
import type { ToolDef, ToolDeps } from "../src/toolsCore.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
let deps: ToolDeps;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "flow-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "flow-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  deps = { db: openDb(layout), layout };
  createTask(deps.db, {
    taskId: "task-flow",
    repoId: "demo",
    branch: "grande/flow-0001",
    baseCommit: "base",
    worktreePath: join(ws, "missing-worktree"),
    state: "READY",
  });
});

afterEach(() => {
  vi.useRealTimers();
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
});

function tool(name: string, handler: ToolDef["handler"]): ToolDef {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: name === "grande_task_status", destructiveHint: false, openWorldHint: false },
    handler,
  };
}

function progress(): TaskProgress {
  return {
    stages: {
      code: { state: "done", detail: "done" },
      tests: { state: "done", detail: "attested" },
      pr: { state: "done", detail: "open" },
      ci: { state: "unknown", detail: "live only" },
      merged: { state: "pending", detail: "not merged" },
      deploy: { state: "pending", detail: "spec exists" },
      verify: { state: "pending", detail: "not verified" },
    },
    phase: "ci",
    taskHead: "abc",
    hostVerification: {
      requiredLevel: "none", manualOnlyRequired: false, receiptEligible: true,
      state: "not-required", failureClass: null, failureReason: null, retryCount: 0, jobId: null,
    },
    localState: "active",
    completed: false,
    cleanupRequired: false,
    blocker: null,
    nextAction: "调用 grande_pr_status",
    liveness: { state: "active", progressAt: 1, inactiveForMs: 0, stallAfterMs: 100, phase: "ci", nextAction: "调用 grande_pr_status" },
  };
}

describe("Phase 8 flow simplification wrappers", () => {
  it("returns a short job terminal report from the first grande_run call", async () => {
    const run = tool("grande_run", async () => {
      createJob(deps.db, { jobId: "job-short", taskId: "task-flow", profile: "unit", argv: [], pgid: null });
      setTimeout(() => finishJob(deps.db, "job-short", { state: "passed", exitCode: 0, artifactPath: null, summary: null }), 20);
      return { structuredContent: { ok: true, taskId: "task-flow", data: { jobId: "job-short", state: "running", pollAfterSeconds: 3 } } };
    });
    addFlowSimplification(deps, [run]);

    const result = (await run.handler({ taskId: "task-flow", profile: "unit" })).structuredContent as any;
    expect(result.ok).toBe(true);
    expect(result.data.jobId).toBe("job-short");
    expect(result.data.state).toBe("passed");
    expect(result.data.terminalResult).toMatchObject({ state: "passed", exitCode: 0 });
  });

  it("keeps a stable jobId when the bounded wait budget expires", async () => {
    vi.useFakeTimers();
    const run = tool("grande_run", async () => {
      createJob(deps.db, { jobId: "job-long", taskId: "task-flow", profile: "unit", argv: [], pgid: null });
      return { structuredContent: { ok: true, taskId: "task-flow", data: { jobId: "job-long", state: "running", pollAfterSeconds: 3 } } };
    });
    addFlowSimplification(deps, [run]);

    const pending = run.handler({ taskId: "task-flow", profile: "unit" });
    await vi.advanceTimersByTimeAsync(RUN_BOUNDED_WAIT_MS);
    const result = (await pending).structuredContent as any;
    expect(result.data.jobId).toBe("job-long");
    expect(result.data.state).toBe("running");
    expect(result.hint).toContain("grande_run_result");
  });

  it("projects task status to PR target and makes merge the single next action", async () => {
    const push = beginAudit(deps.db, { taskId: "task-flow", tool: "grande_push", input: {} });
    push.allowed(); push.executing(); push.succeeded();
    const status = tool("grande_task_status", async () => ({
      structuredContent: { ok: true, taskId: "task-flow", data: { taskId: "task-flow", progress: progress() }, hint: "old hint" },
    }));
    addFlowSimplification(deps, [status]);

    const result = (await status.handler({ taskId: "task-flow" })).structuredContent as any;
    expect(result.data.deliveryTarget).toBe("pr");
    expect(result.data.developmentRisk).toBe("L3");
    expect(result.data.progress.phase).toBe("merge");
    expect(result.data.progress.nextAction).toContain("grande_pr_merge");
    expect(result.data.progress.nextAction).not.toContain("grande_pr_status");
  });
});
