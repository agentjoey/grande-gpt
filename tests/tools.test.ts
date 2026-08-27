import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask, getTask } from "../src/tasks.ts";
import { createJob, finishJob, getJob } from "../src/jobs.ts";
import { awaitJobSettled } from "../src/runner.ts";
import { listAudit } from "../src/audit.ts";
import { RUN_BOUNDED_WAIT_MS } from "../src/flowSimplification.ts";
import { buildTools, TOOLSET_EPOCH, toolsetIdentity, type ToolDeps } from "../src/tools.ts";
import { MCP_WRITE_TOOLS } from "../src/contract.ts";
import {
  MAX_MCP_TOOL_RESULT_BYTES,
  mcpToolResultByteLength,
  toMcpTextResult,
} from "../src/mcpToolResult.ts";

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
    '    slow: { argv: ["/bin/sh", "-c", "sleep 6"], timeoutSeconds: 30 }\n' +
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
  return JSON.stringify(await callToolEnvelope(name, args));
}

async function callToolEnvelope(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = buildTools(deps).find((t) => t.name === name);
  if (!tool) throw new Error(`未注册的工具：${name}`);
  const r = await tool.handler(args);
  return r.structuredContent;
}

async function callToolThatThrowsRaw(): Promise<string> {
  const tool = buildTools(deps).find((t) => t.name === "grande_repo_read")!;
  const r = await tool.handler({ path: undefined as unknown as string });
  return JSON.stringify(r.structuredContent);
}

const READ_ONLY = [
  "grande_task_status", "grande_repo_map", "grande_repo_search",
  "grande_repo_read", "grande_diff", "grande_run_result",
  "grande_capability_list", "grande_capability_inspect", "grande_pr_status",
  "grande_repo_add_propose",
] as const;

const OPEN_WORLD = [
  "grande_task_open", "grande_push", "grande_pr_open",
  "grande_capability_list", "grande_capability_inspect", "grande_capability_invoke",
  "grande_pr_status", "grande_pr_merge",
  "grande_deploy", "grande_deploy_verify", "grande_deploy_rollback",
] as const;

const DESTRUCTIVE = [
  "grande_task_close",
  "grande_capability_invoke",
  "grande_pr_merge",
  "grande_deploy",
  "grande_deploy_rollback",
] as const;

