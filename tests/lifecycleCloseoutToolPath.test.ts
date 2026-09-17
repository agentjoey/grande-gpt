import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { recordTaskPrMerged } from "../src/taskPrReceipt.ts";
import type { TaskProgress } from "../src/taskProgress.ts";
import { createTask, updateTaskState } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const TASK = "task_archived_status_tool";
let root: string;
let deps: ToolDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "closeout-tool-"));
  mkdirSync(join(root, "workspace", "demo"), { recursive: true });
  mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  const layout = loadLayout();
  ensureLayout(layout);
  saveRegistry(layout, [{ repoId: "demo", path: join(root, "workspace", "demo"), registered: true }]);
  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  const task = createTask(deps.db, { taskId: TASK, repoId: "demo", branch: "grande/archived-status",
    baseCommit: "1".repeat(40), worktreePath: join(layout.worktreesRoot, "demo", TASK), state: "READY" });
  saveExplicitDeliveryTarget(deps.db, TASK, "pr");
  updateTaskState(deps.db, TASK, "CLOSED", task.stateVersion);
});

afterEach(() => {
  deps.db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function status() {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_task_status");
  if (!tool) throw new Error("production task status tool missing");
  return (await tool.handler({ taskId: TASK })).structuredContent as {
    ok: boolean; hint: string; data: { state: string; base: unknown; progress: TaskProgress };
  };
}

describe("production tool assembly archived status", () => {
  it("uses real defaults through every status wrapper, without recreating the worktree", async () => {
    recordTaskPrMerged(deps.db, { taskId: TASK, prNumber: 54, prUrl: "https://github.com/example/demo/pull/54",
      headSha: "2".repeat(40), baseRef: "main", baseSha: "1".repeat(40), mergeSha: "3".repeat(40) });
    const result = await status();
    expect(result.ok).toBe(true);
    expect(result.hint).not.toMatch(/grande gc|stale|ghost/);
    expect(result.data.base).not.toHaveProperty("error");
    expect(result.data.progress).toMatchObject({ completed: true, blocker: null, phase: "completed",
      stages: { code: { state: "unknown" }, tests: { state: "unknown" } },
      cleanupEligibility: { eligible: false } });
  });

  it("does not hide an unproven historical task behind a synthetic completion", async () => {
    const result = await status();
    expect(result.ok).toBe(true);
    expect(result.data.progress.completed).toBe(false);
    expect(result.data.progress.cleanupEligibility?.eligible).toBe(false);
  });
});
