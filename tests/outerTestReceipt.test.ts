import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import * as receiptModule from "../src/outerTestReceipt.ts";
import { createTask } from "../src/tasks.ts";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

let root: string;
let db: ReturnType<typeof openDb>;
let worktreePath: string;
let head: string;
const taskId = "task_outer_receipt";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "outer-receipt-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  const layout = loadLayout();
  ensureLayout(layout);

  worktreePath = join(root, "worktree");
  mkdirSync(worktreePath, { recursive: true });
  git(worktreePath, "init", "-q", "-b", "grande/s18");
  git(
    worktreePath,
    "-c", "user.name=GrandeGPT",
    "-c", "user.email=grande@example.com",
    "commit", "--allow-empty", "-q", "-m", "base",
  );
  head = git(worktreePath, "rev-parse", "HEAD").trim();

  db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch: "grande/s18",
    baseCommit: head,
    worktreePath,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("OuterTestReceipt", () => {
  it("把一次通过的 host outer-test 绑定到 task 当前 HEAD SHA", () => {
    const recordOuterTestPass = (receiptModule as Record<string, unknown>).recordOuterTestPass;
    expect(typeof recordOuterTestPass).toBe("function");
    if (typeof recordOuterTestPass !== "function") return;

    const receipt = recordOuterTestPass(
      db,
      taskId,
      worktreePath,
      "unit-selfhost",
      ["tests/sandbox.test.ts"],
      123456,
    ) as Record<string, unknown>;

    expect(receipt).toMatchObject({
      taskId,
      commit: head,
      profile: "unit-selfhost",
      files: ["tests/sandbox.test.ts"],
      passedAt: 123456,
    });
    expect(receiptModule.getOuterTestReceipt(db, taskId)).toEqual(receipt);
    expect(receiptModule.hasCurrentOuterTestReceipt(db, taskId, head)).toBe(true);
  });

  it("worktree 有未提交变化时拒绝签发 receipt，不能给旧 HEAD 背书", () => {
    writeFileSync(join(worktreePath, "dirty.txt"), "dirty\n", "utf8");

    expect(() => receiptModule.recordOuterTestPass(
      db,
      taskId,
      worktreePath,
      "unit-selfhost",
      ["tests/sandbox.test.ts"],
      123456,
    )).toThrow(/未提交|clean|dirty/i);

    expect(receiptModule.getOuterTestReceipt(db, taskId)).toBeNull();
  });

  it("outer-test 运行前能锁定 clean task HEAD，供成功后做同一 SHA 校验", () => {
    const prepareOuterTestRun = (receiptModule as Record<string, unknown>).prepareOuterTestRun;
    expect(typeof prepareOuterTestRun).toBe("function");
    if (typeof prepareOuterTestRun !== "function") return;

    expect(prepareOuterTestRun(db, taskId, worktreePath)).toBe(head);
  });

  it("outer-test 运行期间 HEAD 变化时拒绝签发，不能把测试 A 记成验证 B", () => {
    const expectedCommit = receiptModule.prepareOuterTestRun(db, taskId, worktreePath);
    git(
      worktreePath,
      "-c", "user.name=Other",
      "-c", "user.email=other@example.com",
      "commit", "--allow-empty", "-q", "-m", "concurrent change",
    );

    const recordOuterTestPass = receiptModule.recordOuterTestPass as (...args: unknown[]) => unknown;
    expect(() => recordOuterTestPass(
      db,
      taskId,
      worktreePath,
      "unit-selfhost",
      ["tests/sandbox.test.ts"],
      123456,
      expectedCommit,
    )).toThrow(/HEAD|变化|changed|stale/i);

    expect(receiptModule.getOuterTestReceipt(db, taskId)).toBeNull();
  });
});
