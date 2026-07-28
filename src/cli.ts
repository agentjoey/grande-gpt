import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listAudit, listUnfinishedAudit } from "./audit.ts";
import { openDb } from "./db.ts";
import { listJobs } from "./jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "./layout.ts";
import { assertValidId } from "./paths.ts";
import { getTask, listActiveTasks } from "./tasks.ts";
import { discoverRepos, loadRegistry } from "./registry.ts";
import { applyGc, planGc } from "./worktreeGc.ts";

const USAGE = `grande —— GrandeGPT 控制平面的只读查看器

  grande status                 活跃任务：分支、worktree、状态、最近 job
  grande jobs [--task <id>]     job 列表：profile、状态、耗时、退出码
  grande audit [--task <id>]    审计流水：opId、工具、决策、触及路径
  grande doctor                 环境自检
  grande gc                     worktree 与 task 对账（默认 dry-run）

本工具只读，不提供任何变更能力（规格 §8.2）。`;

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * `withDb` 的返回形状（fix round item 9）：不直接返回 `fn` 的结果，也不用一个
 * 裸 `number` 错误哨兵——旧签名是 `withDb(out, fn): number`，`loadLayout()`
 * 失败时硬编码 `return 1`，这个 `1` 在类型上和 `fn` 自己返回的、语义是**数据**
 * 的 `number`（比如 `cmdDoctor` 那次调用，`fn` 返回的是「停在 INTENT/EXECUTING
 * 的记录数」，不是退出码）完全没有区别：`const stuck = withDb(out, db =>
 * listUnfinishedAudit(db).length)` 在 `loadLayout()` 失败的路径上会让 `stuck`
 * 变成字面量 `1`，读起来像「有 1 条卡住的记录」，实际是「打开库失败」。今天这
 * 条路径不可达（`cmdDoctor` 在调用这里之前已经自己成功调过一次
 * `loadLayout()`），但类型系统允许这个混淆发生——一旦那次提前调用被将来的
 * 重构当作冗余删掉，这个误判就会真的发生，且不会有任何类型错误提醒。
 * `{ ok: true; value: T } | { ok: false }` 让 `!r.ok` 分支里根本不存在
 * `r.value` 这个字段，调用方在类型层就不可能把错误结果误当成数据使用。
 */
type WithDbResult<T> = { ok: true; value: T } | { ok: false };

/**
 * 打开状态库、跑 fn、关闭。`loadLayout()` 的失败（`GRANDE_WORKSPACE` 未设置/
 * 非绝对路径/目录不存在）在这里统一兜底——这三种都是环境配置问题，不是编程
 * 错误，理应走 `out` 回调给出干净消息，而不是作为未捕获异常一路逃出
 * `cmdStatus`/`cmdJobs`/`cmdAudit`、逃出 `runCli`，绕过 `out`、也不返回退出码
 * （违反 `runCli` 自己文档化的 `@returns` 契约）。`cmdDoctor` 已经用一模一样的
 * 写法处理过同一个 `loadLayout()`；这里是把它下沉成 `withDb` 的一部分，而不是
 * 在 `runCli` 顶层再包一层——三个只读命令都经过 `withDb`，下沉到这一处即可
 * 同时修好三个，不用在四处分别维护同一段 try/catch。
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
function withDb<T>(
  out: (l: string) => void,
  fn: (db: ReturnType<typeof openDb>, layout: Layout) => T,
): WithDbResult<T> {
  let layout: Layout;
  try {
    layout = loadLayout();
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return { ok: false };
  }
  ensureLayout(layout);
  const db = openDb(layout);
  try {
    return { ok: true, value: fn(db, layout) };
  } finally {
    db.close();
  }
}

/**
 * `withDb` 的特化：`fn` 本身就返回退出码时用这个——`withDb` 内部的错误（环境
 * 配置问题）统一折叠成退出码 `1`，这是 `cmdStatus`/`cmdJobs`/`cmdAudit` 共用
 * 的形状。`cmdDoctor` 要的是数据（停住的审计记录数），不是退出码，不走这层
 * 折叠，直接用 `withDb` 本身并显式处理 `{ ok: false }`（见 `cmdDoctor`）。
 */
