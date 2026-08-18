import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { planOuterTest, resolveOuterTestCwd } from "../src/outerTest.ts";
import { createTask } from "../src/tasks.ts";

let ws: string, ctrl: string, layout: Layout;
let savedWs: string | undefined, savedCtrl: string | undefined;

/** 只写 profiles.yaml —— planOuterTest 不碰数据库，也不碰仓库。 */
function writeProfiles(body: string): void {
  writeFileSync(join(layout.configDir, "profiles.yaml"), body, "utf8");
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "ot-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "ot-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.workspaceRoot, "demo"), { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("planOuterTest()", () => {
  it("清单从 profile 的 --exclude 反推——改 profile 就自动跟上，这是本命令的全部价值", () => {
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","tests/sandbox.test.ts","--exclude","tests/runner.test.ts"], timeoutSeconds: 600 }\n',
    );
    expect(planOuterTest(layout, "demo").files).toEqual(["tests/sandbox.test.ts", "tests/runner.test.ts"]);

    // 往 profile 里再加一个已登记理由的排除项 —— 无需改任何反推逻辑，本命令必须自动覆盖它。
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","tests/sandbox.test.ts","--exclude","tests/runner.test.ts","--exclude","tests/server.test.ts"], timeoutSeconds: 600 }\n',
    );
    expect(planOuterTest(layout, "demo").files).toEqual([
      "tests/sandbox.test.ts", "tests/runner.test.ts", "tests/server.test.ts",
    ]);
  });

  it("只取 tests/ 下的排除项——vitest 的默认排除（node_modules/dist）不是「沙箱跑不了」", () => {
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","**/node_modules/**","--exclude","**/dist/**","--exclude","tests/sandbox.test.ts"], timeoutSeconds: 600 }\n',
    );
    const plan = planOuterTest(layout, "demo");
    expect(plan.files).toEqual(["tests/sandbox.test.ts"]);
    // 混进来会让命令去跑不存在的东西
    expect(plan.files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(plan.files.some((f) => f.includes("dist"))).toBe(false);
  });

  it("profile 不再排除任何测试文件时【响亮拒绝】，不是静默返回空清单", () => {
    // 静默返回空清单 = 命令报告「0 个文件，全部通过」= 一个看起来成功的谎。
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run"], timeoutSeconds: 600 }\n',
    );
    expect(() => planOuterTest(layout, "demo")).toThrow(/没有任何/);
  });

  it("profile 不存在时抛错，不猜一个默认清单", () => {
    writeProfiles("repos:\n  demo:\n    unit: { argv: [\"pnpm\",\"test\"], timeoutSeconds: 600 }\n");
    expect(() => planOuterTest(layout, "demo")).toThrow();
  });

  it("新增未登记 WHY 的 tests/ 排除项时响亮拒绝——生产 profile 漂移不能静默通过", () => {
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","tests/sandbox.test.ts","--exclude","tests/unknown.test.ts"], timeoutSeconds: 600 }\n',
    );
    expect(() => planOuterTest(layout, "demo")).toThrow(/unknown\.test\.ts.*WHY|WHY.*unknown\.test\.ts/);
  });

  it("每个已登记的排除文件都返回人类可读理由", () => {
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","tests/sandbox.test.ts","--exclude","tests/runner.test.ts","--exclude","tests/server.test.ts","--exclude","tests/tools.test.ts","--exclude","tests/e2e.test.ts"], timeoutSeconds: 600 }\n',
    );
    const plan = planOuterTest(layout, "demo");
    expect(plan.files.length).toBe(5);
    for (const f of plan.files) {
      expect(plan.reasons.get(f), `${f} 缺排除理由`).toBeDefined();
    }
  });
});

describe("resolveOuterTestCwd()", () => {
  it("不传 taskId 时保持旧行为：验收 canonical repo", () => {
    const db = openDb(layout);
    expect(resolveOuterTestCwd(db, layout, "grande-gpt")).toBe(join(ws, "grande-gpt"));
    db.close();
  });

  it("传 taskId 时验收该 task 的 worktree，而不是 canonical repo", () => {
    const db = openDb(layout);
    const worktreePath = join(ws, ".grande-work", "worktrees", "grande-gpt", "task_phase4");
    createTask(db, {
      taskId: "task_phase4", repoId: "grande-gpt", branch: "grande/phase4",
      baseCommit: "abc123", worktreePath, state: "READY",
    });
    expect(resolveOuterTestCwd(db, layout, "grande-gpt", "task_phase4")).toBe(worktreePath);
    db.close();
  });

  it("task 不存在或属于别的 repo 时 fail closed", () => {
    const db = openDb(layout);
    expect(() => resolveOuterTestCwd(db, layout, "grande-gpt", "task_missing")).toThrow(/TASK_NOT_FOUND|不存在/);
    createTask(db, {
      taskId: "task_other", repoId: "other", branch: "grande/other",
      baseCommit: "abc123", worktreePath: join(ws, "other-worktree"), state: "READY",
    });
    expect(() => resolveOuterTestCwd(db, layout, "grande-gpt", "task_other")).toThrow(/仓库|repo/i);
    db.close();
  });
});
