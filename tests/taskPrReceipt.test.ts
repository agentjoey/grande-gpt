import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import {
  readTaskPrReceipt,
  recordTaskPrMerged,
  recordTaskPrOpened,
} from "../src/taskPrReceipt.ts";
import { createTask } from "../src/tasks.ts";

const TASK = "task_pr_receipt";
const HEAD = "1".repeat(40);
const BASE = "2".repeat(40);
const MERGE = "3".repeat(40);

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "task-pr-receipt-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId: TASK,
    repoId: "demo",
    branch: "grande/pr-receipt",
    baseCommit: BASE,
    worktreePath: join(layout.worktreesRoot, "demo", TASK),
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function opened() {
  return {
    taskId: TASK,
    prNumber: 42,
    prUrl: "https://github.com/example/demo/pull/42",
    headSha: HEAD,
    baseRef: "main",
    baseSha: BASE,
  };
}

describe("task PR durable receipt", () => {
  it("missing receipt returns null", () => {
    expect(readTaskPrReceipt(db, TASK)).toBeNull();
  });

  it("records opened PR identity durably", () => {
    recordTaskPrOpened(db, opened(), 100);
    expect(readTaskPrReceipt(db, TASK)).toMatchObject({
      ...opened(),
      mergeSha: null,
      openedAt: 100,
      mergedAt: null,
    });
  });

  it("replaying identical opened evidence is idempotent", () => {
    recordTaskPrOpened(db, opened(), 100);
    recordTaskPrOpened(db, opened(), 200);
    expect(readTaskPrReceipt(db, TASK)?.openedAt).toBe(100);
  });

  it("refuses to replace immutable PR number/url identity", () => {
    recordTaskPrOpened(db, opened(), 100);
    expect(() => recordTaskPrOpened(db, { ...opened(), prNumber: 43 }, 200)).toThrow(/不可变|identity/i);
    expect(() => recordTaskPrOpened(db, { ...opened(), prUrl: "https://github.com/example/demo/pull/99" }, 200))
      .toThrow(/不可变|identity/i);
  });

  it("allows unknown evidence to be filled and unmerged head/base to advance", () => {
    recordTaskPrOpened(db, { ...opened(), headSha: null, baseRef: null, baseSha: null }, 100);
    recordTaskPrOpened(db, opened(), 200);
    const nextHead = "4".repeat(40);
    const nextBase = "5".repeat(40);
    recordTaskPrOpened(db, { ...opened(), headSha: nextHead, baseSha: nextBase }, 300);
    expect(readTaskPrReceipt(db, TASK)).toMatchObject({
      headSha: nextHead,
      baseRef: "main",
      baseSha: nextBase,
      mergeSha: null,
    });
  });

  it("records exact merge evidence as a forward-only milestone", () => {
    recordTaskPrOpened(db, opened(), 100);
    recordTaskPrMerged(db, { ...opened(), mergeSha: MERGE }, 300);
    expect(readTaskPrReceipt(db, TASK)).toMatchObject({ mergeSha: MERGE, mergedAt: 300 });
  });

  it("replaying identical merge evidence is idempotent", () => {
    recordTaskPrOpened(db, opened(), 100);
    recordTaskPrMerged(db, { ...opened(), mergeSha: MERGE }, 300);
    recordTaskPrMerged(db, { ...opened(), mergeSha: MERGE }, 400);
    expect(readTaskPrReceipt(db, TASK)?.mergedAt).toBe(300);
  });

  it("allows merged baseSha null to be filled once by exact recovery evidence", () => {
    const unknownBase = { ...opened(), baseSha: null };
    recordTaskPrOpened(db, unknownBase, 100);
    recordTaskPrMerged(db, { ...unknownBase, mergeSha: MERGE }, 300);
    expect(readTaskPrReceipt(db, TASK)).toMatchObject({ baseSha: null, mergeSha: MERGE, mergedAt: 300 });

    recordTaskPrMerged(db, { ...opened(), mergeSha: MERGE }, 400);
    expect(readTaskPrReceipt(db, TASK)).toMatchObject({ baseSha: BASE, mergeSha: MERGE, mergedAt: 300 });

    const conflictingBase = "9".repeat(40);
    expect(() => recordTaskPrMerged(db, { ...opened(), baseSha: conflictingBase, mergeSha: MERGE }, 500))
      .toThrow(/merged|baseSha|不可变/i);
    expect(readTaskPrReceipt(db, TASK)?.baseSha).toBe(BASE);
  });

  it("locks exact head/base/merge evidence after merged", () => {
    recordTaskPrMerged(db, { ...opened(), mergeSha: MERGE }, 300);
    expect(() => recordTaskPrOpened(db, { ...opened(), headSha: "4".repeat(40) }, 400))
      .toThrow(/merged|headSha|不可变/i);
    expect(() => recordTaskPrMerged(db, { ...opened(), mergeSha: "5".repeat(40) }, 400))
      .toThrow(/不可变|merge/i);
  });

  it("rejects malformed merge evidence", () => {
    recordTaskPrOpened(db, opened(), 100);
    expect(() => recordTaskPrMerged(db, { ...opened(), mergeSha: "not-a-sha" }, 300)).toThrow(/SHA|40/);
  });
});
