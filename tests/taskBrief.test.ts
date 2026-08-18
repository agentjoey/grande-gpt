import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { getTask } from "../src/tasks.ts";
import { getTaskBrief, normalizeTaskBrief, saveTaskBrief } from "../src/taskBrief.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
let deps: ToolDeps;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "README.md"), "demo\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

const BRIEF = {
  source: { type: "bug_report", ref: "BUG-42" },
  request: "  修复登录失败  ",
  findings: ["  auth.ts 负责登录  "],
  plan: ["  增加失败回归测试  ", "修复 token 判定"],
  acceptanceCriteria: ["错误 token 被拒绝", "合法 token 继续通过"],
};

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "brief-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "brief-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  initRepo(join(layout.workspaceRoot, "demo"));
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
  deps = { db: openDb(layout), layout };
});

afterEach(() => {
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("TaskBrief", () => {
  it("normalizeTaskBrief 只保留五类入口并规范化文本", () => {
    for (const type of ["text", "github_issue", "markdown", "bug_report", "pr_feedback"] as const) {
      const brief = normalizeTaskBrief({ ...BRIEF, source: { type, ref: "  #12  " } });
      expect(brief.source).toEqual({ type, ref: "#12" });
      expect(brief.request).toBe("修复登录失败");
      expect(brief.findings).toEqual(["auth.ts 负责登录"]);
      expect(brief.plan).toEqual(["增加失败回归测试", "修复 token 判定"]);
    }
  });

  it("没有实际 plan 或 acceptance criteria 时拒绝，不让 TaskBrief 退化成 Requirement 系统", () => {
    expect(() => normalizeTaskBrief({ ...BRIEF, plan: [] })).toThrow(/plan/i);
    expect(() => normalizeTaskBrief({ ...BRIEF, acceptanceCriteria: [] })).toThrow(/acceptance/i);
    expect(() => normalizeTaskBrief({ ...BRIEF, source: { type: "epic" } })).toThrow(/source|入口|type/i);
  });

  it("brief 作为 Task 附属数据持久化并可恢复", () => {
    deps.db.prepare(
      `INSERT INTO task (taskId,repoId,branch,baseCommit,worktreePath,state,createdAt,updatedAt,stateVersion)
       VALUES (?,?,?,?,?,?,?,?,1)`,
    ).run("task_brief01", "demo", "grande/brief-0001", "abc", "/tmp/brief", "READY", Date.now(), Date.now());
    const savedBrief = saveTaskBrief(deps.db, "task_brief01", BRIEF);
    expect(getTaskBrief(deps.db, "task_brief01")).toEqual(savedBrief);
  });

  it("grande_task_open 接受 brief，grande_task_status 在后续调用中恢复同一份 plan/AC", async () => {
    const tools = buildTools(deps);
    const open = tools.find((tool) => tool.name === "grande_task_open")!;
    const status = tools.find((tool) => tool.name === "grande_task_status")!;

    const openEnvelope = (await open.handler({
      taskId: "task_s4brief01",
      slug: "s4-brief",
      repoId: "demo",
      brief: BRIEF,
    })).structuredContent as { ok: boolean; data?: { brief?: unknown } };
    expect(openEnvelope.ok).toBe(true);
    expect(openEnvelope.data?.brief).toEqual(normalizeTaskBrief(BRIEF));

    const statusEnvelope = (await status.handler({ taskId: "task_s4brief01" })).structuredContent as {
      ok: boolean;
      data?: { brief?: unknown };
    };
    expect(statusEnvelope.ok).toBe(true);
    expect(statusEnvelope.data?.brief).toEqual(normalizeTaskBrief(BRIEF));
  });

  it("invalid brief 在任何 task/worktree 副作用之前被拒绝", async () => {
    const open = buildTools(deps).find((tool) => tool.name === "grande_task_open")!;
    const envelope = (await open.handler({
      taskId: "task_s4bad01",
      slug: "s4-bad",
      repoId: "demo",
      brief: { ...BRIEF, plan: [] },
    })).structuredContent as { ok: boolean; error?: { code?: string; message?: string } };

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("INVALID_INPUT");
    expect(envelope.error?.message).toMatch(/plan/i);
    expect(getTask(deps.db, "task_s4bad01")).toBeUndefined();
  });
});
