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

function initRepo(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@example.com");
  g(dir, "config", "user.name", "T");
  writeFileSync(join(dir, file), content, "utf8");
  g(dir, "add", ".");
  g(dir, "commit", "-q", "-m", "init");
}

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
  initRepo(repo, "a.ts", "v1\nexport const x = 1;\n");

  // D18：第二个已注册仓库——真实 git 仓库，不是伪造的注册表条目（见任务简报
  // 「Create a real git repo in the fixture workspace rather than faking the
  // registry」）。用来证明 grande_repo_edit 从 taskId 推导仓库这条路径是
  // behavioural 的：两个任务分别落在两个不同仓库的 worktree 里，互不可见。
  const other = join(layout.workspaceRoot, "other");
  initRepo(other, "b.ts", "w1\nexport const y = 1;\n");

  writeFileSync(
    layout.reposConfig,
    "repos:\n  - repoId: demo\n    registered: true\n  - repoId: other\n    registered: true\n",
    "utf8",
  );

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

  deps = { db, layout, defaultRepoId: "demo" };
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
});

describe("D18：repoId 参数只出现在该出现的地方（单一端点 + 任务绑定隔离）", () => {
  it("grande_task_open 要求 repoId——D18 下唯一一处由模型显式指定写入目标仓库", () => {
    const tool = buildTools(deps).find((t) => t.name === "grande_task_open")!;
    expect(tool.inputSchema.properties.repoId).toBeDefined();
    expect(tool.inputSchema.required).toContain("repoId");
  });

  it("grande_repo_map/grande_repo_search/grande_repo_read 接受可选 repoId（无 taskId 时的浏览）", () => {
    for (const name of ["grande_repo_map", "grande_repo_search", "grande_repo_read"]) {
      const tool = buildTools(deps).find((t) => t.name === name)!;
      expect(tool.inputSchema.properties.repoId, name).toBeDefined();
      expect(tool.inputSchema.required ?? [], name).not.toContain("repoId");
    }
  });

  it("grande_repo_edit / grande_run 不接受 repoId——仓库完全由 taskId 推导，模型无法自由指定写到哪个仓库", () => {
    for (const name of ["grande_repo_edit", "grande_run"]) {
      const tool = buildTools(deps).find((t) => t.name === name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {}), name).not.toContain("repoId");
    }
  });

  it("grande_diff / grande_task_status（带 taskId 时）/ grande_run_result 不接受 repoId——" +
     "它们要么恒需要 taskId（diff），要么已经从 taskId/jobId 反向查到 repo", () => {
    for (const name of ["grande_diff", "grande_run_result"]) {
      const tool = buildTools(deps).find((t) => t.name === name)!;
      expect(Object.keys(tool.inputSchema.properties ?? {}), name).not.toContain("repoId");
    }
  });
});

