import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import {
  APPROVAL_TTL_MS,
  createAuthorization,
  type DeliveryAuthorizationBinding,
} from "../src/deliveryAuthorization.ts";
import { addFlowSimplification, RUN_BOUNDED_WAIT_MS } from "../src/flowSimplification.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { createTask, getTask } from "../src/tasks.ts";
import { projectTaskProgress, type TaskProgress } from "../src/taskProgress.ts";
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

/**
 * Task 7 closeout：公开 grande_task_status 的 progress 必须挂载
 * DeliveryAuthorizationProjection（READY/APPROVED/EXECUTING/FAILED/UNCERTAIN/DONE），
 * 且每个状态有唯一 nextAction。这里走真实 projectTaskProgress + addFlowSimplification
 * 包装链——不是直接调投影函数——保证 integration 面不会丢字段。
 */
describe("Task 7 closeout：task status 挂载 DeliveryAuthorizationProjection", () => {
  function deliveryBinding(taskId: string): DeliveryAuthorizationBinding {
    const createdAt = Date.now();
    return {
      authorizationKind: "delivery",
      taskId,
      repoId: "demo",
      worktreeRealpath: "/tmp/wt",
      deliveryTarget: "deploy",
      deployTarget: "production",
      deploySpecDigest: `sha256:${"0".repeat(64)}`,
      policyDigest: `sha256:${"0".repeat(64)}`,
      runtimeBuild: "test",
      toolsetEpoch: 1,
      toolsDigest: `sha256:${"0".repeat(64)}`,
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS,
      prNumber: 1,
      baseRef: "main",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      mergeMethod: "merge",
      expectedMergeTree: "3".repeat(40),
      deployRef: "capability:platform/deploy",
      verifyRef: "capability:platform/verify",
    };
  }

  /** 造一个 explicit deploy 任务 + 指定状态的 authorization；receipt 可选。 */
  function seedDelivery(
    taskId: string,
    status: string,
    opts: { reason?: string; receipt?: Record<string, unknown> } = {},
  ): { authorizationId: string; bindingDigest: string } {
    createTask(deps.db, {
      taskId,
      repoId: "demo",
      branch: `grande/${taskId}`,
      baseCommit: "base",
      worktreePath: join(ws, `missing-${taskId}`),
      state: "READY",
    });
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const auth = createAuthorization(deps.db, {
      kind: "delivery",
      taskId,
      binding: deliveryBinding(taskId),
      stages: {},
    });
    deps.db.prepare("UPDATE delivery_authorization SET status=?, reason=? WHERE authorizationId=?")
      .run(status, opts.reason ?? null, auth.authorizationId);
    if (opts.receipt) {
      deps.db.prepare("INSERT INTO deployment_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)")
        .run(taskId, JSON.stringify({ taskId, authorizationId: auth.authorizationId, ...opts.receipt }), Date.now());
    }
    return { authorizationId: auth.authorizationId, bindingDigest: auth.bindingDigest };
  }

  const DONE_RECEIPT = {
    verifyComplete: true,
    verifyEvidence: { target: "production", deploymentId: "dep-9", sourceSha: "a".repeat(40) },
    stages: { deploy: "succeeded", verify: "succeeded" },
  };

  /** 经真实 projectTaskProgress + flow wrapper 取 task status 信封。 */
  async function statusEnvelope(taskId: string) {
    const status = tool("grande_task_status", async () => ({
      structuredContent: {
        ok: true,
        data: {
          taskId,
          progress: projectTaskProgress(deps.db, getTask(deps.db, taskId)!, {
            readHead: () => "head1",
            filesChanged: () => 1,
            workingTreeDirty: () => false,
            worktreeExists: () => true,
            deployConfigured: () => true,
          }),
        },
      },
    }));
    addFlowSimplification(deps, [status]);
    return (await status.handler({ taskId })).structuredContent as any;
  }

  it("READY → 投影 READY_FOR_DELIVERY_APPROVAL，唯一动作是停下等 Human Console 审批", async () => {
    const auth = seedDelivery("task_da_ready", "READY");
    const result = await statusEnvelope("task_da_ready");
    expect(result.data.progress.deliveryAuthorization).toMatchObject({
      state: "READY_FOR_DELIVERY_APPROVAL",
      authorizationId: auth.authorizationId,
      bindingDigest: auth.bindingDigest,
    });
    expect(result.data.progress.nextAction).toContain("Human Console");
    expect(result.hint).toContain("Human Console");
  });

  it("SUCCEEDED + durable verifyEvidence → DELIVERY_DONE 携带真实部署身份，无待处理动作", async () => {
    const auth = seedDelivery("task_da_done", "SUCCEEDED", { receipt: DONE_RECEIPT });
    const result = await statusEnvelope("task_da_done");
    expect(result.data.progress.deliveryAuthorization).toEqual({
      state: "DELIVERY_DONE",
      authorizationId: auth.authorizationId,
      sourceSha: "a".repeat(40),
      target: "production",
      deploymentId: "dep-9",
    });
    expect(result.data.progress.nextAction).toBe("无待处理动作");
  });

  it("SUCCEEDED 但缺 durable verifyEvidence → DELIVERY_FAILED fail-closed detail，不捏造身份", async () => {
    const auth = seedDelivery("task_da_failclosed", "SUCCEEDED", { receipt: { verifyComplete: false } });
    const result = await statusEnvelope("task_da_failclosed");
    expect(result.data.progress.deliveryAuthorization).toMatchObject({
      state: "DELIVERY_FAILED",
      authorizationId: auth.authorizationId,
    });
    expect(result.data.progress.deliveryAuthorization.detail).toContain("fail closed");
    expect(result.data.progress.nextAction).toContain("停止自动工作");
  });

  it("READY/APPROVED/EXECUTING/FAILED/UNCERTAIN/DONE 六状态各自投影唯一 nextAction", async () => {
    const cases: Array<[string, string, { reason?: string; receipt?: Record<string, unknown> }, string]> = [
      ["task_da_s_ready", "READY", {}, "READY_FOR_DELIVERY_APPROVAL"],
      ["task_da_s_approved", "APPROVED", {}, "DELIVERY_APPROVED"],
      ["task_da_s_executing", "EXECUTING", {}, "DELIVERY_EXECUTING"],
      ["task_da_s_failed", "FAILED", { reason: "evidence mismatch" }, "DELIVERY_FAILED"],
      ["task_da_s_uncertain", "UNCERTAIN", { reason: "response lost" }, "DELIVERY_UNCERTAIN"],
      ["task_da_s_done", "SUCCEEDED", { receipt: DONE_RECEIPT }, "DELIVERY_DONE"],
    ];
    const nextActions: string[] = [];
    for (const [taskId, status, opts, expectedState] of cases) {
      seedDelivery(taskId, status, opts);
      const result = await statusEnvelope(taskId);
      expect(result.data.progress.deliveryAuthorization.state).toBe(expectedState);
      expect(typeof result.data.progress.nextAction).toBe("string");
      nextActions.push(result.data.progress.nextAction);
    }
    expect(new Set(nextActions).size).toBe(cases.length);
  });
});
