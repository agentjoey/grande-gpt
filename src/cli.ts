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

/**
 * 打开状态库、跑 fn、关闭。`loadLayout()` 的失败（`GRANDE_WORKSPACE` 未设置/
 * 非绝对路径/目录不存在）在这里统一兜底——这三种都是环境配置问题，不是编程
 * 错误，理应走 `out` 回调给出干净消息 + 非零退出码，而不是作为未捕获异常
 * 一路逃出 `cmdStatus`/`cmdJobs`/`cmdAudit`、逃出 `runCli`，绕过 `out`、也不
 * 返回退出码（违反 `runCli` 自己文档化的 `@returns` 契约）。`cmdDoctor` 已经
 * 用一模一样的写法处理过同一个 `loadLayout()`；这里是把它下沉成 `withDb` 的
 * 一部分，而不是在 `runCli` 顶层再包一层——三个只读命令都经过 `withDb`，下沉
 * 到这一处即可同时修好三个，不用在四处分别维护同一段 try/catch。
 *
 * try 只窄窄地包住 `loadLayout()` 这一行，不包 `ensureLayout`/`openDb`/`fn`：
 * 这几步内部真正的编程错误（比如某个 `TypeError`）不该被这层 catch 误伪装成
 * 「配置问题」报给用户——`paths.ts` 的 `guardFs` 也做过同一个区分（按错误是否
 * 带 errno 风格的 `.code` 分流 fs 失败与编程错误）；这里选的是另一种narrow手段
 * （narrow try 的范围，而不是 narrow catch 的判断条件）：`loadLayout()` 只会
 * 抛出三种手写的、消息固定的配置错误（未设置/非绝对路径/目录不存在），没有
 * `.code` 可判断，所以不能照搬 `guardFs` 的判断式；改为只把这一次调用纳入
 * try，try 之外（包括 `fn` 里跑的具体命令逻辑）的任何异常都不经过这层 catch，
 * 原样冒泡出去。
 */
function withDb(out: (l: string) => void, fn: (db: ReturnType<typeof openDb>, layout: Layout) => number): number {
  let layout: Layout;
  try {
    layout = loadLayout();
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  }
  ensureLayout(layout);
  const db = openDb(layout);
  try {
    return fn(db, layout);
  } finally {
    db.close();
  }
}

function cmdStatus(out: (l: string) => void): number {
  return withDb(out, (db) => {
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
  return withDb(out, (db) => {
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
  return withDb(out, (db) => {
    if (taskId !== undefined && !getTask(db, taskId)) {
      out(`任务不存在：${taskId}`);
      const active = listActiveTasks(db);
      if (active.length > 0) out(`活跃任务：${active.map((t) => t.taskId).join(", ")}`);
      return 1;
    }
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

  const stuck = withDb(out, (db) => listUnfinishedAudit(db).length);
  if (stuck > 0) fail("审计完整性", `${stuck} 条记录停在 INTENT/EXECUTING，可能是上次崩溃留下的`);
  else ok("审计完整性", "无未完成记录");

  return bad === 0 ? 0 : 1;
}

/** @returns 进程退出码 */
export function runCli(argv: string[], out: (line: string) => void): number {
  const [cmd, ...rest] = argv;
  const taskIdx = rest.indexOf("--task");
  // taskIdx>=0 且后面没有下一个元素：`--task` 是 argv 的最后一个token，是悬空
  // 的空值，不是「没传 --task」——两者曾经被下面这行统一折叠成同一个
  // `undefined`，静默退化成「无过滤」，而不是把畸形输入报成用法错误。
  const taskDangling = taskIdx >= 0 && rest[taskIdx + 1] === undefined;
  const taskId = taskIdx >= 0 ? rest[taskIdx + 1] : undefined;

  if (taskDangling && (cmd === "jobs" || cmd === "audit")) {
    out("用法错误：--task 后面需要一个任务 id，例如 --task task_abc");
    return 1;
  }

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