describe("D18：grande_task_open 的 repoId 校验（测试要求 2）", () => {
  it("未注册的 repoId 返回 REPO_NOT_REGISTERED，且【不在文件系统上创建任何 worktree】", async () => {
    const r = JSON.parse(await callTool("grande_task_open", {
      taskId: "task_ghost_repo", slug: "ghost", repoId: "does-not-exist",
    }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("REPO_NOT_REGISTERED");
    expect(existsSync(join(layout.worktreesRoot, "does-not-exist"))).toBe(false);
    expect(existsSync(join(layout.worktreesRoot, "does-not-exist", "task_ghost_repo"))).toBe(false);
  });

  it("已注册的 repoId 正常开出任务", async () => {
    const r = JSON.parse(await callTool("grande_task_open", {
      taskId: "task_other_open", slug: "open-other", repoId: "other",
    }));
    expect(r.ok).toBe(true);
    expect(r.data.branch).toContain("open-other");
    expect(existsSync(join(layout.worktreesRoot, "other", "task_other_open"))).toBe(true);
  });
});

describe("D18：两个任务落在两个不同仓库时互不可见（测试要求 3，核心 D18 属性）", () => {
  it("repo_edit 用 A 仓库任务的 taskId 只写进 A 仓库的 worktree，B 仓库的 worktree/canonical 完全不受影响" +
     "（断言文件系统，不只是返回值——这是行为性证明，不是形状断言）", async () => {
    const openDemo = JSON.parse(await callTool("grande_task_open", {
      taskId: "task_demo_x", slug: "demo-x", repoId: "demo",
    }));
    expect(openDemo.ok).toBe(true);
    const openOther = JSON.parse(await callTool("grande_task_open", {
      taskId: "task_other_x", slug: "other-x", repoId: "other",
    }));
    expect(openOther.ok).toBe(true);

    const demoWt = join(layout.worktreesRoot, "demo", "task_demo_x");
    const otherWt = join(layout.worktreesRoot, "other", "task_other_x");
    const demoCanonical = join(layout.workspaceRoot, "demo");
    const otherCanonical = join(layout.workspaceRoot, "other");

    const editDemo = JSON.parse(await callTool("grande_repo_edit", {
      taskId: "task_demo_x",
      ops: [{ op: "create", path: "only-in-demo.ts", content: "export const onlyDemo = 1;\n" }],
    }));
    expect(editDemo.ok).toBe(true);

    const editOther = JSON.parse(await callTool("grande_repo_edit", {
      taskId: "task_other_x",
      ops: [{ op: "create", path: "only-in-other.ts", content: "export const onlyOther = 1;\n" }],
    }));
    expect(editOther.ok).toBe(true);

    // demo 任务写的文件只出现在 demo 的 worktree
    expect(existsSync(join(demoWt, "only-in-demo.ts"))).toBe(true);
    expect(existsSync(join(otherWt, "only-in-demo.ts"))).toBe(false);
    expect(existsSync(join(demoCanonical, "only-in-demo.ts"))).toBe(false);
    expect(existsSync(join(otherCanonical, "only-in-demo.ts"))).toBe(false);

    // other 任务写的文件只出现在 other 的 worktree
    expect(existsSync(join(otherWt, "only-in-other.ts"))).toBe(true);
    expect(existsSync(join(demoWt, "only-in-other.ts"))).toBe(false);
    expect(existsSync(join(demoCanonical, "only-in-other.ts"))).toBe(false);
    expect(existsSync(join(otherCanonical, "only-in-other.ts"))).toBe(false);
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

describe("只读工具的 taskId/repoId 参数（BUG 1 关联决定 + D18 扩展）", () => {
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

  it("显式 repoId（不带 taskId）能浏览到另一个已注册仓库的 canonical——demo 端点的默认仓库不会泄漏进来", async () => {
    const r = JSON.parse(await callTool("grande_repo_read", { path: "b.ts", repoId: "other" }));
    expect(r.ok).toBe(true);
    expect(r.data.content).toContain("w1");
  });

  it("测试要求 4：taskId 与 repoId 同时给出且【冲突】时被拒绝，不静默择一", async () => {
    const r = JSON.parse(await callTool("grande_repo_map", { taskId: "task_abcd", repoId: "other" }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toMatch(/repoId|taskId/);
  });

  it("taskId 与 repoId 同时给出但【一致】时正常放行（不误伤）", async () => {
    const r = JSON.parse(await callTool("grande_repo_map", { taskId: "task_abcd", repoId: "demo" }));
    expect(r.ok).toBe(true);
  });

  it("既没有 taskId 也没有 repoId，且没有端点默认仓库时，报错里列出已注册仓库", async () => {
    const bareDeps: ToolDeps = { db: deps.db, layout };
    const tool = buildTools(bareDeps).find((t) => t.name === "grande_repo_map")!;
    const r = (await tool.handler({})).structuredContent as { ok: boolean; error: { code: string; message: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toContain("demo");
    expect(r.error.message).toContain("other");
  });
});

describe("D18：grande_task_status 的无参数发现形式（注册表可见性）", () => {
  it("不带 taskId 调用时返回已注册仓库列表与活跃任务列表", async () => {
    const r = JSON.parse(await callTool("grande_task_status", {}));
    expect(r.ok).toBe(true);
    expect(r.data.registeredRepos).toEqual(["demo", "other"]);
    expect(Array.isArray(r.data.activeTasks)).toBe(true);
    expect(r.data.activeTasks.some((t: { taskId: string }) => t.taskId === "task_abcd")).toBe(true);
    expect(r.hint).toContain("demo");
  });

  it("带 taskId 时行为与此前一致（详情，不是总览）", async () => {
    const r = JSON.parse(await callTool("grande_task_status", { taskId: "task_abcd" }));
    expect(r.ok).toBe(true);
    expect(r.data.taskId).toBe("task_abcd");
    expect(r.data.repoId).toBe("demo");
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
