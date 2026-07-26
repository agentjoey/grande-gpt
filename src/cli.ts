import { existsSync } from "node:fs";
import { join } from "node:path";
import { listAudit, listUnfinishedAudit } from "./audit.ts";
import { openDb } from "./db.ts";
import { listJobs } from "./jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "./layout.ts";
import { getTask, listActiveTasks } from "./tasks.ts";
import { discoverRepos, loadRegistry } from "./registry.ts";

const USAGE = `grande —— GrandeGPT 控制平面的只读查看器

  grande status                 活跃任务：分支、worktree、状态、最近 job
  grande jobs [--task <id>]     job 列表：profile、状态、耗时、退出码
  grande audit [--task <id>]    审计流水：opId、工具、决策、触及路径
  grande doctor                 环境自检

本工具只读，不提供任何变更能力（规格 §8.2）。`;

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function withDb<T>(fn: (db: ReturnType<typeof openDb>, layout: Layout) => T): T {
  const layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);
  try {
    return fn(db, layout);
  } finally {
    db.close();
  }
}

function cmdStatus(out: (l: string) => void): number {
  return withDb((db) => {
    const tasks = listActiveTasks(db);
    if (tasks.length === 0) {
      out("没有活跃任务。");
      return 0;
    }
    for (const t of tasks) {
      const last = listJobs(db, t.taskId)[0];
      out(`${t.taskId}  [${t.state}]  repo=${t.repoId}`);
      out(`  分支      ${t.branch}`);
      out(`  worktree  ${t.worktreePath}`);
      out(`  最近 job  ${last ? `${last.jobId} ${last.profile} → ${last.state}` : "（无）"}`);
      out("");
    }
    return 0;
  });
}

function cmdJobs(out: (l: string) => void, taskId?: string): number {
  return withDb((db) => {
    if (taskId !== undefined && !getTask(db, taskId)) {
      out(`任务不存在：${taskId}`);
      const active = listActiveTasks(db);
      if (active.length > 0) out(`活跃任务：${active.map((t) => t.taskId).join(", ")}`);
      return 1;
    }
    const jobs = listJobs(db, taskId);
    if (jobs.length === 0) {
      out("没有 job 记录。");
      return 0;
    }
    for (const j of jobs) {
      const dur = j.endedAt === null ? "运行中" : `${((j.endedAt - j.startedAt) / 1000).toFixed(1)}s`;
      out(`${j.jobId}  ${j.profile.padEnd(10)} ${j.state.padEnd(9)} exit=${j.exitCode ?? "-"}  ${dur}  ${fmtTime(j.startedAt)}`);
    }
    return 0;
  });
}

function cmdAudit(out: (l: string) => void, taskId?: string): number {
  return withDb((db) => {
    const rows = listAudit(db, taskId);
    if (rows.length === 0) {
      out("没有审计记录。");
      return 0;
    }
    for (const r of rows) {
      out(`${fmtTime(r.at)}  ${r.tool.padEnd(20)} ${r.decision.padEnd(8)} ${r.state.padEnd(10)} ${r.opId}`);
      if (r.pathsTouched.length > 0) out(`    触及：${r.pathsTouched.join(", ")}`);
      if (r.reason !== null) out(`    原因：${r.reason}`);
    }
    const stuck = listUnfinishedAudit(db);
    if (stuck.length > 0) {
      out("");
      out(`⚠️  ${stuck.length} 条记录停在 INTENT/EXECUTING —— 崩溃或中断的痕迹：`);
      for (const r of stuck) out(`    ${r.opId}  ${r.tool}  ${r.state}`);
    }
    return 0;
  });
}

function cmdDoctor(out: (l: string) => void): number {
  let bad = 0;
  const ok = (label: string, detail: string): void => out(`  ✓ ${label} — ${detail}`);
  const fail = (label: string, detail: string): void => {
    out(`  ✗ ${label} — ${detail}`);
    bad++;
  };

  out("环境自检：");
  if (existsSync("/usr/bin/sandbox-exec")) ok("sandbox-exec", "/usr/bin/sandbox-exec 存在");
  else fail("sandbox-exec", "缺失 —— Seatbelt 沙箱不可用，run_profile 无法工作");

  let layout: Layout;
  try {
    layout = loadLayout();
  } catch (e) {
    fail("GRANDE_WORKSPACE", e instanceof Error ? e.message : String(e));
    return 1;
  }
  ok("GRANDE_WORKSPACE", layout.workspaceRoot);
  ok("控制平面", layout.controlRoot);

  ensureLayout(layout);
  const registry = loadRegistry(layout);
  const registered = [...registry.values()].filter((r) => r.registered);
  if (registered.length === 0) {
    const candidates = discoverRepos(layout);
    fail(
      "已注册仓库",
      candidates.length > 0
        ? `无。工作区下发现候选：${candidates.join(", ")} —— 需在 ${layout.reposConfig} 中标记 registered: true`
        : `无，且工作区下没有发现任何 git 仓库`,
    );
  } else {
    for (const r of registered) {
      const dir = join(layout.workspaceRoot, r.repoId);
      if (!existsSync(dir)) fail(`仓库 ${r.repoId}`, `已注册但目录不存在：${dir}`);
      else if (!existsSync(join(dir, ".git"))) fail(`仓库 ${r.repoId}`, `目录存在但不是 git 仓库：${dir}`);
      else ok(`仓库 ${r.repoId}`, dir);
    }
  }

  const stuck = withDb((db) => listUnfinishedAudit(db).length);
  if (stuck > 0) fail("审计完整性", `${stuck} 条记录停在 INTENT/EXECUTING，可能是上次崩溃留下的`);
  else ok("审计完整性", "无未完成记录");

  return bad === 0 ? 0 : 1;
}

/** @returns 进程退出码 */
export function runCli(argv: string[], out: (line: string) => void): number {
  const [cmd, ...rest] = argv;
  const taskIdx = rest.indexOf("--task");
  const taskId = taskIdx >= 0 ? rest[taskIdx + 1] : undefined;

  switch (cmd) {
    case "status":
      return cmdStatus(out);
    case "jobs":
      return cmdJobs(out, taskId);
    case "audit":
      return cmdAudit(out, taskId);
    case "doctor":
      return cmdDoctor(out);
    default:
      if (cmd !== undefined) out(`未知命令：${cmd}`);
      out(USAGE);
      return 1;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.exit(runCli(process.argv.slice(2), (l) => console.log(l)));
}
