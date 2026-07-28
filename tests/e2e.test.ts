import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { createJob, getJob, reconcileRunningJobs } from "../src/jobs.ts";
import { awaitJobSettled } from "../src/runner.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let ws: string, ctrl: string, layout: Layout, deps: ToolDeps;
let savedWs: string | undefined, savedCtrl: string | undefined;

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function sha256Of(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "e2e-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "e2e-ctl-"));
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
  writeFileSync(join(repo, "status.txt"), "FAIL\n", "utf8");
  writeFileSync(
    join(repo, "check-status.sh"),
    `#!/bin/sh
if [ -f '${repo}/status.txt' ]; then
  read line < '${repo}/status.txt'
  if [ "$line" = "PASS" ]; then
    echo "E2E CHECK PASSED" && exit 0
  else
    echo "E2E CHECK FAILED: status=$line" && exit 1
  fi
else
  echo "E2E CHECK FAILED: status file not found" && exit 1
fi`,
    "utf8",
  );
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");

  writeFileSync(layout.reposConfig, `repos:\n  - repoId: demo\n    registered: true\n`, "utf8");

  const wt = join(layout.worktreesRoot, "demo", "task_e2e");
  mkdirSync(wt, { recursive: true });
  g(repo, "worktree", "add", "-b", "grande/x-e2e", wt, g(repo, "rev-parse", "HEAD").trim());

  createTask(db, {
    taskId: "task_e2e", repoId: "demo", branch: "grande/x-e2e",
    baseCommit: g(repo, "rev-parse", "HEAD").trim(), worktreePath: wt, state: "READY",
  });

  const repoDir = repo;
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos:\n  demo:\n" +
    `    fail: { argv: ["/bin/sh", "-c", "echo boom >&2; exit 1"], timeoutSeconds: 30 }\n` +
    `    ok: { argv: ["/bin/sh", "-c", "echo hello; exit 0"], timeoutSeconds: 30 }\n` +
    `    check-e2e: { argv: ["/bin/sh", "${repoDir}/check-status.sh"], timeoutSeconds: 30 }\n`,
    "utf8",
  );

  deps = { db, layout, repoId: "demo" };
});

const started: string[] = [];

