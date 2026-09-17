import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { wrapPrMergeToolD2 } from "../src/prMergeD2.ts";
import { readTaskPrReceipt, recordTaskPrMerged, recordTaskPrOpened, type TaskPrMergedInput } from "../src/taskPrReceipt.ts";
import { createTask, getTask, updateTaskState } from "../src/tasks.ts";
import type { ToolDef, ToolDeps } from "../src/toolsCore.ts";

const TASK = "task_receipt_guardrails";
const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const MERGE = "3".repeat(40);
let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "receipt-guardrails-"));
  mkdirSync(join(root, "workspace"));
  mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId: TASK, repoId: "demo", branch: "grande/receipt-guardrails",
    baseCommit: BASE, worktreePath: join(layout.worktreesRoot, "demo", TASK), state: "READY",
  });
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function evidence(): TaskPrMergedInput {
  return { taskId: TASK, prNumber: 42, prUrl: "https://github.com/example/demo/pull/42",
    headSha: HEAD, baseRef: "main", baseSha: BASE, mergeSha: MERGE };
}

describe("durable merge evidence runtime boundaries", () => {
  it.each(["headSha", "baseRef"] as const)("rejects null %s before writing any merge milestone", (field) => {
    const input = { ...evidence(), [field]: null } as unknown as TaskPrMergedInput;
    expect(() => recordTaskPrMerged(db, input)).toThrow();
    expect(readTaskPrReceipt(db, TASK)).toBeNull();
  });

  it("keeps exact evidence after database close and reopen", () => {
    recordTaskPrMerged(db, evidence(), 100);
    const before = readTaskPrReceipt(db, TASK);
    db.close();
    db = openDb(layout);
    expect(readTaskPrReceipt(db, TASK)).toEqual(before);
  });

  it("conflicting replay leaves the original row unchanged", () => {
    recordTaskPrMerged(db, evidence(), 100);
    const before = readTaskPrReceipt(db, TASK);
    expect(() => recordTaskPrMerged(db, { ...evidence(), mergeSha: "4".repeat(40) }, 200)).toThrow();
    expect(readTaskPrReceipt(db, TASK)).toEqual(before);
  });
});

describe("merge response identity binding", () => {
  it.each([
    { prNumber: 99, branch: "main" },
    { prNumber: 42, branch: "release" },
  ])("does not bind another PR/base response to the saved receipt: %j", async ({ prNumber, branch }) => {
    recordTaskPrOpened(db, evidence());
    const deps: ToolDeps = { db, layout, defaultRepoId: "demo" };
    const base: ToolDef = {
      name: "grande_pr_merge", description: "controlled merge fixture",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async () => ({ structuredContent: {
        ok: true, data: { merged: true, prNumber, headSha: HEAD, mergeSha: MERGE,
          canonicalRefresh: { action: "none", relation: "equal", branch,
            before: MERGE, after: MERGE, remoteHead: MERGE } },
      } }),
    };
    const tool = wrapPrMergeToolD2(deps, base, {
      apiFactory: () => { throw new Error("identity mismatch must not need a remote fallback"); },
    });
    const result = (await tool.handler({ taskId: TASK })).structuredContent as { data: { cleanedUp: boolean } };
    expect(result.data.cleanedUp).toBe(false);
    expect(readTaskPrReceipt(db, TASK)?.mergeSha).toBeNull();
  });

  it("persists exact merge receipt when the base merge path has already CLOSED the task", async () => {
    recordTaskPrOpened(db, evidence());
    const deps: ToolDeps = { db, layout, defaultRepoId: "demo" };
    const base: ToolDef = {
      name: "grande_pr_merge", description: "base merge closes task fixture",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      handler: async () => {
        const current = getTask(db, TASK)!;
        updateTaskState(db, TASK, "CLOSED", current.stateVersion);
        return { structuredContent: {
          ok: true, data: { merged: true, prNumber: 42, headSha: HEAD, mergeSha: MERGE,
            canonicalRefresh: { action: "none", relation: "equal", branch: "main",
              before: MERGE, after: MERGE, remoteHead: MERGE },
            localState: "clean", cleanedUp: true },
        } };
      },
    };
    const tool = wrapPrMergeToolD2(deps, base, {
      apiFactory: () => { throw new Error("closed success path must not need remote fallback"); },
      canonicalRefresher: () => { throw new Error("closed success path must not reconcile twice"); },
    });

    const result = (await tool.handler({ taskId: TASK })).structuredContent as { data: { cleanedUp: boolean } };
    expect(getTask(db, TASK)?.state).toBe("CLOSED");
    expect(result.data.cleanedUp).toBe(true);
    expect(readTaskPrReceipt(db, TASK)).toMatchObject({
      prNumber: 42, headSha: HEAD, baseRef: "main", baseSha: BASE, mergeSha: MERGE,
    });
  });
});
