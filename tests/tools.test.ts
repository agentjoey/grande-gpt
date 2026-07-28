import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("写工具 readOnlyHint: false，但 destructiveHint 必须是 false", () => {
    // 这条测试原本断言 destructiveHint 是 true——**它把 bug 钉成了规范**，
    // 于是六轮任务审查加一轮整支审查都没人发现实现与规格 §5.2 相反。
    // 真实后果：`Allow low-risk actions` 档下三个写工具被 ChatGPT 客户端全部拦掉，
    // 服务端连请求都收不到，审计账本零记录，模型只说一句「被禁用」。
    // 规格 §5.3 的原话是：S0 放弃删除文件，正是为了让写工具能诚实地保持
    // destructive: false（标 true 会每次弹框且无法「记住」）。
    const writeNames = ["grande_repo_edit", "grande_run", "grande_task_open"];
    for (const name of writeNames) {
      const t = buildTools(deps).find((tool) => tool.name === name);
      expect(t, name).toBeDefined();
      expect(t!.annotations.readOnlyHint, `${name} readOnlyHint`).toBe(false);
      expect(t!.annotations.destructiveHint, `${name} destructiveHint`).toBe(false);
    }
  });

  it("所有工具 openWorldHint: false（S0 全禁网）", () => {
    const tools = buildTools(deps);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.annotations.openWorldHint).toBe(false);
  });

  it("grande_run 的 schema 描述里带着至少一个已注册的 profile 名字（BUG 4：此前模型只能猜，" +
     "猜错了才从报错里第一次看到可选列表，多花一轮工具调用）", () => {
    const tool = buildTools(deps).find((t) => t.name === "grande_run")!;
    const profileProp = tool.inputSchema.properties.profile as { description?: string } | undefined;
    const haystack = tool.description + " " + (profileProp?.description ?? "");
    // fixture 在 beforeEach 里注册了 ok/slow/curl-probe/fail 四个 profile
    expect(haystack).toMatch(/\bok\b|\bslow\b|curl-probe|\bfail\b/);
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
    // BUG 1 修复后 grande_repo_edit 必须带 taskId、写入 worktree —— 拒绝表照样要挡住，
    // 不管写入目标是 canonical 还是 worktree，两边都不能出现被拒的文件。
    const canonical = join(layout.workspaceRoot, "demo");
    const worktree = join(layout.worktreesRoot, "demo", "task_abcd");
    const r = JSON.parse(await callTool("grande_repo_edit", {
      taskId: "task_abcd",
      ops: [{ op: "create", path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" }],
    }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("POLICY_DENIED");
    expect(existsSync(join(canonical, ".git/hooks/pre-commit"))).toBe(false);
    expect(existsSync(join(worktree, ".git/hooks/pre-commit"))).toBe(false);
  });
});

describe("grande_repo_edit 写入隔离（BUG 1：此前无条件写 canonical，忽略 taskId）", () => {
  it("带合法 taskId 时写进该任务的 worktree，canonical 完全不受影响（断言文件系统，不只是返回值）", async () => {
    const canonical = join(layout.workspaceRoot, "demo");
    const worktree = join(layout.worktreesRoot, "demo", "task_abcd");
    const r = JSON.parse(await callTool("grande_repo_edit", {
      taskId: "task_abcd",
      ops: [{ op: "create", path: "greet.ts", content: "export const greet = () => 'hi';\n" }],
    }));
    expect(r.ok).toBe(true);
    // 落在 worktree 里
    expect(existsSync(join(worktree, "greet.ts"))).toBe(true);
    expect(readFileSync(join(worktree, "greet.ts"), "utf8")).toContain("greet");
    // canonical（用户正在用编辑器干活的那份 checkout）完全没有这个文件——
    // 这正是 D4 原地模型的核心承诺，写错根会直接破坏它。
    expect(existsSync(join(canonical, "greet.ts"))).toBe(false);
  });

  it("不带 taskId 时被 schema 拒绝：inputSchema.required 必须包含 taskId（旧文案曾把它标成可选，误导模型漏传）", () => {
    const tool = buildTools(deps).find((t) => t.name === "grande_repo_edit")!;
    expect(tool.inputSchema.required).toContain("taskId");
    expect(tool.inputSchema.required).toContain("ops");
  });

  it("未知 taskId 时返回 TASK_NOT_FOUND，且不在任何地方创建文件", async () => {
    const canonical = join(layout.workspaceRoot, "demo");
    const r = JSON.parse(await callTool("grande_repo_edit", {
      taskId: "task_does_not_exist",
      ops: [{ op: "create", path: "ghost.ts", content: "x" }],
    }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("TASK_NOT_FOUND");
    expect(existsSync(join(canonical, "ghost.ts"))).toBe(false);
    expect(existsSync(join(layout.worktreesRoot, "demo", "task_does_not_exist", "ghost.ts"))).toBe(false);
  });
});

describe("只读工具的 taskId 参数（BUG 1 关联决定：带 taskId 时读 worktree，不带时读 canonical）", () => {
  it("grande_repo_read 带 taskId 时能读到只写进 worktree 的文件；不带 taskId 时读不到（canonical 没有它）", async () => {
    const worktree = join(layout.worktreesRoot, "demo", "task_abcd");
    writeFileSync(join(worktree, "wt-only.ts"), "export const onlyInWorktree = 1;\n", "utf8");

    const withTask = JSON.parse(await callTool("grande_repo_read", { path: "wt-only.ts", taskId: "task_abcd" }));
    expect(withTask.ok).toBe(true);
    expect(withTask.data.content).toContain("onlyInWorktree");

    const withoutTask = JSON.parse(await callTool("grande_repo_read", { path: "wt-only.ts" }));
    expect(withoutTask.ok).toBe(false);
    expect(withoutTask.error.code).toBe("INVALID_INPUT"); // FILE_NOT_FOUND 映射到 INVALID_INPUT，见 errors.ts
  });

  it("grande_repo_map/grande_repo_search 带未知 taskId 时返回 TASK_NOT_FOUND", async () => {
    const mapR = JSON.parse(await callTool("grande_repo_map", { taskId: "task_ghost" }));
    expect(mapR.ok).toBe(false);
    expect(mapR.error.code).toBe("TASK_NOT_FOUND");

    const searchR = JSON.parse(await callTool("grande_repo_search", { pattern: "x", taskId: "task_ghost" }));
    expect(searchR.ok).toBe(false);
    expect(searchR.error.code).toBe("TASK_NOT_FOUND");
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

describe("工具注解必须逐字匹配规格 §5.2 那张表", () => {
  /**
   * 规格 §5.2 明确规定了每个工具的 readOnlyHint 与 destructiveHint。
   *
   * 这一条不是形式主义：ChatGPT 的 per-app 权限档【就是按注解放行的】。
   * 三个写工具曾被实现成 destructiveHint: true，结果在 `Allow low-risk actions`
   * 档下全部被客户端拦掉——ChatGPT 只说「被禁用」，服务端日志里连请求都看不到，
   * 审计账本零记录。整整两轮真实测试才定位到。
   *
   * 而且 §5.3 说得很清楚：S0 之所以【放弃删除文件】，就是为了让 repo_edit 能
   * 诚实地保持 destructive: false（标 true 会导致每次弹框且无法「记住」）。
   * 把它标成 true 等于代价照付、好处没拿到。
   */
  const SPEC: Record<string, { readOnly: boolean; destructive: boolean }> = {
    grande_task_open:   { readOnly: false, destructive: false },
    grande_task_status: { readOnly: true,  destructive: false },
    grande_repo_map:    { readOnly: true,  destructive: false },
    grande_repo_search: { readOnly: true,  destructive: false },
    grande_repo_read:   { readOnly: true,  destructive: false },
    grande_repo_edit:   { readOnly: false, destructive: false },
    grande_diff:        { readOnly: true,  destructive: false },
    grande_run:         { readOnly: false, destructive: false },
    grande_run_result:  { readOnly: true,  destructive: false },
  };

  it("九个工具的注解与规格逐项一致", () => {
    const tools = buildTools(deps);
    expect(tools).toHaveLength(Object.keys(SPEC).length);
    for (const t of tools) {
      const want = SPEC[t.name];
      expect(want, `${t.name} 不在规格 §5.2 的表里`).toBeDefined();
      expect(t.annotations.readOnlyHint, `${t.name}.readOnlyHint`).toBe(want!.readOnly);
      expect(t.annotations.destructiveHint, `${t.name}.destructiveHint`).toBe(want!.destructive);
      expect(t.annotations.openWorldHint, `${t.name}.openWorldHint（S0 全禁网）`).toBe(false);
    }
  });

  it("S0 没有任何工具标 destructiveHint: true（§5.3 的代价换来的）", () => {
    const bad = buildTools(deps).filter((t) => t.annotations.destructiveHint);
    expect(bad.map((t) => t.name)).toEqual([]);
  });
});
