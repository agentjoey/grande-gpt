import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { getJob } from "../src/jobs.ts";
import { createTask } from "../src/tasks.ts";
import { awaitJobSettled, jobReport, startJob } from "../src/runner.ts";

let ws: string, ctrl: string, layout: Layout, db: ReturnType<typeof openDb>, wt: string;
let savedWs: string | undefined, savedCtrl: string | undefined;

const waitFor = async (p: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!p()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 100));
  }
};

const started: string[] = [];
const start = (profileName: string) => {
  const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName });
  started.push(s.jobId);
  return s;
};
const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "run-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "run-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);

  const repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.ts"), "v1\n", "utf8");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
  writeFileSync(layout.reposConfig, `repos:\n  - repoId: demo\n    registered: true\n`, "utf8");

  wt = join(layout.worktreesRoot, "demo", "task_abcd");
  g(repo, "worktree", "add", "-b", "grande/x-abcd", wt, g(repo, "rev-parse", "HEAD").trim());

  createTask(db, {
    taskId: "task_abcd", repoId: "demo", branch: "grande/x-abcd",
    baseCommit: g(repo, "rev-parse", "HEAD").trim(), worktreePath: wt, state: "READY",
  });
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    'repos:\n  demo:\n' +
    '    ok:   { argv: ["/bin/sh", "-c", "echo hello; exit 0"], timeoutSeconds: 30 }\n' +
    '    fail: { argv: ["/bin/sh", "-c", "echo boom >&2; exit 3"], timeoutSeconds: 30 }\n' +
    '    slow: { argv: ["/bin/sh", "-c", "sleep 60"], timeoutSeconds: 2 }\n' +
    '    noisy: { argv: ["' + process.execPath + '", "-e", "console.log(\'A\'.repeat(20000))"], timeoutSeconds: 30, maxOutputBytes: 65536 }\n',
    "utf8",
  );
});

afterEach(async () => {
  await Promise.all(started.map(awaitJobSettled));
  started.length = 0;
  db.close();
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("startJob()", () => {
  it("立刻返回 jobId 与 running，不等命令跑完", () => {
    const t0 = Date.now();
    const s = start("slow");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(s.state).toBe("running");
    expect(s.jobId).toMatch(/^job_/);
    expect(s.pollAfterSeconds).toBeGreaterThan(0);
    expect(getJob(db, s.jobId)?.state).toBe("running");
  });

  it("成功的命令最终收敛为 passed，exitCode 为 0", async () => {
    const s = start("ok");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.state).toBe("passed");
    expect(j.exitCode).toBe(0);
  });

  it("失败的命令收敛为 failed，并保留真实 exitCode", async () => {
    const s = start("fail");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.state).toBe("failed");
    expect(j.exitCode).toBe(3);
  });

  it("超时收敛为 timeout 而不是 failed（两者对模型意味着不同的下一步）", async () => {
    const s = start("slow");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    expect(getJob(db, s.jobId)!.state).toBe("timeout");
  });

  it("完整输出落 artifact，路径在控制平面之下（不在工作区）", async () => {
    const s = start("ok");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.artifactPath).not.toBeNull();
    expect(j.artifactPath!.startsWith(layout.controlRoot)).toBe(true);
    expect(j.artifactPath!.startsWith(layout.workspaceRoot)).toBe(false);
    expect(readFileSync(j.artifactPath!, "utf8")).toContain("hello");
  });

  it("未注册的 profile 抛 PROFILE_NOT_FOUND，且【不】留下 running 的 job 行", async () => {
    expect(() => start("nope")).toThrow(expect.objectContaining({ code: "PROFILE_NOT_FOUND" }));
    const rows = db.prepare("SELECT COUNT(*) AS n FROM job").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("落进 job 行的 pgid 是真实进程组，不是 null（否则重启对账会把活着的 job 判成 killed，C-5）", () => {
    const s = start("slow");
    expect(getJob(db, s.jobId)!.pgid).toBeGreaterThan(0);
  });
}, 30_000);

describe("jobReport()", () => {
  it("running 的 job 报告 running，且不假装有结果", () => {
    const s = start("slow");
    const r = jobReport(db, s.jobId);
    expect(r.state).toBe("running");
    expect(r.exitCode).toBeNull();
  });

  it("结束后给出摘要，短日志不截断，尾部不超过 40 行", async () => {
    const s = start("fail");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const r = jobReport(db, s.jobId);
    expect(r.state).toBe("failed");
    expect(r.summary).toContain("boom");
    expect(r.truncated).toBe(false);
    expect(r.summary.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("超过 8KB 的摘要被截断，且不超过截断上限（I-4：不是重言式的 typeof 断言）", async () => {
    const s = start("noisy");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const r = jobReport(db, s.jobId);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.summary, "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("宽出的字段：killedBy/durationMs 来自 finishJob 存的 summary，不再被丢弃（I-5）", async () => {
    const s = start("slow");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const r = jobReport(db, s.jobId);
    expect(r.state).toBe("timeout");
    expect(r.killedBy).toBe("timeout");
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it("字段声明顺序：truncated 排在 summary 之前", async () => {
    const s = start("ok");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const keys = Object.keys(jobReport(db, s.jobId));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("summary"));
  });

  it("不存在的 jobId 抛 JOB_NOT_FOUND", () => {
    expect(() => jobReport(db, "job_nope")).toThrow(
      expect.objectContaining({ code: "JOB_NOT_FOUND" }),
    );
  });
}, 30_000);
