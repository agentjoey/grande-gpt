import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { beginAudit } from "../src/audit.ts";
import { createTask } from "../src/tasks.ts";
import { saveRegistry } from "../src/registry.ts";
import { runCli } from "../src/cli.ts";

let ws: string;
let ctrl: string;
let lines: string[];
const out = (l: string): void => void lines.push(l);
const text = (): string => lines.join("\n");
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  lines = [];
  const l = loadLayout();
  ensureLayout(l);
  mkdirSync(join(ws, "demo", ".git"), { recursive: true });
  saveRegistry(l, [{ repoId: "demo", path: join(ws, "demo"), registered: true }]);
  const db = openDb(l);
  createTask(db, {
    taskId: "task_abc", repoId: "demo", branch: "grande/fix-abc",
    baseCommit: "c0ffee", worktreePath: join(ws, ".grande-work", "worktrees", "demo", "task_abc"),
    state: "READY",
  });
  createJob(db, { jobId: "job_1", taskId: "task_abc", profile: "unit", argv: ["npm", "test"], pgid: 111 });
  finishJob(db, "job_1", { state: "failed", exitCode: 1, artifactPath: null, summary: { failedTests: ["x"] } });
  const h = beginAudit(db, { taskId: "task_abc", tool: "grande_repo_edit", input: { path: "a.ts" } });
  h.allowed(); h.executing(); h.succeeded(["a.ts"]);
  db.close();
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("grande status", () => {
  it("列出活跃 task 的分支与最近 job", () => {
    expect(runCli(["status"], out)).toBe(0);
    expect(text()).toContain("task_abc");
    expect(text()).toContain("grande/fix-abc");
    expect(text()).toContain("failed");
  });

  it("没有活跃任务时给出明确提示，而不是空白输出", () => {
    rmSync(join(ctrl, "state"), { recursive: true, force: true });
    lines = [];
    expect(runCli(["status"], out)).toBe(0);
    expect(text()).toMatch(/没有活跃任务|no active/i);
  });
});

describe("grande jobs", () => {
  it("列出 job 的 profile、状态与退出码", () => {
    expect(runCli(["jobs"], out)).toBe(0);
    expect(text()).toContain("job_1");
    expect(text()).toContain("unit");
  });

  it("--task 过滤", () => {
    // fixture 里只有 task_abc 一个任务时，即使实现忽略 --task、把所有 job 都列出来，
    // 这条测试也会看起来通过——因为 job_1 反正就在结果里。这里现造一个第二任务和
    // 它自己的 job，只有 --task 真的排除了别的任务，job_other 才不会出现。
    const l = loadLayout();
    const db = openDb(l);
    createTask(db, {
      taskId: "task_other", repoId: "demo", branch: "grande/other",
      baseCommit: "c0ffee", worktreePath: join(ws, ".grande-work", "worktrees", "demo", "task_other"),
      state: "READY",
    });
    createJob(db, { jobId: "job_other", taskId: "task_other", profile: "lint", argv: [], pgid: null });
    db.close();

    expect(runCli(["jobs", "--task", "task_abc"], out)).toBe(0);
    expect(text()).toContain("job_1");
    expect(text()).not.toContain("job_other");
  });

  it("--task 指向不存在的任务时给出提示且退出码非零", () => {
    expect(runCli(["jobs", "--task", "nope"], out)).not.toBe(0);
  });
});

describe("grande audit", () => {
  it("列出审计流水：opId、工具、决策、状态", () => {
    expect(runCli(["audit"], out)).toBe(0);
    expect(text()).toContain("grande_repo_edit");
    expect(text()).toContain("ALLOWED");
    expect(text()).toContain("SUCCEEDED");
  });
});

describe("grande doctor", () => {
  it("检查 sandbox-exec、工作区、控制平面与注册表，逐项给出结论", () => {
    expect(runCli(["doctor"], out)).toBe(0);
    const t = text();
    expect(t).toContain("sandbox-exec");
    expect(t).toContain("GRANDE_WORKSPACE");
    expect(t).toContain("demo");
  });

  it("注册了但目录不存在时报出问题并以非零码退出", () => {
    rmSync(join(ws, "demo"), { recursive: true, force: true });
    lines = [];
    expect(runCli(["doctor"], out)).not.toBe(0);
    expect(text()).toMatch(/demo/);
  });
});

describe("命令行本身", () => {
  it("未知命令给出用法且退出码非零", () => {
    expect(runCli(["nonsense"], out)).not.toBe(0);
    expect(text()).toContain("status");
  });

  it("无参数时打印用法", () => {
    expect(runCli([], out)).not.toBe(0);
    expect(text()).toContain("doctor");
  });

  it("CLI 不提供任何变更能力——用法里没有任何写操作命令", () => {
    runCli([], out);
    for (const verb of ["create", "delete", "remove", "run", "edit", "register"]) {
      expect(text().toLowerCase()).not.toContain(`grande ${verb}`);
    }
  });
});
