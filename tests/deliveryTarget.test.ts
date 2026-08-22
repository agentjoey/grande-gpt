import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import {
  projectDeliveryTargetProgress,
  resolveDeliveryTarget,
  type DeliveryTarget,
} from "../src/deliveryTarget.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { TaskProgress } from "../src/taskProgress.ts";
import { createTask } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "delivery-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "delivery-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  ensureLayout(loadLayout());
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

function baseProgress(): TaskProgress {
  return {
    stages: {
      code: { state: "done", detail: "code done" },
      tests: { state: "done", detail: "tests attested" },
      pr: { state: "pending", detail: "PR missing" },
      ci: { state: "pending", detail: "CI missing" },
      merged: { state: "pending", detail: "merge missing" },
      deploy: { state: "pending", detail: "deploy configured" },
      verify: { state: "pending", detail: "verify missing" },
    },
    phase: "pr",
    taskHead: "abc",
    hostVerification: {
      requiredLevel: "none",
      manualOnlyRequired: false,
      receiptEligible: true,
      state: "not-required",
      failureClass: null,
      failureReason: null,
      retryCount: 0,
      jobId: null,
    },
    localState: "active",
    completed: false,
    cleanupRequired: false,
    blocker: null,
    nextAction: "grande_push 后 grande_pr_open",
    liveness: {
      state: "active",
      progressAt: 1,
      inactiveForMs: 0,
      stallAfterMs: 100,
      phase: "pr",
      nextAction: "grande_push 后 grande_pr_open",
    },
  };
}

function projected(target: DeliveryTarget, patch?: Partial<TaskProgress>): TaskProgress {
  return projectDeliveryTargetProgress({ ...baseProgress(), ...patch }, target);
}

describe("Phase 8 delivery target", () => {
  it("local completes after code/tests attestation and masks PR/CI/deploy ceremony", () => {
    const progress = projected("local");
    expect(progress.completed).toBe(true);
    expect(progress.phase).toBe("completed");
    expect(progress.cleanupRequired).toBe(false);
    expect(progress.blocker).toBeNull();
    expect(progress.nextAction).toContain("无待处理");
    expect(progress.stages.pr.state).toBe("not-applicable");
    expect(progress.stages.ci.state).toBe("not-applicable");
    expect(progress.stages.deploy.state).toBe("not-applicable");
  });

  it("pr ignores deploy spec and sends an opened PR straight to merge gate rather than mandatory pr_status", () => {
    const raw = baseProgress();
    raw.stages.pr = { state: "done", detail: "PR open" };
    raw.stages.ci = { state: "unknown", detail: "live CI not cached" };
    raw.phase = "ci";
    raw.nextAction = "调用 grande_pr_status 查看当前 exact-head CI";
    raw.liveness.phase = "ci";
    raw.liveness.nextAction = raw.nextAction;

    const progress = projectDeliveryTargetProgress(raw, "pr");
    expect(progress.stages.deploy.state).toBe("not-applicable");
    expect(progress.stages.verify.state).toBe("not-applicable");
    expect(progress.phase).toBe("merge");
    expect(progress.nextAction).toContain("grande_pr_merge");
    expect(progress.nextAction).not.toContain("grande_pr_status");
  });

  it("deploy fails closed when the repo has no trusted deploy spec", () => {
    const raw = baseProgress();
    raw.stages.pr = { state: "done", detail: "merged PR evidence" };
    raw.stages.ci = { state: "done", detail: "CI gate passed" };
    raw.stages.merged = { state: "done", detail: "merged" };
    raw.stages.deploy = { state: "not-applicable", detail: "repo 未配置 .grande/deploy.yaml" };
    raw.stages.verify = { state: "not-applicable", detail: "no spec" };

    const progress = projectDeliveryTargetProgress(raw, "deploy");
    expect(progress.completed).toBe(false);
    expect(progress.stages.deploy.state).toBe("blocked");
    expect(progress.blocker).toContain("deploy");
  });

  it("resolves deploy only from existing production evidence; GitHub defaults to pr and no remote defaults local", () => {
    const db = openDb(loadLayout());
    const task = createTask(db, {
      taskId: "task-delivery",
      repoId: "demo",
      branch: "grande/delivery-0001",
      baseCommit: "base",
      worktreePath: join(ws, "task"),
      state: "READY",
    });

    expect(resolveDeliveryTarget(db, task, { readOrigin: () => null })).toBe("local");
    expect(resolveDeliveryTarget(db, task, { readOrigin: () => "https://github.com/acme/demo.git" })).toBe("pr");

    const push = beginAudit(db, { taskId: task.taskId, tool: "grande_push", input: {} });
    expect(push.allowed()).toBe(true);
    expect(push.executing()).toBe(true);
    expect(push.succeeded()).toBe(true);
    expect(resolveDeliveryTarget(db, task, { readOrigin: () => null })).toBe("pr");

    db.prepare("INSERT INTO deployment_receipt (taskId,receiptJson,updatedAt) VALUES (?,?,?)").run(
      task.taskId,
      JSON.stringify({ taskId: task.taskId, deployComplete: false, verifyComplete: false }),
      Date.now(),
    );
    expect(resolveDeliveryTarget(db, task, { readOrigin: () => null })).toBe("deploy");
    db.close();
  });
});