function withDbExitCode(
  out: (l: string) => void,
  fn: (db: ReturnType<typeof openDb>, layout: Layout) => number,
): number {
  const r = withDb(out, fn);
  return r.ok ? r.value : 1;
}

function cmdStatus(out: (l: string) => void): number {
  return withDbExitCode(out, (db) => {
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
  return withDbExitCode(out, (db) => {
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
  return withDbExitCode(out, (db) => {
    // 与 cmdJobs 不同：job.taskId 有 FOREIGN KEY REFERENCES task(taskId)，audit.taskId
    // 没有（规格 §8.1 明说业务执行与审计不是单一事务）——一条审计记录完全可以先于、
    // 甚至没有对应的 task 行存在，这正是人类会来 `grande audit --task` 排查的那个
    // 崩溃窗口。所以「这个 id 是不是打错了」不能只看 getTask：只有 getTask 查无
    // 此任务、**且**这个 id 名下确实一条审计记录都没有，才真的是无效输入；只要
    // 名下有审计行，不管 task 表里有没有对应的行，都必须照常渲染出来。
    const rows = listAudit(db, taskId);
    if (taskId !== undefined && !getTask(db, taskId) && rows.length === 0) {
      out(`任务不存在：${taskId}`);
      const active = listActiveTasks(db);
      if (active.length > 0) out(`活跃任务：${active.map((t) => t.taskId).join(", ")}`);
      return 1;
    }
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

  // 直接用 withDb（不走 withDbExitCode）：这里要的是数据（停住的审计记录数），
  // 不是退出码——withDbExitCode 会把 { ok: false } 折叠成数字 1，那正是 item 9
  // 要堵的混淆本身（1 会被读成「有 1 条卡住的记录」）。{ ok: false } 这个分支在
  // 今天不可达（上面已经成功调用过一次 loadLayout()，环境变量不会在一次调用
  // 期间变化），但类型层必须把它和「0 条」「N 条」两个真实数据分支分开处理，
  // 不能让它们共用同一个 number。
  const stuckResult = withDb(out, (db) => listUnfinishedAudit(db).length);
  if (!stuckResult.ok) {
    fail("审计完整性", "无法读取审计记录（不应该发生：loadLayout 在此之前已经成功过一次）");
  } else if (stuckResult.value > 0) {
    fail("审计完整性", `${stuckResult.value} 条记录停在 INTENT/EXECUTING，可能是上次崩溃留下的`);
  } else {
    ok("审计完整性", "无未完成记录");
  }

  return bad === 0 ? 0 : 1;
}

function cmdGc(out: (l: string) => void, apply: boolean): number {
  return withDbExitCode(out, (db, layout) => {
    const plan = planGc(db, layout);

    // 孤儿 worktree
    out(`孤儿 worktree（磁盘有、库里没有）：${plan.orphanWorktrees.length} 条`);
    for (const o of plan.orphanWorktrees) {
      out(`  ${o.repoId}/${o.taskId}`);
      out(`    路径    ${o.path}`);
      out(`    分支    ${o.branch ?? "（无）"}`);
    }

    // 幽灵 task
    out("");
    out(`幽灵 task（库里有、磁盘上没有）：${plan.ghostTasks.length} 条`);
    for (const g of plan.ghostTasks) {
      out(`  ${g.taskId}  repo=${g.repoId}`);
      out(`    期望路径 ${g.worktreePath}`);
    }

    if (plan.orphanWorktrees.length === 0 && plan.ghostTasks.length === 0) {
      out("");
      out("一切干净，没有需要清理的东西。");
      return 0;
    }

    if (!apply) {
      out("");
      out("以上为 dry-run 结果。加上 --apply 执行清理。");
      return 0;
    }

    out("");
    out("正在执行清理…");
    const result = applyGc(db, layout, plan);
    out(`  回收孤儿 worktree：${result.removed} 条`);
    out(`  关闭幽灵 task：${result.closed} 条`);
    out("完成。");
    return 0;
  });
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

  // fix round item 11：悬空 --task 的用法错误此前只覆盖 jobs/audit，status 静默
  // 放过——status 从不消费 --task（它不按任务过滤），但「悬空的 --task」本身是
  // 畸形输入，不该因为落在哪个子命令下面就区别对待。doctor 不做同样处理：它的
  // USAGE 里从未提过 --task，维持现状。
  if (taskDangling && (cmd === "jobs" || cmd === "audit" || cmd === "status")) {
    out("用法错误：--task 后面需要一个任务 id，例如 --task task_abc");
    return 1;
  }

  // fix round item 7：taskId 是调用方可控字符串——一个内嵌换行、伪装成一行
  // 「审计完整性正常」确认文本的 --task 值，在查无此任务时会被 cmdJobs/cmdAudit
  // 的「任务不存在：${taskId}」原样回显，足以在终端里伪造出后续内容看起来正常
  // 的假象（`grande audit` 是唯一不能被拿来伪造「发生了什么」的地方）。校验放
  // 在这里而不是分别放进 cmdJobs/cmdAudit：两条命令共用同一段解析逻辑，校验也
  // 该共用同一处，不给「其中一个忘记校验」留口子。只在 taskId 真的会被消费
  // （并可能被回显）的两个命令下校验——status 不消费它，见上面 taskDangling
  // 的注释。
  if (taskId !== undefined && (cmd === "jobs" || cmd === "audit")) {
    try {
      assertValidId(taskId, "--task");
    } catch (e) {
      out(`用法错误：${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
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
    case "gc":
      return cmdGc(out, rest.includes("--apply"));
    default:
      if (cmd !== undefined) out(`未知命令：${cmd}`);
      out(USAGE);
      return 1;
  }
}

/**
 * 「这个模块是不是被当作入口直接跑起来的」——不能是 `import.meta.url ===
 * \`file://${process.argv[1]}\``：`import.meta.url` 是 Node 解析模块时产出的、
 * 百分号编码过的、**已经跟随符号链接解析到真实文件**的 URL；`process.argv[1]`
 * 是 shell 传给进程的原始路径字符串，未编码、也不跟随符号链接。两者字符串直接
 * 比较，在两类场景下失配：
 *
 * 1. 路径含空格或非 ASCII 字符（本项目明确要支持非 ASCII 仓库名，工作区路径本身
 *    也可能含这些字符）——`import.meta.url` 会把它们编码成 `%20`/`%E6%88%91`
 *    这类转义序列，裸拼接的 `file://${argv[1]}` 不会，比较必然为假。
 * 2. 经符号链接调用——`package.json` 的 `bin` 字段、`pnpm link`、
 *    `node_modules/.bin` 里的 shim 都是符号链接；Node 按真实文件解析
 *    `import.meta.url`，但 `process.argv[1]` 仍是调用时用的那个链接路径，
 *    两者字符串永不相等。
 *
 * 这正是「直接路径能跑、经 shim 调用却静默退出且不输出任何东西」的根因——
 * 对一个「东西已经坏了才会去摸」的工具来说，`exit 0` 又没有输出是最差的失败
 * 形态：调用方会把它读成成功。
 *
 * 选择的修法：把 `process.argv[1]` 也做同样的 realpath + URL 编码
 * （`pathToFileURL(realpathSync(...))`），再与 `import.meta.url` 比较——两条
 * 路径此时都经过完全相同的规范化，语义对齐。没有选 `import.meta.filename ===
 * process.argv[1]`（Node ≥20.11 的等价写法）：`import.meta.filename` 只是
 * `fileURLToPath(import.meta.url)` 的语法糖，同样已经 realpath 过，而
 * `process.argv[1]` 从未 realpath——两者用来比较时，符号链接场景下的失配原样
 * 保留，只解决了编码问题、没解决符号链接问题（已用一次性脚本实测两种写法的
 * 行为差异，见 fix round 报告）。
 *
 * `process.argv[1]` 缺失或指向一个已不存在的路径时按「不是入口」处理，而不是
 * 让 `realpathSync` 的异常原样抛出——那会在 `import` 这一行本身就炸掉整个模块
 * （包括被测试文件 `import { runCli } ...` 的场景），比「误判不是入口」严重得多。
 */
function isMainModule(): boolean {
  const scriptPath = process.argv[1];
  if (scriptPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(scriptPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(runCli(process.argv.slice(2), (l) => console.log(l)));
}