describe("工具注解", () => {
  it("当前 contract 恰好注册 25 个工具：10 只读 + 15 写；onboarding 只新增 propose/apply 两只本地工具", () => {
    const names = buildTools(deps).map((t) => t.name).sort();
    expect(names.filter((n) => READ_ONLY.includes(n as typeof READ_ONLY[number]))).toEqual([...READ_ONLY].sort());
    for (const name of [
      "grande_repo_edit", "grande_rollback", "grande_run", "grande_task_open", "grande_task_close",
      "grande_commit", "grande_sync_base", "grande_push", "grande_pr_open",
      "grande_capability_invoke", "grande_pr_merge",
      "grande_deploy", "grande_deploy_verify", "grande_deploy_rollback",
      "grande_repo_add_apply",
    ]) expect(names).toContain(name);
    expect(names).toHaveLength(25);
    expect(names.length - READ_ONLY.length).toBe(15);
  });

  it("共享 MCP_WRITE_TOOLS 与运行时全部写工具严格一致，审计/控制台不会漏掉后加工具", () => {
    const runtimeWriteTools = buildTools(deps)
      .filter((tool) => !tool.annotations.readOnlyHint)
      .map((tool) => tool.name)
      .sort();
    expect([...MCP_WRITE_TOOLS].sort()).toEqual(runtimeWriteTools);
  });

  it("十个只读工具全部 readOnlyHint: true", () => {
    const tools = buildTools(deps).filter((t) => READ_ONLY.includes(t.name as typeof READ_ONLY[number]));
    expect(tools).toHaveLength(READ_ONLY.length);
    for (const t of tools) {
      expect(t.annotations.readOnlyHint, `${t.name} 应为只读`).toBe(true);
    }
  });

  it("destructiveHint=true 的工具必须严格等于五个高风险动作，不能悄悄扩散", () => {
    const actual = buildTools(deps)
      .filter((tool) => tool.annotations.destructiveHint)
      .map((tool) => tool.name)
      .sort();
    expect(actual).toEqual([...DESTRUCTIVE].sort());
  });

  it("openWorldHint=true 的工具必须严格等于当前十一个触网/外部能力工具", () => {
    const tools = buildTools(deps);
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.annotations.openWorldHint, `${t.name}.openWorldHint`)
        .toBe(OPEN_WORLD.includes(t.name as typeof OPEN_WORLD[number]));
    }
    for (const n of OPEN_WORLD) expect(tools.map((t) => t.name)).toContain(n);
  });

  it("grande_run 的 schema 描述里带着至少一个已注册的 profile 名字（BUG 4：此前模型只能猜，" +
     "猜错了才从报错里第一次看到可选列表，多花一轮工具调用）", () => {
    const tool = buildTools(deps).find((t) => t.name === "grande_run")!;
    const profileProp = tool.inputSchema.properties.profile as { description?: string } | undefined;
    const haystack = tool.description + " " + (profileProp?.description ?? "");
    expect(haystack).toMatch(/\bok\b|\bslow\b|curl-probe|\bfail\b/);
  });

  it("repo_read/repo_search 描述明确给出默认值、硬上限与搜索结果字节预算，且 epoch 仍为 2", () => {
    const tools = buildTools(deps);
    const read = tools.find((t) => t.name === "grande_repo_read")!;
    const search = tools.find((t) => t.name === "grande_repo_search")!;

    expect(read.description).toMatch(/16\s*KiB.*24\s*KiB/s);
    expect(search.description).toMatch(/20.*25.*16\s*KiB/s);
    expect(TOOLSET_EPOCH).toBe(2);
  });

  it("assembled tool contract 保持 GG-BL-028 stabilized contract digest", () => {
    const assembled = buildTools(deps);
    const pinnedDigest = "sha256:7f2390e540b4311f9e3f70b890239460bf0c63e770e3c2e45f227dac41dcb7da";
    expect(toolsetIdentity(assembled, "db5d020-test-build")).toEqual({
      gatewayBuild: "db5d020-test-build",
      toolsetEpoch: 2,
      toolsCount: 25,
      toolsDigest: pinnedDigest,
    });

    const schemaDrift = assembled.map((tool) => ({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
      annotations: { ...tool.annotations },
    }));
    const read = schemaDrift.find((tool) => tool.name === "grande_repo_read")!;
    (read.inputSchema.properties.maxBytes as { description: string }).description += " drift";
    expect(toolsetIdentity(schemaDrift, "db5d020-test-build").toolsDigest).not.toBe(pinnedDigest);

    const annotationDrift = assembled.map((tool) => ({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
      annotations: { ...tool.annotations },
    }));
    annotationDrift[0]!.annotations.readOnlyHint = !annotationDrift[0]!.annotations.readOnlyHint;
    expect(toolsetIdentity(annotationDrift, "db5d020-test-build").toolsDigest).not.toBe(pinnedDigest);
  });

  it("真实 handler 的代表性结果保持 32 KiB 内，且 canonical wire 比 legacy 重复编码至少小 30%", async () => {
    const MAX_CANONICAL_SHARE_OF_LEGACY = 0.70;
    const worktree = join(layout.worktreesRoot, "demo", "task_abcd");
    writeFileSync(
      join(worktree, "wire-budget.ts"),
      Array.from({ length: 320 }, (_, line) =>
        `export const wireBudget${line} = "${"x".repeat(72)}";`,
      ).join("\n"),
      "utf8",
    );

    createJob(deps.db, {
      jobId: "job_wire_budget", taskId: "task_abcd", profile: "ok",
      argv: ["/bin/sh", "-c", "echo wire-budget"], pgid: null,
    });
    finishJob(deps.db, "job_wire_budget", {
      state: "passed", exitCode: 0, artifactPath: null,
      summary: { durationMs: 125, peakRssMb: 18, outputTruncated: false, killedBy: null },
    });

    const envelopes = await Promise.all([
      callToolEnvelope("grande_repo_read", { path: "wire-budget.ts", taskId: "task_abcd" }),
      callToolEnvelope("grande_repo_search", {
        pattern: "wireBudget", maxMatches: 25, taskId: "task_abcd",
      }),
      callToolEnvelope("grande_run_result", { jobId: "job_wire_budget" }),
      callToolEnvelope("grande_repo_read", { path: "missing-wire-budget.ts", taskId: "task_abcd" }),
    ]);

    const canonicalResults = envelopes.map(toMcpTextResult);
    const canonicalBytes = canonicalResults.map(mcpToolResultByteLength);
    const legacyBytes = envelopes.map((envelope, index) =>
      Buffer.byteLength(JSON.stringify({
        ...canonicalResults[index],
        structuredContent: envelope,
      }), "utf8")
    );

    expect(envelopes.map((envelope) => (envelope as { ok?: boolean }).ok)).toEqual([true, true, true, false]);
    for (const bytes of canonicalBytes) expect(bytes).toBeLessThanOrEqual(MAX_MCP_TOOL_RESULT_BYTES);

    const combinedCanonicalBytes = canonicalBytes.reduce((total, bytes) => total + bytes, 0);
    const combinedLegacyBytes = legacyBytes.reduce((total, bytes) => total + bytes, 0);
    expect(combinedCanonicalBytes).toBeLessThanOrEqual(
      Math.floor(combinedLegacyBytes * MAX_CANONICAL_SHARE_OF_LEGACY),
    );
  });

  it("repo_read 只返回完整行，用 nextLine 续读到 EOF 可逐字节重建原文", async () => {
    const worktree = join(layout.worktreesRoot, "demo", "task_abcd");
    const full = Array.from({ length: 300 }, (_, i) => `${String(i + 1).padStart(3, "0")}:${"x".repeat(96)}`).join("\n");
    writeFileSync(join(worktree, "budget.ts"), full, "utf8");

    const r = JSON.parse(await callTool("grande_repo_read", { path: "budget.ts", taskId: "task_abcd" }));

    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.data.lastLineTruncated).toBe(false);
    expect(r.data.content.endsWith("\n")).toBe(true);
    expect(r.data.nextLine).toBe(163);
    expect(r.hint).toContain(
      'grande_repo_read({"path":"budget.ts","lineRange":[163,300],"maxBytes":16384,"taskId":"task_abcd"})',
    );

    const last = JSON.parse(await callTool("grande_repo_read", {
      path: "budget.ts", lineRange: [r.data.nextLine, 300], taskId: "task_abcd",
    }));
    expect(last.ok).toBe(true);
    expect(last.truncated).toBe(true);
    expect(last.data.nextLine).toBeNull();
    expect(last.hint).not.toContain("grande_repo_read(");
    expect(last.hint).toMatch(/文件末尾|EOF/);
    expect(r.data.content + last.data.content).toBe(full);

    writeFileSync(join(worktree, "one-long-line.ts"), "x".repeat(20 * 1024), "utf8");
    const oneLine = JSON.parse(await callTool("grande_repo_read", {
      path: "one-long-line.ts", taskId: "task_abcd",
    }));
    expect(oneLine).toMatchObject({
      ok: false,
      taskId: "task_abcd",
      error: { code: "INVALID_INPUT" },
    });
    expect(oneLine.error.message).toMatch(/第 1 行.*20480.*maxBytes=16384.*完整行/s);
  });

  it("repo_read/repo_search 对越过硬上限的调用返回 INVALID_INPUT，不静默钳制", async () => {
    const read = JSON.parse(await callTool("grande_repo_read", { path: "a.ts", maxBytes: 24 * 1024 + 1 }));
    const search = JSON.parse(await callTool("grande_repo_search", { pattern: "v1", maxMatches: 26 }));

    expect(read.error.code).toBe("INVALID_INPUT");
    expect(search.error.code).toBe("INVALID_INPUT");
  });

  it("grande_repo_edit 的 description 与 JSON Schema 明确暴露 delete，且 expectedSha256 必填", () => {
    const tool = buildTools(deps).find((t) => t.name === "grande_repo_edit")!;
    const ops = tool.inputSchema.properties.ops as {
      description?: string;
      items?: { oneOf?: { properties?: { op?: { const?: string } }; required?: string[] }[] };
    };
    const haystack = `${tool.description} ${ops.description ?? ""}`;
    expect(haystack).toContain("delete");
    expect(haystack).toContain("expectedSha256");

    const variants = ops.items?.oneOf ?? [];
    const deleteVariant = variants.find((v) => v.properties?.op?.const === "delete");
    expect(deleteVariant).toBeDefined();
    expect(deleteVariant!.required).toEqual(expect.arrayContaining(["op", "path", "expectedSha256"]));
  });

  it("grande_rollback 的 taskId/checkpointId 必填，且 destructiveHint=false", () => {
    const tool = buildTools(deps).find((t) => t.name === "grande_rollback")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["taskId", "checkpointId"]));
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});

