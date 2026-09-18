import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { projectDeliveryTargetProgress, resolveDeliveryTarget } from "../src/deliveryTarget.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { projectTaskProgress, type TaskProgressOptions } from "../src/taskProgress.ts";
import { recordTaskPrMerged } from "../src/taskPrReceipt.ts";
import { createTask } from "../src/tasks.ts";

const TASK = "task_receipt_projection";
const HEAD = "1".repeat(40);
let root: string;
let db: ReturnType<typeof openDb>;
let task: ReturnType<typeof createTask>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "receipt-projection-"));
  mkdirSync(join(root, "workspace"));
  mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  const layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  task = createTask(db, { taskId: TASK, repoId: "demo", branch: "grande/receipt-projection", baseCommit: "0".repeat(40), worktreePath: join(root, "absent-worktree"), state: "READY" });
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function merged(): void {
  recordTaskPrMerged(db, { taskId: TASK, prNumber: 7, prUrl: "https://github.com/example/demo/pull/7", headSha: HEAD, baseRef: "main", baseSha: "2".repeat(40), mergeSha: "3".repeat(40) });
}

function project(overrides: TaskProgressOptions = {}) {
  return projectTaskProgress(db, task, {
    readHead: () => HEAD, filesChanged: () => 1, workingTreeDirty: () => false,
    worktreeExists: () => true, deployConfigured: () => false, ...overrides,
  });
}

describe("durable merge projection does not invent delivery evidence", () => {
  it("does not report CI passed merely because an external PR merged", () => {
    merged();
    const progress = project();
    expect(progress.stages.merged.state).toBe("done");
    expect(progress.stages.ci.state).toBe("unknown");
  });

  it("recommends guarded reconciliation rather than force-close for a retained dirty worktree", () => {
    merged();
    const source = project({ workingTreeDirty: () => true });
    const masked = projectDeliveryTargetProgress(source, "pr", TASK);
    for (const progress of [source, masked]) {
      expect(progress.cleanupRequired).toBe(true);
      expect(progress.nextAction).toContain("grande_pr_merge");
      expect(progress.nextAction).not.toContain("grande_task_close");
    }
  });

  it("a closed merged task does not invent new test/code work after its worktree was removed", () => {
    merged();
    task = { ...task, state: "CLOSED" };
    const source = project({ worktreeExists: () => false, readHead: () => { throw new Error("worktree removed"); } });
    for (const progress of [source, projectDeliveryTargetProgress(source, "pr", TASK)]) {
      expect(progress.phase).toBe("completed");
      expect(progress.completed).toBe(true);
      expect(progress.cleanupRequired).toBe(false);
      expect(progress.blocker).toBeNull();
      expect(progress.nextAction).toBe("无待处理动作");
    }
  });

  it("legacy merge history beyond 500 events stays unknown, not silently pending or completed", () => {
    const audit = beginAudit(db, { taskId: TASK, tool: "grande_pr_merge", input: {} });
    audit.allowed(); audit.executing(); audit.succeeded();
    db.prepare("UPDATE audit SET at=1, updatedAt=1 WHERE opId=?").run(audit.opId);
    db.exec("BEGIN");
    try {
      for (let i = 0; i < 520; i++) {
        const noise = beginAudit(db, { taskId: TASK, tool: "grande_repo_read", input: { i } });
        noise.allowed(); noise.executing(); noise.succeeded();
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
    const progress = project();
    expect(progress.stages.merged.state).toBe("unknown");
    expect(progress.completed).toBe(false);
    expect(progress.nextAction).toContain("grande_pr_merge");
    expect(resolveDeliveryTarget(db, task, { readOrigin: () => null })).toBe("pr");
  });

  it("an explicit deploy task cannot become completed just because its repo has no deploy.yaml", () => {
    merged();
    saveExplicitDeliveryTarget(db, TASK, "deploy");
    const progress = project();
    expect(progress.completed).toBe(false);
    expect(progress.cleanupRequired).toBe(false);
    expect(progress.stages.deploy.state).toBe("pending");
  });
});