afterEach(async () => {
  await Promise.all(started.map(awaitJobSettled));
  started.length = 0;
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = buildTools(deps).find((t) => t.name === name);
  if (!tool) throw new Error(`未注册的工具：${name}`);
  const r = await tool.handler(args);
  return r.structuredContent as Record<string, unknown>;
}

/** 读取文件内容与 sha256，用于后续 modify 拿 expectedSha256 */
async function readFile(path: string): Promise<{ content: string; sha256: string }> {
  const r = await callTool("grande_repo_read", { path });
  const data = r.data as Record<string, unknown>;
  return { content: data.content as string, sha256: data.sha256 as string };
}

async function settle(jobId: string): Promise<void> {
  await awaitJobSettled(jobId);
}

describe("E2E：完整工具闭环", () => {
  it("task_open → repo_read → repo_edit → run → run_result（失败）→ repo_edit → run → run_result（通过）", async () => {
    // Step 1: task_open
    const r1 = await callTool("grande_task_open", { taskId: "task_e2e_new", slug: "e2e-loop" });
    expect(r1.ok).toBe(true);
    const taskId = (r1.taskId as string)!;
    expect(taskId).toBe("task_e2e_new");

    // Step 2: repo_read — read the initial status file
    const s2 = await readFile("status.txt");
    expect(s2.content).toContain("FAIL");

    // Step 3: repo_edit — modify a.ts using its sha256 for staleness check
    const aTs = await readFile("a.ts");
    const r3 = await callTool("grande_repo_edit", {
      ops: [
        { op: "modify", path: "a.ts", expectedSha256: aTs.sha256, content: "v2\nexport const x = 2;\n" },
      ],
      taskId,
    });
    expect(r3.ok).toBe(true);
    expect((r3.data as Record<string, unknown>).applied).toBeDefined();

    // Read back a.ts to confirm edit
    const r3b = await readFile("a.ts");
    expect(r3b.content).toContain("v2");

    // Step 4: run — check-e2e profile reads status.txt (still FAIL) and exits 1
    const r4 = await callTool("grande_run", { taskId, profile: "check-e2e" });
    expect(r4.ok).toBe(true);
    const jobId1 = (r4.data as Record<string, unknown>).jobId as string;
    expect(jobId1).toMatch(/^job_/);
    started.push(jobId1);

    // Step 5: run_result — verify the job failed (exit code ≠ 0)
    await settle(jobId1);
    const r5 = await callTool("grande_run_result", { jobId: jobId1 });
    // ok=true 对于 failed job 是正常的——job 本身成功跑完，只是命令 exit ≠ 0
    expect(r5.ok).toBe(true);
    const data5 = r5.data as Record<string, unknown>;
    expect(data5.state).toBe("failed");
    expect(data5.exitCode).toBe(1);
    expect(data5.networkDenied).toBe(false);
    const jobState5 = getJob(deps.db, jobId1);
    expect(jobState5!.state).toBe("failed");
    expect(jobState5!.exitCode).toBe(1);

    // Step 6: repo_edit — fix status.txt from FAIL → PASS
    const st = await readFile("status.txt");
    const r6 = await callTool("grande_repo_edit", {
      ops: [{ op: "modify", path: "status.txt", expectedSha256: st.sha256, content: "PASS\n" }],
      taskId,
    });
    expect(r6.ok).toBe(true);

    const r6b = await readFile("status.txt");
    expect(r6b.content).toContain("PASS");

    // Step 7: run — check-e2e profile now reads PASS and exits 0
    const r7 = await callTool("grande_run", { taskId, profile: "check-e2e" });
    expect(r7.ok).toBe(true);
    const jobId2 = (r7.data as Record<string, unknown>).jobId as string;
    expect(jobId2).toMatch(/^job_/);
    started.push(jobId2);

    // Step 8: run_result — verify the job passed
    await settle(jobId2);
    const r8 = await callTool("grande_run_result", { jobId: jobId2 });
    expect(r8.ok).toBe(true);
    const jobState8 = getJob(deps.db, jobId2);
    expect(jobState8!.state).toBe("passed");
    expect(jobState8!.exitCode).toBe(0);
  }, 30_000);

  it("所有六个只读工具在连续调用后返回正确信封", async () => {
    const readTools = [
      { name: "grande_task_status", args: { taskId: "task_e2e" } },
      { name: "grande_repo_map", args: {} },
      { name: "grande_repo_search", args: { pattern: "v1" } },
      { name: "grande_repo_read", args: { path: "a.ts" } },
      { name: "grande_diff", args: { taskId: "task_e2e" } },
    ];

    for (const { name, args } of readTools) {
      const r = await callTool(name, args);
      expect(r.ok, `${name} 应返回 ok: true`).toBe(true);
      expect(r.hint).toBeTruthy();
      expect(r.data).toBeDefined();
    }

    // grande_run_result needs a real job
    const run = await callTool("grande_run", { taskId: "task_e2e", profile: "ok" });
    const jobId = (run.data as Record<string, unknown>).jobId as string;
    started.push(jobId);
    await settle(jobId);
    const r = await callTool("grande_run_result", { jobId });
    expect(r.ok).toBe(true);
    expect(r.data).toBeDefined();
  }, 20_000);

  it("写工具信封正确且 taskId 在全链路中保持一致", async () => {
    // task_open
    const r1 = await callTool("grande_task_open", { taskId: "task_e2e_w1", slug: "write-chain" });
    expect(r1.ok).toBe(true);
    expect(r1.taskId).toBe("task_e2e_w1");

    // repo_edit with taskId
    const r2 = await callTool("grande_repo_edit", {
      ops: [{ op: "create", path: "e2e-new.ts", content: "export const e = 1;\n" }],
      taskId: "task_e2e_w1",
    });
    expect(r2.ok).toBe(true);
    expect(r2.taskId).toBe("task_e2e_w1");
    expect((r2.data as Record<string, unknown>).applied).toBeDefined();
    expect(r2.taskContext).toBeDefined();

    // run with same taskId
    const r3 = await callTool("grande_run", { taskId: "task_e2e_w1", profile: "ok" });
    expect(r3.ok).toBe(true);
    expect(r3.taskId).toBe("task_e2e_w1");
    const jobId = (r3.data as Record<string, unknown>).jobId as string;
    started.push(jobId);
    await settle(jobId);

    // run_result preserves taskId in context
    const r4 = await callTool("grande_run_result", { jobId });
    expect(r4.ok).toBe(true);
    expect(r4.taskContext).toBeDefined();
    expect((r4.taskContext as Record<string, unknown>)!.branch).toBeTruthy();
  }, 20_000);

  it("repo_edit → run → repo_edit → run 的 edit-run 闭环在同一个 task 上打通", async () => {
    const taskId = "task_e2e_loop";

    expect(
      (await callTool("grande_task_open", { taskId, slug: "edit-run" })).ok,
    ).toBe(true);

    // First edit + run cycle — deliberately fail
    const st1 = await readFile("status.txt");
    const edit1 = await callTool("grande_repo_edit", {
      ops: [{ op: "modify", path: "status.txt", expectedSha256: st1.sha256, content: "FAIL\n" }],
      taskId,
    });
    expect(edit1.ok).toBe(true);

    const run1 = await callTool("grande_run", { taskId, profile: "check-e2e" });
    expect(run1.ok).toBe(true);
    const j1 = (run1.data as Record<string, unknown>).jobId as string;
    started.push(j1);
    await settle(j1);

    const res1 = await callTool("grande_run_result", { jobId: j1 });
    expect(res1.ok).toBe(true);
    expect((res1.data as Record<string, unknown>).state).toBe("failed");
    expect((res1.data as Record<string, unknown>).exitCode).toBe(1);
    const job1 = getJob(deps.db, j1);
    expect(job1!.state).toBe("failed");

    // Second edit + run cycle — fix and pass
    const st2 = await readFile("status.txt");
    const edit2 = await callTool("grande_repo_edit", {
      ops: [{ op: "modify", path: "status.txt", expectedSha256: st2.sha256, content: "PASS\n" }],
      taskId,
    });
    expect(edit2.ok).toBe(true);

    const run2 = await callTool("grande_run", { taskId, profile: "check-e2e" });
    expect(run2.ok).toBe(true);
    const j2 = (run2.data as Record<string, unknown>).jobId as string;
    started.push(j2);
    await settle(j2);

    const res2 = await callTool("grande_run_result", { jobId: j2 });
    expect(res2.ok).toBe(true);
    const job2 = getJob(deps.db, j2);
    expect(job2!.state).toBe("passed");
    expect(job2!.exitCode).toBe(0);
  }, 30_000);

  it("repo_search 能搜到 repo_edit 创建的新文件内容（证明文件落盘了）", async () => {
    await callTool("grande_repo_edit", {
      ops: [{ op: "create", path: "e2e-search.ts", content: "const MAGIC_E2E = 'find-me';\n" }],
    });

    const r = await callTool("grande_repo_search", { pattern: "find-me" });
    expect(r.ok).toBe(true);
    const matches = (r.data as Record<string, unknown>).matches as Array<unknown>;
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("E2E：启动流程", () => {
  it("reconcile 在首次工具调用前跑完（AC-11 系统层面验证）", () => {
    const dead = createJob(deps.db, {
      jobId: "job_e2e_dead", taskId: "task_e2e", profile: "ok",
      argv: ["/bin/sh", "-c", "true"], pgid: 999999,
    });
    expect(getJob(deps.db, dead.jobId)!.state).toBe("running");

    const isAlive = () => false;
    reconcileRunningJobs(deps.db, isAlive);

    expect(getJob(deps.db, dead.jobId)!.state).toBe("killed");
  });
});

describe("E2E：truncated 字段顺序", () => {
  it("repo_map 的 truncated/nextCursor 在 data 之前", async () => {
    const r = await callTool("grande_repo_map", {});
    const keys = Object.keys(r);
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("data"));
    expect(keys.indexOf("nextCursor")).toBeLessThan(keys.indexOf("data"));
  });

  it("repo_search 的 truncated/nextCursor 在 data 之前", async () => {
    const r = await callTool("grande_repo_search", { pattern: "v1" });
    const keys = Object.keys(r);
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("data"));
    expect(keys.indexOf("nextCursor")).toBeLessThan(keys.indexOf("data"));
  });

  it("repo_read 的 truncated 在 data 之前", async () => {
    const r = await callTool("grande_repo_read", { path: "a.ts" });
    const keys = Object.keys(r);
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("data"));
  });

  it("run_result 的 truncated 在 data 之前", async () => {
    const run = await callTool("grande_run", { taskId: "task_e2e", profile: "ok" });
    const jobId = (run.data as Record<string, unknown>).jobId as string;
    started.push(jobId);
    await settle(jobId);
    const r = await callTool("grande_run_result", { jobId });
    const keys = Object.keys(r);
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("data"));
  });
});