describe("D18：repoId 参数只出现在该出现的地方（单一端点 + 任务绑定隔离）", () => {
  it("grande_task_open 要求 repoId——D18 下唯一一处由模型显式指定 task-bound 写入目标仓库", () => {
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

  it("grande_repo_edit / grande_rollback / grande_run 不接受 repoId——仓库完全由 taskId 推导", () => {
    for (const name of ["grande_repo_edit", "grande_rollback", "grande_run"]) {
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

    expect(existsSync(join(demoWt, "only-in-demo.ts"))).toBe(true);
    expect(existsSync(join(otherWt, "only-in-demo.ts"))).toBe(false);
    expect(existsSync(join(demoCanonical, "only-in-demo.ts"))).toBe(false);
    expect(existsSync(join(otherCanonical, "only-in-demo.ts"))).toBe(false);

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

  it("必填参数漏传时降级成【点名字段的 INVALID_INPUT】，而不是让整个调用失败", async () => {
    const r = JSON.parse(await callToolThatThrowsRaw());
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toContain("path");
    expect(r.error.message).not.toContain("详情见服务端日志");
  });

  it("错误消息里不含 layout.workspaceRoot 这个绝对路径前缀", async () => {
    const r = JSON.parse(await callTool("grande_repo_read", { path: "../outside.ts" }));
    expect(JSON.stringify(r)).not.toContain(layout.workspaceRoot);
  });

  it("写工具用的是控制平面里的拒绝表，不是空表（AC-14 第二条断言）", async () => {
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
    expect(existsSync(join(worktree, "greet.ts"))).toBe(true);
    expect(readFileSync(join(worktree, "greet.ts"), "utf8")).toContain("greet");
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
    expect(withoutTask.error.code).toBe("INVALID_INPUT");
  });

  it("grande_repo_map/grande_repo_search 带未知 taskId 时返回 TASK_NOT_FOUND", async () => {
    const mapR = JSON.parse(await callTool("grande_repo_map", { taskId: "task_ghost" }));
    expect(mapR.ok).toBe(false);
    expect(mapR.error.code).toBe("TASK_NOT_FOUND");

    const searchR = JSON.parse(await callTool("grande_repo_search", { pattern: "x", taskId: "task_ghost" }));
    expect(searchR.ok).toBe(false);
    expect(searchR.error.code).toBe("TASK_NOT_FOUND");
  });

  it("存在 worktree 已丢失的活跃任务时，未知 task 仍返回 TASK_NOT_FOUND 而不是二次崩溃", async () => {
    createTask(deps.db, {
      taskId: "task_ghost_active",
      repoId: "demo",
      branch: "grande/ghost-active",
      baseCommit: g(join(layout.workspaceRoot, "demo"), "rev-parse", "HEAD").trim(),
      worktreePath: join(layout.worktreesRoot, "demo", "missing-task-ghost-active"),
      state: "READY",
    });

    const result = JSON.parse(await callTool("grande_repo_read", {
      taskId: "task_does_not_exist",
      path: "a.ts",
    }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("TASK_NOT_FOUND");
    expect(result.error.details.activeTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "task_ghost_active", filesChanged: null }),
    ]));
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
  it("grande_run 对超过 bounded wait 的长 job 返回稳定 jobId，而不是强行等到命令结束", async () => {
    const t0 = Date.now();
    const r = JSON.parse(await callTool("grande_run", { taskId: "task_abcd", profile: "slow" }));
    started.push(r.data.jobId);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(RUN_BOUNDED_WAIT_MS - 500);
    expect(elapsed).toBeLessThan(RUN_BOUNDED_WAIT_MS + 1500);
    expect(r.data.jobId).toMatch(/^job_/);
    expect(r.data.pollAfterSeconds).toBeGreaterThan(0);
    expect(r.data.state).toBe("running");
    expect(r.hint).toContain("grande_run_result");
    const row = getJob(deps.db, r.data.jobId);
    expect(row).toBeDefined();
    expect(row!.state).toBe("running");
    await settle(r.data.jobId);
  }, 15_000);

  it("grande_run 对短 job 在第一次调用里直接返回完整终态", async () => {
    const r = JSON.parse(await callTool("grande_run", { taskId: "task_abcd", profile: "ok" }));
    started.push(r.data.jobId);
    expect(r.ok).toBe(true);
    expect(r.data.state).toBe("passed");
    expect(r.data.terminalResult).toMatchObject({ state: "passed", exitCode: 0 });
    expect(r.data.boundedWaitMs).toBe(RUN_BOUNDED_WAIT_MS);
    expect(r.hint).toContain("已包含终态结果");
  });

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

  it("grande_run_result 在一次调用内等到 running fixture 转为终态", async () => {
    createJob(deps.db, {
      jobId: "job_waiting_result", taskId: "task_abcd", profile: "ok",
      argv: ["/bin/sh", "-c", "true"], pgid: 123,
    });
    const transition = new Promise<void>((resolve) => {
      setTimeout(() => {
        finishJob(deps.db, "job_waiting_result", {
          state: "passed", exitCode: 0, artifactPath: null, summary: null,
        });
        resolve();
      }, 25);
    });

    const result = JSON.parse(await callTool("grande_run_result", { jobId: "job_waiting_result" }));
    await transition;

    expect(result.ok).toBe(true);
    expect(result.data.state).toBe("passed");
    expect(result.data.exitCode).toBe(0);
  });

  it("等待 15 秒仍未结束时提示按 pollAfterSeconds 稍后再试", async () => {
    createJob(deps.db, {
      jobId: "job_wait_deadline", taskId: "task_abcd", profile: "slow",
      argv: ["/bin/sh", "-c", "sleep 30"], pgid: 123,
    });
    vi.useFakeTimers();
    try {
      const pending = callTool("grande_run_result", { jobId: "job_wait_deadline" });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = JSON.parse(await pending);

      expect(result.data.state).toBe("running");
      expect(result.hint).toContain("已等待 15 秒");
      expect(result.hint).toContain("pollAfterSeconds");
    } finally {
      vi.useRealTimers();
    }
  });

  it("初次读取 job 行解码失败时返回规范 INTERNAL 信封而不是 rejected promise", async () => {
    createJob(deps.db, {
      jobId: "job_bad_row", taskId: "task_abcd", profile: "ok",
      argv: ["/bin/sh", "-c", "true"], pgid: 123,
    });
    deps.db.prepare("UPDATE job SET argv = ? WHERE jobId = ?").run("{invalid-json", "job_bad_row");

    const result = JSON.parse(await callTool("grande_run_result", { jobId: "job_bad_row" }));

    expect(result).toEqual({
      ok: false,
      taskId: null,
      error: {
        code: "INTERNAL",
        message: "Gateway 内部错误。详情见服务端日志。",
        retryable: false,
        details: {},
      },
    });
  });
}, 15_000);

describe("工具注解必须逐字匹配当前 contract", () => {
  const SPEC: Record<string, { readOnly: boolean; destructive: boolean; openWorld?: true }> = {
    grande_task_open:         { readOnly: false, destructive: false, openWorld: true },
    grande_task_status:       { readOnly: true,  destructive: false },
    grande_repo_map:          { readOnly: true,  destructive: false },
    grande_repo_search:       { readOnly: true,  destructive: false },
    grande_repo_read:         { readOnly: true,  destructive: false },
    grande_repo_edit:         { readOnly: false, destructive: false },
    grande_repo_add_propose:  { readOnly: true,  destructive: false },
    grande_repo_add_apply:    { readOnly: false, destructive: false },
    grande_rollback:          { readOnly: false, destructive: false },
    grande_diff:              { readOnly: true,  destructive: false },
    grande_run:               { readOnly: false, destructive: false },
    grande_run_result:        { readOnly: true,  destructive: false },
    grande_task_close:        { readOnly: false, destructive: true  },
    grande_commit:            { readOnly: false, destructive: false },
    grande_sync_base:         { readOnly: false, destructive: false },
    grande_push:              { readOnly: false, destructive: false, openWorld: true },
    grande_pr_open:           { readOnly: false, destructive: false, openWorld: true },
    grande_capability_list:   { readOnly: true,  destructive: false, openWorld: true },
    grande_capability_inspect:{ readOnly: true, destructive: false, openWorld: true },
    grande_capability_invoke: { readOnly: false, destructive: true,  openWorld: true },
    grande_pr_status:         { readOnly: true,  destructive: false, openWorld: true },
    grande_pr_merge:          { readOnly: false, destructive: true,  openWorld: true },
    grande_deploy:            { readOnly: false, destructive: true,  openWorld: true },
    grande_deploy_verify:     { readOnly: false, destructive: false, openWorld: true },
    grande_deploy_rollback:   { readOnly: false, destructive: true,  openWorld: true },
  };

  it("每个工具的注解与规格逐项一致，且工具总数与规格表严格相等", () => {
    const tools = buildTools(deps);
    expect(tools).toHaveLength(Object.keys(SPEC).length);
    for (const t of tools) {
      const want = SPEC[t.name];
      expect(want, `${t.name} 不在规格表里`).toBeDefined();
      expect(t.annotations.readOnlyHint, `${t.name}.readOnlyHint`).toBe(want!.readOnly);
      expect(t.annotations.destructiveHint, `${t.name}.destructiveHint`).toBe(want!.destructive);
      expect(t.annotations.openWorldHint, `${t.name}.openWorldHint`).toBe(want!.openWorld === true);
    }
  });

  it("destructiveHint=true 的精确名单与高风险动作一致", () => {
    const actual = buildTools(deps)
      .filter((t) => t.annotations.destructiveHint)
      .map((t) => t.name)
      .sort();
    expect(actual).toEqual([...DESTRUCTIVE].sort());
  });
});

describe("grande_task_close", () => {
  const gitListWorktrees = (repoRoot: string): string[] =>
    execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));

  const gitListBranches = (repoRoot: string, pattern: string): string[] =>
    execFileSync("git", ["branch", "--list", pattern], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/^[+*]\s*/, ""));

  it("task_close 之后 worktree 目录在磁盘上消失，且 grande/* 分支也消失", async () => {
    const repo = join(layout.workspaceRoot, "demo");
    const worktree = join(layout.worktreesRoot, "demo", "task_abcd");

    expect(existsSync(worktree)).toBe(true);
    expect(gitListBranches(repo, "grande/*").some((b) => b === "grande/x-abcd")).toBe(true);

    const r = JSON.parse(await callTool("grande_task_close", { taskId: "task_abcd" }));
    expect(r.ok).toBe(true);

    expect(existsSync(worktree)).toBe(false);
    expect(gitListBranches(repo, "grande/*").some((b) => b === "grande/x-abcd")).toBe(false);
  });

  it("task_close 之后 task 行的 state 是 CLOSED", async () => {
    const r = JSON.parse(await callTool("grande_task_close", { taskId: "task_abcd" }));
    expect(r.ok).toBe(true);

    const row = getTask(deps.db, "task_abcd");
    expect(row!.state).toBe("CLOSED");
  });

  it("重复 close 幂等：第二次调用成功返回，不因 worktree 已不在而抛错", async () => {
    const r1 = JSON.parse(await callTool("grande_task_close", { taskId: "task_abcd" }));
    expect(r1.ok).toBe(true);

    const r2 = JSON.parse(await callTool("grande_task_close", { taskId: "task_abcd" }));
    expect(r2.ok).toBe(true);
    expect(r2.hint).toContain("此前已关闭");
  });

  it("有 job 在跑时拒绝，抛出 JOB_RUNNING，且 worktree 仍在磁盘上（拒绝必须无副作用）", async () => {
    const openR = JSON.parse(await callTool("grande_task_open", {
      taskId: "task_close_slow", slug: "close-slow", repoId: "demo",
    }));
    expect(openR.ok).toBe(true);

    const runR = JSON.parse(await callTool("grande_run", {
      taskId: "task_close_slow", profile: "slow",
    }));
    started.push(runR.data.jobId);

    const worktree = join(layout.worktreesRoot, "demo", "task_close_slow");
    expect(existsSync(worktree)).toBe(true);

    const closeR = JSON.parse(await callTool("grande_task_close", { taskId: "task_close_slow" }));
    expect(closeR.ok).toBe(false);
    expect(closeR.error.code).toBe("INVALID_INPUT");
    expect(closeR.error.message).toMatch(/在跑|job/);
    expect(existsSync(worktree)).toBe(true);
  }, 15_000);

  it("不存在的 taskId 返回 TASK_NOT_FOUND", async () => {
    const r = JSON.parse(await callTool("grande_task_close", { taskId: "task_does_not_exist" }));
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("TASK_NOT_FOUND");
  });

  it("task_close 写了审计账本（decision=ALLOWED 且 state 到达终态）", async () => {
    const r = JSON.parse(await callTool("grande_task_close", { taskId: "task_abcd" }));
    expect(r.ok).toBe(true);

    const rows = listAudit(deps.db, "task_abcd");
    const closeAudits = rows.filter((a) => a.tool === "grande_task_close");
    expect(closeAudits.length).toBeGreaterThanOrEqual(1);
    const a = closeAudits[0]!;
    expect(a.decision).toBe("ALLOWED");
    expect(a.state).toBe("SUCCEEDED");
    expect(a.pathsTouched.length).toBeGreaterThan(0);
  });

  it("task_close 注解保持 destructiveHint=true；常规本地写工具仍保持 false", () => {
    const tools = buildTools(deps);
    const tc = tools.find((t) => t.name === "grande_task_close")!;
    expect(tc.annotations.destructiveHint).toBe(true);

    for (const name of ["grande_repo_edit", "grande_rollback", "grande_run", "grande_task_open"]) {
      const t = tools.find((tool) => tool.name === name)!;
      expect(t.annotations.destructiveHint, `${name} destructiveHint`).toBe(false);
    }
  });
});
