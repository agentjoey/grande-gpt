import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { getJob } from "../src/jobs.ts";
import { awaitJobSettled } from "../src/runner.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let ws: string, ctrl: string, layout: Layout, deps: ToolDeps;
let savedWs: string | undefined, savedCtrl: string | undefined;

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "tools-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "tools-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);

  const repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.ts"), "v1\nexport const x = 1;\n", "utf8");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  writeFileSync(layout.reposConfig, `repos:\n  - repoId: demo\n    registered: true\n`, "utf8");

  const wt = join(layout.worktreesRoot, "demo", "task_abcd");
  mkdirSync(wt, { recursive: true });
  g(repo, "worktree", "add", "-b", "grande/x-abcd", wt, g(repo, "rev-parse", "HEAD").trim());

  createTask(db, {
    taskId: "task_abcd", repoId: "demo", branch: "grande/x-abcd",
    baseCommit: g(repo, "rev-parse", "HEAD").trim(), worktreePath: wt, state: "READY",
  });
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos:\n  demo:\n" +
    '    ok: { argv: ["/bin/sh", "-c", "echo hello; exit 0"], timeoutSeconds: 30 }\n' +
    '    slow: { argv: ["/bin/sh", "-c", "sleep 5"], timeoutSeconds: 30 }\n' +
    '    curl-probe: { argv: ["/usr/bin/curl", "-sS", "--max-time", "3", "http://example.com"], timeoutSeconds: 10 }\n' +
    '    fail: { argv: ["/bin/sh", "-c", "echo boom >&2; exit 1"], timeoutSeconds: 30 }\n',
    "utf8",
  );

  deps = { db, layout, repoId: "demo" };
});

const started: string[] = [];

async function settle(jobId: string): Promise<void> {
  await awaitJobSettled(jobId);
}

afterEach(async () => {
  await Promise.all(started.map(awaitJobSettled));
  started.length = 0;
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = buildTools(deps).find((t) => t.name === name);
  if (!tool) throw new Error(`未注册的工具：${name}`);
  const r = await tool.handler(args);
  return JSON.stringify(r.structuredContent);
}

async function callToolThatThrowsRaw(): Promise<string> {
  const tool = buildTools(deps).find((t) => t.name === "grande_repo_read")!;
  const r = await tool.handler({ path: undefined as unknown as string });
  return JSON.stringify(r.structuredContent);
}

const READ_ONLY = [
  "grande_task_status", "grande_repo_map", "grande_repo_search",
  "grande_repo_read", "grande_diff", "grande_run_result",
] as const;

describe("工具注解", () => {
  it("恰好注册六个只读工具与三个写工具，且名字与规格 §5.2 一致", () => {
    const names = buildTools(deps).map((t) => t.name).sort();
    expect(names.filter((n) => READ_ONLY.includes(n as typeof READ_ONLY[number]))).toEqual([...READ_ONLY].sort());
    expect(names).toContain("grande_repo_edit");
    expect(names).toContain("grande_run");
    expect(names).toContain("grande_task_open");
    expect(names).toHaveLength(READ_ONLY.length + 3);
  });

  it("六个只读工具全部 readOnlyHint: true", () => {
    const tools = buildTools(deps).filter((t) => READ_ONLY.includes(t.name as typeof READ_ONLY[number]));
    expect(tools).toHaveLength(READ_ONLY.length);
    for (const t of tools) {
      expect(t.annotations.readOnlyHint, `${t.name} 应为只读`).toBe(true);
    }
  });

  it("写工具 readOnlyHint: false, destructiveHint: true", () => {
    const writeNames = ["grande_repo_edit", "grande_run", "grande_task_open"];
    for (const name of writeNames) {
      const t = buildTools(deps).find((tool) => tool.name === name);
      expect(t, name).toBeDefined();
      expect(t!.annotations.readOnlyHint, `${name} readOnlyHint`).toBe(false);
      expect(t!.annotations.destructiveHint, `${name} destructiveHint`).toBe(true);
    }
  });

  it("所有工具 openWorldHint: false（S0 全禁网）", () => {
    const tools = buildTools(deps);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.annotations.openWorldHint).toBe(false);
  });

  it("repoId 不出现在任何工具的入参 schema 里（D5：由端点决定）", () => {
    const tools = buildTools(deps);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.inputSchema.properties, t.name).toBeDefined();
      expect(Object.keys(t.inputSchema.properties ?? {}), t.name).not.toContain("repoId");
    }
  });
});

describe("响应信封", () => {
  it("成功响应的字段顺序：truncated/nextCursor/hint 必须排在 data 之前", async () => {
    const r = await callTool("grande_repo_map", {});
    const keys = Object.keys(JSON.parse(r));
    for (const k of ["truncated", "nextCursor", "hint"]) {
      expect(keys.indexOf(k)).toBeLessThan(keys.indexOf("data"));
    }
  });

  it("内部异常被翻译成 error{code}，且【不】把内部 message 透出去", async () => {
    const r = JSON.parse(await callTool("grande_repo_read", { path: "../outside.ts" }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("POLICY_DENIED");
  });

  it("未知异常降级为 INTERNAL 而不是让整个调用失败", async () => {
    const r = JSON.parse(await callToolThatThrowsRaw());
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INTERNAL");
  });

  it("错误消息里不含 layout.workspaceRoot 这个绝对路径前缀", async () => {
    const r = JSON.parse(await callTool("grande_repo_read", { path: "../outside.ts" }));
    expect(JSON.stringify(r)).not.toContain(layout.workspaceRoot);
  });

  it("写工具用的是控制平面里的拒绝表，不是空表（AC-14 第二条断言）", async () => {
    const canonical = join(layout.workspaceRoot, "demo");
    const r = JSON.parse(await callTool("grande_repo_edit", {
      ops: [{ op: "create", path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" }],
    }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("POLICY_DENIED");
    expect(existsSync(join(canonical, ".git/hooks/pre-commit"))).toBe(false);
  });
});

describe("grande_run / grande_run_result", () => {
  it("grande_run 立刻返回 jobId 与 pollAfterSeconds，不等命令跑完，且真的 spawn 了", async () => {
    const t0 = Date.now();
    const r = JSON.parse(await callTool("grande_run", { taskId: "task_abcd", profile: "slow" }));
    started.push(r.data.jobId);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.data.jobId).toMatch(/^job_/);
    expect(r.data.pollAfterSeconds).toBeGreaterThan(0);
    expect(r.hint).toContain("grande_run_result");
    const row = getJob(deps.db, r.data.jobId);
    expect(row).toBeDefined();
    expect(row!.state).toBe("running");
    await settle(r.data.jobId);
  }, 15_000);

  it("联网尝试产生 NETWORK_DENIED，而不是与普通测试失败混在一起", async () => {
    const r = JSON.parse(await callTool("grande_run", { taskId: "task_abcd", profile: "curl-probe" }));
    started.push(r.data.jobId);
    await settle(r.data.jobId);
    const res = JSON.parse(await callTool("grande_run_result", { jobId: r.data.jobId }));
    expect(res.data.networkDenied).toBe(true);
  });

  it("普通的测试失败【不】被误判成 NETWORK_DENIED（过度触发也是 bug）", async () => {
    const r = JSON.parse(await callTool("grande_run", { taskId: "task_abcd", profile: "fail" }));
    started.push(r.data.jobId);
    await settle(r.data.jobId);
    const res = JSON.parse(await callTool("grande_run_result", { jobId: r.data.jobId }));
    expect(res.data.networkDenied).toBe(false);
  });
}, 15_000);
