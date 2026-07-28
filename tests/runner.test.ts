import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { getJob, listJobs } from "../src/jobs.ts";
import { createTask } from "../src/tasks.ts";
import { awaitJobSettled, jobReport, startJob } from "../src/runner.ts";
import { getAudit, beginAudit, type AuditHandle } from "../src/audit.ts";
import { allowedHandle } from "./_audit.ts";

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
  const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName }, allowedHandle(db, "grande_run"));
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
    '    noisy: { argv: ["' + process.execPath + '", "-e", "console.log(\'A\'.repeat(20000))"], timeoutSeconds: 30, maxOutputBytes: 65536 }\n' +
    // C3：专用于「createJob 失败时是否留下孤儿进程」的探针。
    '    orphanProbe: { argv: ["/bin/sh", "-c", "sleep 30"], timeoutSeconds: 30 }\n' +
    // I2：3000 行输出、4KB cap，真实 exit 0——命中 cap 之前必须只截断不杀进程，
    // 否则这个真正通过的用例会被误报成 killed。
    '    verbose: { argv: ["/bin/sh", "-c", "for i in $(seq 1 3000); do echo line-$i; done; exit 0"], timeoutSeconds: 30, maxOutputBytes: 4096 }\n',
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

  it("worktreePath 等于 worktreesRoot 时拒绝——这个值本身会把整个 worktrees 根变成沙箱的可写根（C1）", () => {
    expect(() =>
      startJob(
        { db, layout },
        { taskId: "task_abcd", repoId: "demo", worktreePath: layout.worktreesRoot, profileName: "ok" },
        allowedHandle(db, "grande_run"),
      ),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    const rows = db.prepare("SELECT COUNT(*) AS n FROM job").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("真实的、每任务专属的 worktree 路径仍然被接受（不能因为收紧 C1 而误伤合法路径）", () => {
    // wt 本身就是 beforeEach 建出来的、layout.worktreesRoot 之下的真实任务
    // worktree——这条就是收紧包含关系检查之后仍必须放行的形状。
    expect(() => start("ok")).not.toThrow();
  });

  it("taskId 路径穿越被拒，且不会在控制平面之外产生任何目录（C4）", () => {
    const evil = "../../../../../../../../tmp/grande-review-evil2";
    expect(() =>
      startJob({ db, layout }, { taskId: evil, repoId: "demo", worktreePath: wt, profileName: "ok" }, allowedHandle(db, "grande_run")),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    // 关键在于「没有任何目录出现在控制平面之外」，不只是「抛了个错」——断言的是
    // 漏洞真正会产生的那个 join 结果本身不存在。
    expect(existsSync(join(layout.artifactsDir, evil))).toBe(false);
    expect(existsSync("/tmp/grande-review-evil2")).toBe(false);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM job").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("createJob 失败（未知 taskId 撞外键约束）不留孤儿进程，也不产生 unhandled rejection（C3）", async () => {
    // 孤儿探活用「本进程当前有哪些活着的直接子进程」的前后差集，而不是在整机
    // `ps` 输出里搜一个文本/数字标记——本机常年跑着几十个进程，端口号/序号/
    // pid 到处都是数字，短标记随时可能撞车（已实测）。sandbox-exec 是被这个
    // vitest worker 进程（`process.pid`）直接 spawn 出来的：`detached: true`
    // 只让它成为新进程组的组长，不改变父子关系，所以它 kill 前会一直挂在
    // `process.pid` 名下。
    const childPidsOf = (ppid: number): Set<number> => {
      const out = execFileSync("/bin/ps", ["-Ao", "pid=,ppid=,comm="], { encoding: "utf8" });
      const pids = new Set<number>();
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const pid = Number(parts[0]);
        const pp = Number(parts[1]);
        const comm = parts[2]!;
        // 排除 ps 自己这一行：它在枚举进程表的那一刻，自己也活在表里，ppid
        // 正是调用者（这个测试进程）——每次调用都会得到一个全新的、必然不在
        // before 集合里的 pid，制造一个跟沙箱进程完全无关的假阳性「新增子
        // 进程」（已实测复现：连续两次调用，各自的 /bin/ps 都把自己算了进去）。
        if (pp === ppid && !comm.endsWith("/ps")) pids.add(pid);
      }
      return pids;
    };
    const before = childPidsOf(process.pid);

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() =>
        startJob(
          { db, layout },
          { taskId: "task_does_not_exist", repoId: "demo", worktreePath: wt, profileName: "orphanProbe" },
          allowedHandle(db, "grande_run"),
        ),
      ).toThrow();

      // job 行必须完全没有落库——createJob 本身就是失败的那一步。
      const rows = db.prepare("SELECT COUNT(*) AS n FROM job").get() as { n: number };
      expect(rows.n).toBe(0);

      // unhandled rejection 是异步冒出来的，不会在 startJob 同步抛出时就发生；
      // 给事件循环一点时间，确认它没有发生。
      await new Promise((r) => setTimeout(r, 500));
      expect(rejections).toEqual([]);

      // 孤儿探活：给 SIGKILL 与内核回收一点时间，再确认没有新增的、还活着的
      // 子进程——sandboxProbe 用的是 sleep 30，如果没被杀，1 秒后必然还在。
      await new Promise((r) => setTimeout(r, 500));
      const after = [...childPidsOf(process.pid)].filter((p) => !before.has(p));
      expect(after).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 10_000);

  it("startJob 在 spawn【之前】把句柄推进到 EXECUTING", async () => {
    const marker = join(wt, "marker");
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      `repos:\n  demo:\n    touch: { argv: ["/usr/bin/touch", "${marker}"], timeoutSeconds: 10 }\n`,
      "utf8",
    );
    const h = allowedHandle(db, "grande_run");
    let markerExistedAtAdvance: boolean | null = null;
    const spy: AuditHandle = { ...h, executing: () => {
      markerExistedAtAdvance = existsSync(marker);
      return h.executing();
    } };
    const s = startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "touch" }, spy);
    started.push(s.jobId);
    await awaitJobSettled(s.jobId);
    expect(markerExistedAtAdvance).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(getAudit(db, h.opId)!.state).toBe("SUCCEEDED");
  });

  it("句柄推进失败时【不 spawn】", () => {
    const h = beginAudit(db, { taskId: null, tool: "grande_run", input: {} });
    // 故意不调用 allowed()
    expect(() =>
      startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "ok" }, h),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(listJobs(db, "task_abcd")).toHaveLength(0);
  });

  it("失败时句柄落到 FAILED 且带 reason", () => {
    const h = allowedHandle(db, "grande_run");
    expect(() =>
      startJob({ db, layout }, { taskId: "task_abcd", repoId: "demo", worktreePath: wt, profileName: "does-not-exist" }, h),
    ).toThrow();
    const row = getAudit(db, h.opId)!;
    expect(row.state).toBe("FAILED");
    expect(row.reason).toBeTruthy();
  });

  it("startJob 的形参数量仍是 3（tsc 才是真正拦住漏传 audit 的那道关卡）", () => {
    expect(startJob.length).toBe(3);
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

  it("输出超过 cap 时只截断、不杀进程：真实 exit 0 的通过用例不会被误报成 killed（I2）", async () => {
    const s = start("verbose");
    await waitFor(() => getJob(db, s.jobId)?.state !== "running");
    const j = getJob(db, s.jobId)!;
    expect(j.state).toBe("passed");
    expect(j.exitCode).toBe(0);
    const r = jobReport(db, s.jobId);
    expect(r.killedBy).toBeNull();
    expect(r.outputTruncated).toBe(true);
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
