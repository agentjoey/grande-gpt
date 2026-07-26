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

  it("--task 后面没有值时是用法错误，而不是静默当作「无过滤」", () => {
    // 悬空的 --task（后面没有值）曾经被 rest[taskIdx+1]===undefined 静默等同于
    // 「没传 --task」，于是列出全部 job——job_1 恰好也在无过滤结果里，看起来
    // 像是正常工作。真正的用法错误应该在到达 listJobs 之前就被挡下。
    expect(runCli(["jobs", "--task"], out)).not.toBe(0);
    expect(text()).not.toContain("job_1");
    expect(text()).toContain("--task");
  });
});

describe("grande audit", () => {
  it("列出审计流水：opId、工具、决策、状态", () => {
    expect(runCli(["audit"], out)).toBe(0);
    expect(text()).toContain("grande_repo_edit");
    expect(text()).toContain("ALLOWED");
    expect(text()).toContain("SUCCEEDED");
  });

  it("--task 指向不存在的任务时给出提示且退出码非零，而不是假的「没有审计记录」", () => {
    // grande jobs --task <bad-id> 一直能正确报错（先调用 getTask），但 cmdAudit
    // 从不做这个存在性检查，直接把「查无此任务」和「这个任务真的没有审计记录」
    // 渲染成同一句话——对着一个打错的 task id，人会误以为一切正常。
    expect(runCli(["audit", "--task", "nope"], out)).toBe(1);
    expect(text()).toContain("任务不存在：nope");
    expect(text()).not.toContain("没有审计记录");
  });

  it("--task 后面没有值时是用法错误，而不是静默当作「无过滤」", () => {
    expect(runCli(["audit", "--task"], out)).not.toBe(0);
    expect(text()).not.toContain("grande_repo_edit");
    expect(text()).toContain("--task");
  });

  it("DENIED 且带 reason 的记录：输出中包含「原因：」与具体原因文本", () => {
    const l = loadLayout();
    const db = openDb(l);
    const h = beginAudit(db, { taskId: "task_abc", tool: "grande_repo_edit", input: { path: "denied.ts" } });
    h.denied("路径越权：越过了仓库边界");
    db.close();

    lines = [];
    expect(runCli(["audit"], out)).toBe(0);
    const t = text();
    expect(t).toContain("DENIED");
    expect(t).toContain("原因：");
    expect(t).toContain("路径越权：越过了仓库边界");
  });
});

describe("停在 INTENT/EXECUTING 的审计记录（崩溃或中断的痕迹）", () => {
  it("audit 给出 ⚠️ 警告块，且未终结记录的 decision 显示为 PENDING", () => {
    // beforeEach 里唯一的审计行走完了 ALLOWED → EXECUTING → SUCCEEDED 全程，
    // listUnfinishedAudit 永远是空的——cmdAudit 的 ⚠️ 警告块和 PENDING 这个
    // decision 取值因此从未被任何自动化测试真正跑到过。这里现造一条只调用了
    // beginAudit、什么都不推进的行（停在 INTENT，decision 仍是 PENDING）。
    const l = loadLayout();
    const db = openDb(l);
    beginAudit(db, { taskId: "task_abc", tool: "grande_repo_edit", input: { path: "stuck-intent.ts" } });
    db.close();

    lines = [];
    expect(runCli(["audit"], out)).toBe(0);
    const t = text();
    expect(t).toContain("⚠️");
    expect(t).toContain("停在 INTENT/EXECUTING");
    expect(t).toContain("PENDING");
  });

  it("doctor 的「审计完整性」检查在有未完成记录时失败，退出码非零", () => {
    const l = loadLayout();
    const db = openDb(l);
    const h = beginAudit(db, { taskId: "task_abc", tool: "grande_repo_edit", input: { path: "stuck-executing.ts" } });
    h.allowed();
    h.executing();
    db.close();

    lines = [];
    expect(runCli(["doctor"], out)).not.toBe(0);
    const t = text();
    expect(t).toContain("✗ 审计完整性");
    expect(t).toContain("停在 INTENT/EXECUTING");
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

describe("GRANDE_WORKSPACE 缺失时干净失败（而不是抛出裸异常）", () => {
  // withDb 曾经直接调用 loadLayout() 不做任何错误处理——任何失败（未设置/非
  // 绝对路径/目录不存在）都会作为未捕获异常逃出 cmdStatus/cmdJobs/cmdAudit，
  // 一路逃出 runCli，绕过 out 回调、也不返回退出码，违反 runCli 自己文档化的
  // @returns 契约。cmdDoctor 在同一个文件里已经干净地处理了同样的条件；这三
  // 个测试确认另外三个子命令现在也一样干净。

  it("grande status：不抛出，给出清晰消息且退出码非零", () => {
    delete process.env.GRANDE_WORKSPACE;
    let code!: number;
    expect(() => {
      code = runCli(["status"], out);
    }).not.toThrow();
    expect(code).not.toBe(0);
    expect(text()).toContain("GRANDE_WORKSPACE");
    expect(text()).toContain("未设置");
  });

  it("grande jobs：不抛出，给出清晰消息且退出码非零", () => {
    delete process.env.GRANDE_WORKSPACE;
    let code!: number;
    expect(() => {
      code = runCli(["jobs"], out);
    }).not.toThrow();
    expect(code).not.toBe(0);
    expect(text()).toContain("GRANDE_WORKSPACE");
    expect(text()).toContain("未设置");
  });

  it("grande audit：不抛出，给出清晰消息且退出码非零", () => {
    delete process.env.GRANDE_WORKSPACE;
    let code!: number;
    expect(() => {
      code = runCli(["audit"], out);
    }).not.toThrow();
    expect(code).not.toBe(0);
    expect(text()).toContain("GRANDE_WORKSPACE");
    expect(text()).toContain("未设置");
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
