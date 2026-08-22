import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listAudit, listUnfinishedAudit } from "./audit.ts";
import { openDb } from "./db.ts";
import { runGatewayCli } from "./gatewayCli.ts";
import { HostVerifierCoordinator } from "./hostVerifier.ts";
import {
  createDefaultHostVerifierRuntimeAdapter,
  createHostVerifierLauncher,
} from "./hostVerifierRuntime.ts";
import { getJob, listJobs, TERMINAL } from "./jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "./layout.ts";
import { applyRepoOnboarding, inspectRepoOnboarding } from "./onboarding.ts";
import { assertValidId } from "./paths.ts";
import { inspectProjectReadiness, renderProjectReadiness } from "./readiness.ts";
import { getTask, listActiveTasks } from "./tasks.ts";
import { discoverRepos, loadRegistry } from "./registry.ts";
import { applyGc, planGc } from "./worktreeGc.ts";
import { spawnSync } from "node:child_process";
import { planOuterTest, planTaskHostVerification, resolveOuterTestCwd } from "./outerTest.ts";
import { getOuterTestReceipt, prepareOuterTestRun, recordOuterTestPass } from "./outerTestReceipt.ts";
import { inspectCurrentHostVerification } from "./prHostVerification.ts";
import { bumpEpoch, currentEpoch } from "./tokenEpoch.ts";
import { renderSelfCheck, selfCheck, type SelfCheckResult } from "./selfcheck.ts";
import { compactTaskProgress, projectTaskProgress } from "./taskProgress.ts";

const USAGE = `grande —— GrandeGPT 控制平面运维工具

  grande status                 活跃任务：Golden Path progress、阻塞、cleanup 与下一步
  grande jobs [--task <id>]     job 列表：profile、状态、耗时、退出码
  grande audit [--task <id>]    审计流水：opId、工具、决策、触及路径
  grande doctor [--repo <id>]   环境自检；--repo 做 Golden Path readiness
  grande repo add <id> [--apply]  新 repo onboarding（默认 proposal；--apply 才写控制平面）
  grande gateway <action>       macOS LaunchAgent：install/start/stop/restart/status/uninstall
  grande gc [--apply]           worktree 与 task 对账（默认 dry-run）
  grande outer-test [--task <id>] [--run]  跑自举时跑不了的测试；--task 验收待合并 worktree
  grande revoke [--yes]         吊销：所有在途 access token 当场失效（默认只预演）
  grande selfcheck              客户端视角：向【正在运行的】网关问一次 tools/list

repo add 默认只读；只有 Human Owner 显式传 --apply 才写可信控制平面。
除 gateway 的变更动作、repo add --apply、gc --apply、outer-test --run 与 revoke --yes 外均为只读。
outer-test 必须在【沙箱外】跑——auto-safe task 会进入 restricted verifier；manual-only 边界才走 Human trusted host suite。`;

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

type WithDbResult<T> = { ok: true; value: T } | { ok: false };

type OuterTestSpawnResult = { status: number | null; error?: Error };
type OuterTestSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: "inherit"; encoding: "utf8" },
) => OuterTestSpawnResult;

type RestrictedOuterTestInput = {
  taskId: string;
  repoId: "grande-gpt";
  commit: string;
  level: "smoke" | "full";
};
type RestrictedOuterTestRun = (input: RestrictedOuterTestInput) => Promise<{ jobId: string }>;

export interface RunCliOptions {
  /** Test seam and manual-only Human Gate runner. Production fixed path is node:child_process spawnSync. */
  outerTestSpawn?: OuterTestSpawn;
  /** Test seam for the restricted verifier path. Production constructs the trusted C2 runtime directly. */
  restrictedOuterTestRun?: RestrictedOuterTestRun;
}

const defaultOuterTestSpawn: OuterTestSpawn = (command, args, options) => {
  const result = spawnSync(command, args, options);
  return { status: result.status, error: result.error };
};

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
      try {
        const progress = projectTaskProgress(db, t);
        out(`  progress  ${compactTaskProgress(progress)}`);
        if (progress.cleanupRequired) {
          out("  cleanup   ⚠ 闭环证据已完成，但 task/worktree 尚未 close；仍需 Human 显式 grande_task_close");
        }
        if (progress.blocker) out(`  阻塞      ${progress.blocker}`);
        out(`  下一步    ${progress.nextAction}`);
      } catch (error) {
        out(`  progress  ✗ 无法投影：${error instanceof Error ? error.message : String(error)}`);
        out("  下一步    grande gc / grande audit 检查 task 与 worktree 状态");
      }
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
        ? `无。工作区下发现候选：${candidates.join(", ")} —— 可先 grande repo add <repoId> 检查，再由 Human --apply`
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

async function cmdProjectDoctor(out: (l: string) => void, repoId: string): Promise<number> {
  let layout: Layout;
  try {
    layout = loadLayout();
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  }
  ensureLayout(layout);
  const db = openDb(layout);
  const port = process.env.PORT || "8787";
  const host = process.env.GRANDE_HOST ?? "127.0.0.1";
  const baseUrl = `http://${host}:${port}`;
  let gatewaySelfCheck: SelfCheckResult | undefined;

  try {
    const readiness = await inspectProjectReadiness(layout, repoId, {
      gatewayProbe: async () => {
        const issuer = process.env.GRANDE_ISSUER;
        if (!issuer) throw new Error("GRANDE_ISSUER 未设置，无法执行真实 Gateway tools/list probe");
        const result = await selfCheck({
          issuer,
          db,
          keyPath: join(layout.controlRoot, "secrets", "oauth-key"),
          baseUrl,
        });
        gatewaySelfCheck = result;
        if (result.httpStatus !== 200) throw new Error(`Gateway tools/list HTTP ${result.httpStatus}`);
        const identity = result.gatewayBuild !== null && result.toolsetEpoch !== null && result.toolsDigest !== null
          ? `；gatewayBuild=${result.gatewayBuild}；toolsetEpoch=${result.toolsetEpoch}；toolsDigest=${result.toolsDigest}`
          : `；server toolset identity 不可用${result.identityError ? `（${result.identityError}）` : ""}`;
        return `tools/list HTTP 200，${result.tools.length} tools${identity}`;
      },
    });
    for (const line of renderProjectReadiness(readiness)) out(line);
    out("");
    out("Connector Compatibility");
    out(`  ${readiness.gateway.ok ? "✓" : "✗"} Gateway reachable — ${readiness.gateway.detail}`);
    if (
      gatewaySelfCheck?.gatewayBuild !== null && gatewaySelfCheck?.gatewayBuild !== undefined &&
      gatewaySelfCheck.toolsetEpoch !== null && gatewaySelfCheck.toolsDigest !== null
    ) {
      out(
        `  ✓ Server toolset identity — gatewayBuild=${gatewaySelfCheck.gatewayBuild}；` +
        `toolsetEpoch=${gatewaySelfCheck.toolsetEpoch}；toolsCount=${gatewaySelfCheck.toolsCount}；` +
        `toolsDigest=${gatewaySelfCheck.toolsDigest}`,
      );
    } else {
      out(
        `  ? Server toolset identity — ${gatewaySelfCheck?.identityError ?? "Gateway probe 未取得 server identity"}`,
      );
    }
    out(
      "  ? ChatGPT session binding — server-side 无法直接验证；Refresh/Reconnect 后必须在新聊天执行 read probe 验证当前 binding",
    );
    return readiness.development.ready && readiness.prCi.ready && readiness.deploy.ready && readiness.gateway.ok ? 0 : 1;
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    db.close();
  }
}

function cmdRepo(out: (l: string) => void, args: string[]): number {
  const [action, repoId, ...flags] = args;
  if (action !== "add" || repoId === undefined) {
    out("用法错误：grande repo add <repoId> [--apply]");
    return 1;
  }
  try {
    assertValidId(repoId, "repoId");
  } catch (e) {
    out(`用法错误：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let layout: Layout;
  try {
    layout = loadLayout();
    ensureLayout(layout);
    const proposal = inspectRepoOnboarding(layout, repoId);
    out(`Onboarding proposal: ${proposal.repoId}`);
    out("Repository");
    out(`  ${proposal.git.repository ? "✓" : "✗"} Git repository`);
    out(
      `  ${proposal.git.headExists ? "✓" : "✗"} HEAD — ${proposal.git.headSha ? proposal.git.headSha.slice(0, 8) : "no baseline commit"}`,
    );
    out(
      `  ${proposal.git.detached ? "✗" : "✓"} Branch — ${proposal.git.detached ? "detached HEAD" : proposal.git.branch ?? "unknown"}`,
    );
    out(
      `  ${proposal.git.busy ? "✗" : "✓"} Canonical — ${proposal.git.busy ? `busy: ${proposal.git.busyReasons.join(", ")}` : "idle"}`,
    );
    out(`  ${proposal.git.ready ? "✓" : "✗"} Worktree lifecycle — ${proposal.git.ready ? "ready" : "not ready"}`);
    out("");
    out(`  Package manager  ${proposal.packageManager ?? "未检测到"}`);
    for (const name of ["test", "typecheck", "lint", "build"] as const) {
      const profile = proposal.profiles.find((item) => item.name === name);
      out(`  ${name.padEnd(15)} ${profile ? `✓ ${profile.argv.join(" ")}` : "✗ 未检测到 script"}`);
    }
    out(`  Git remote       ${proposal.remoteConfigured ? "✓ 已配置" : "✗ 未配置"}`);
    out(`  GitHub           ${proposal.githubRepo ? `✓ ${proposal.githubRepo}` : "✗ 非可用 github.com HTTPS origin"}`);
    out(`  CI               ${proposal.ciConfigured ? "✓ .github/workflows" : "✗ 未检测到"}`);
    out(`  Deploy           ${proposal.deployConfigured ? "✓ .grande/deploy.yaml" : "✗ 未配置"}`);
    out(`  Dependencies     ${proposal.cloneNodeModules ? "✓ 复用 canonical node_modules" : "— 无 node_modules 克隆需求"}`);
    out(`  Registered       ${proposal.alreadyRegistered ? "✓ 已注册" : "✗ 尚未授权"}`);
    out("");
    out(`Ready to register: ${proposal.readyToRegister ? "YES" : "NO"}`);
    if (proposal.blockingReasons.length > 0) {
      out("");
      out("Blocker:");
      for (const reason of proposal.blockingReasons) out(`  ${reason}`);
    }

    if (!flags.includes("--apply")) {
      out("");
      out("以上仅为 proposal，没有写任何配置。Human Owner 确认后加 --apply 写入可信控制平面。");
      return 0;
    }
    applyRepoOnboarding(layout, proposal);
    out("");
    out("已写入可信控制平面：repo registration + 不存在的常见 run profiles。repo/secrets 未被修改。");
    return 0;
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function defaultRestrictedOuterTestRun(
  db: ReturnType<typeof openDb>,
  layout: Layout,
  input: RestrictedOuterTestInput,
): Promise<{ jobId: string }> {
  const adapter = createDefaultHostVerifierRuntimeAdapter(
    { db, layout },
    { readPrHead: async () => null },
  );
  const launcher = createHostVerifierLauncher(
    { db, layout },
    adapter,
    { receiptMode: "manual", requirePrHead: false },
  );
  const coordinator = new HostVerifierCoordinator(launcher);
  const dispatch = coordinator.start(input);
  while (true) {
    const job = getJob(db, dispatch.jobId);
    if (!job) throw new Error(`restricted host verifier job disappeared: ${dispatch.jobId}`);
    if (TERMINAL.has(job.state)) return { jobId: dispatch.jobId };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cmdOuterTest(
  out: (l: string) => void,
  run: boolean,
  taskId?: string,
  outerTestSpawn: OuterTestSpawn = defaultOuterTestSpawn,
  restrictedOuterTestRun?: RestrictedOuterTestRun,
): Promise<number> {
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
    const fullManualPlan = planOuterTest(layout, "grande-gpt");
    let cwd: string;
    try {
      cwd = resolveOuterTestCwd(db, layout, "grande-gpt", taskId);
    } catch (e) {
      out(e instanceof Error ? e.message : String(e));
      return 1;
    }

    const task = taskId === undefined ? undefined : getTask(db, taskId);
    if (taskId !== undefined && !task) {
      out(`任务不存在：${taskId}`);
      return 1;
    }
    const taskPlan = task ? planTaskHostVerification(task) : undefined;
    const selectedFiles = taskPlan === undefined
      ? fullManualPlan.files
      : taskPlan.level === "none"
        ? []
        : taskPlan.manualOnlyRequired
          ? fullManualPlan.files
          : taskPlan.autoFiles;

    out(`验收目标：${taskId === undefined ? "canonical grande-gpt" : taskId}`);
    out(`  cwd  ${cwd}`);
    if (taskPlan) {
      out(`  level  ${taskPlan.level}${taskPlan.manualOnlyRequired ? " + manual-only Human Gate" : ""}`);
    }
    out("");
    out(`可信 host suite：${selectedFiles.length} 个文件`);
    if (taskPlan?.manualOnlyRequired) {
      out("（当前变更触及 manual-only 宿主边界；Human --run 使用固定 trusted full host suite。）");
    } else if (taskPlan && taskPlan.level !== "none") {
      out("（当前变更为 auto-safe plan；--run 使用 restricted one-shot host verifier。）");
    } else {
      out(`（执行清单来自运行中 Gateway manifest；${fullManualPlan.fromProfile} 的 --exclude 仅用于 transition drift 检查）`);
    }
    out("");
    for (const f of selectedFiles) {
      const why = fullManualPlan.reasons.get(f);
      out(`  ${f}`);
      out(`    ${why ?? "（trusted host manifest 缺少 capability reason）"}`);
    }
    out("");
    if (!run) {
      out("以上仅为清单。加 --run 执行；auto-safe task 进入 restricted verifier，manual-only 由 Human trusted host path 执行。");
      return 0;
    }

    if (taskPlan?.level === "none") {
      out("当前 task 变更不需要 host verification；没有执行 candidate host tests，也不签发 receipt。");
      return 0;
    }

    let expectedCommit: string | undefined;
    if (taskId !== undefined) {
      try {
        expectedCommit = prepareOuterTestRun(db, taskId, cwd);
        if (taskPlan && expectedCommit !== taskPlan.head) {
          throw new Error(`task HEAD 在 plan 后变化：${taskPlan.head} → ${expectedCommit}`);
        }
      } catch (e) {
        out(e instanceof Error ? e.message : String(e));
        return 1;
      }
    }

    const manualOnly = taskPlan?.manualOnlyRequired === true;
    if (taskId !== undefined && task && taskPlan && !manualOnly) {
      const level = taskPlan.level;
      if (level !== "smoke" && level !== "full") {
        out(`不可执行的 host verification level：${level}`);
        return 1;
      }
      const runner = restrictedOuterTestRun
        ?? ((input: RestrictedOuterTestInput) => defaultRestrictedOuterTestRun(db, layout, input));
      out("正在运行 restricted host verifier……");
      out("");
      let result: { jobId: string };
      try {
        result = await runner({ taskId, repoId: "grande-gpt", commit: expectedCommit!, level });
      } catch (e) {
        out(`restricted host verifier 启动/执行失败：${e instanceof Error ? e.message : String(e)}`);
        out("不要合并。");
        return 1;
      }
      const job = getJob(db, result.jobId);
      if (!job || job.taskId !== taskId || job.profile !== "host-verifier" || job.state !== "passed" || job.exitCode !== 0) {
        out(`restricted host verifier 未通过：job=${result.jobId} state=${job?.state ?? "missing"} exit=${job?.exitCode ?? "-"}`);
        if (job?.artifactPath) out(`artifact  ${job.artifactPath}`);
        out("不要合并。");
        return 1;
      }
      const receipt = getOuterTestReceipt(db, taskId);
      const current = inspectCurrentHostVerification(db, task, expectedCommit!);
      if (
        !receipt || !("version" in receipt) || receipt.version !== 2 || receipt.mode !== "manual" ||
        receipt.commit !== expectedCommit || receipt.jobId !== result.jobId || !current.receiptEligible
      ) {
        out(`restricted host verifier 通过，但没有可复用的 exact-SHA V2 manual receipt（job ${result.jobId}）。`);
        out("不要合并；检查 task HEAD / verifier job / receipt identity 后重试。");
        return 1;
      }
      out(`外层测试全部通过；restricted verifier 已记录 V2 manual receipt（commit ${receipt.commit}，job ${receipt.jobId}）。`);
      return 0;
    }

    out(manualOnly
      ? "正在运行 manual-only trusted host suite……（Human Gate，沙箱外固定清单）"
      : "正在运行 canonical trusted host suite……（沙箱外）");
    out("");
    const r = outerTestSpawn("npx", [
      "vitest", "run", "--config", "vitest.host.config.ts", ...fullManualPlan.files,
    ], {
      cwd,
      stdio: "inherit",
      encoding: "utf8",
    });
    if (r.error) {
      out(`启动 vitest 失败：${r.error.message}`);
      return 1;
    }
    const code = r.status ?? 1;
    out("");
    if (code !== 0) {
      out(`外层测试失败（exit ${code}）——不要合并。`);
      return code;
    }

    if (taskId === undefined) {
      out("外层测试全部通过。canonical 验收不签发 task receipt。");
      return 0;
    }

    try {
      const receipt = recordOuterTestPass(
        db,
        taskId,
        cwd,
        fullManualPlan.fromProfile,
        fullManualPlan.files,
        Date.now(),
        expectedCommit,
      );
      out(`外层测试全部通过；已记录 transitional manual host receipt（commit ${receipt.commit}）。`);
      return 0;
    } catch (e) {
      out(`外层测试通过，但 receipt 签发失败：${e instanceof Error ? e.message : String(e)}`);
      out("不要合并；重新确认 task HEAD/worktree 后再次执行 outer-test。");
      return 1;
    }
  } finally {
    db.close();
  }
}

function cmdRevoke(out: (l: string) => void, yes: boolean): number {
  return withDbExitCode(out, (db) => {
    const before = currentEpoch(db);
    if (!yes) {
      out(`当前 epoch：${before}`);
      out("");
      out("加 --yes 会把它递增到 " + (before + 1) + "，届时：");
      out("  · 所有已签发的 access token 立即失效（不等 8 小时过期）");
      out("  · 客户端会收到 401 + WWW-Authenticate，需要重新走一次授权");
      out("  · refresh token 不受影响——它们仍能换新 access token。");
      out("    要连 refresh 一起断，另行清理 oauth_refresh（尚无命令，见遗留表）");
      out("");
      out("这个动作不可撤销（epoch 只增不减）。");
      return 0;
    }
    const after = bumpEpoch(db);
    out(`epoch ${before} → ${after}`);
    out("所有在途 access token 已失效。客户端下一次请求会拿到 401 并重新授权。");
    return 0;
  });
}

async function cmdSelfCheck(out: (l: string) => void): Promise<number> {
  const issuer = process.env.GRANDE_ISSUER;
  if (!issuer) {
    out("GRANDE_ISSUER 未设置——它决定令牌的 aud，必须与网关启动时用的值完全一致。");
    out("例如：GRANDE_ISSUER=https://grande.agentjoey.ai grande selfcheck");
    return 1;
  }
  let layout: Layout;
  try {
    layout = loadLayout();
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  }
  ensureLayout(layout);
  const db = openDb(layout);

  const port = process.env.PORT || "8787";
  const host = process.env.GRANDE_HOST ?? "127.0.0.1";
  const baseUrl = `http://${host}:${port}`;

  try {
    const result = await selfCheck({ issuer, db, keyPath: join(layout.controlRoot, "secrets", "oauth-key"), baseUrl });
    for (const line of renderSelfCheck(result)) out(line);
    return result.httpStatus === 200 ? 0 : 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out(`连不上网关：${msg}`);
    out("");
    out(`试的是 ${baseUrl}/mcp。自检需要网关【正在运行】——它走的是真实的 HTTP`);
    out("路径（bearer 校验、epoch 检查、MCP 序列化都算数），本地推断没有意义。");
    out("先 `pnpm start` 或检查 PORT / GRANDE_HOST 是否与网关一致。");
    return 1;
  } finally {
    db.close();
  }
}

function cmdGc(out: (l: string) => void, apply: boolean): number {
  return withDbExitCode(out, (db, layout) => {
    const plan = planGc(db, layout);

    out(`孤儿 worktree（磁盘有、库里没有）：${plan.orphanWorktrees.length} 条`);
    for (const o of plan.orphanWorktrees) {
      out(`  ${o.repoId}/${o.taskId}`);
      out(`    路径    ${o.path}`);
      out(`    分支    ${o.branch ?? "（无）"}`);
    }

    out("");
    out(`幽灵 task（库里有、磁盘没有）：${plan.ghostTasks.length} 条`);
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

    const orphanSkipped = plan.orphanWorktrees.length - result.removed;
    const ghostSkipped = plan.ghostTasks.length - result.closed;
    if (orphanSkipped > 0) {
      out(`  ⚠️  ${orphanSkipped} 条孤儿 worktree 无法回收（目录仍存在，可能是权限不足或 repo 未注册）`);
    }
    if (ghostSkipped > 0) {
      out(`  ⚠️  ${ghostSkipped} 条幽灵 task 无法关闭`);
    }

    out("完成。");
    return 0;
  });
}

/** @returns 进程退出码 */
export function runCli(
  argv: string[],
  out: (line: string) => void,
  options: RunCliOptions = {},
): number | Promise<number> {
  const [cmd, ...rest] = argv;
  const taskIdx = rest.indexOf("--task");
  const taskDangling = taskIdx >= 0 && rest[taskIdx + 1] === undefined;
  const taskId = taskIdx >= 0 ? rest[taskIdx + 1] : undefined;
  const repoIdx = rest.indexOf("--repo");
  const repoDangling = repoIdx >= 0 && rest[repoIdx + 1] === undefined;
  const repoId = repoIdx >= 0 ? rest[repoIdx + 1] : undefined;

  if (taskDangling && (cmd === "jobs" || cmd === "audit" || cmd === "status" || cmd === "outer-test")) {
    out("用法错误：--task 后面需要一个任务 id，例如 --task task_abc");
    return 1;
  }
  if (repoDangling && cmd === "doctor") {
    out("用法错误：--repo 后面需要一个 repo id，例如 --repo grande-gpt");
    return 1;
  }

  if (taskId !== undefined && (cmd === "jobs" || cmd === "audit" || cmd === "outer-test")) {
    try {
      assertValidId(taskId, "--task");
    } catch (e) {
      out(`用法错误：${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  if (repoId !== undefined && cmd === "doctor") {
    try {
      assertValidId(repoId, "--repo");
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
      return repoId === undefined ? cmdDoctor(out) : cmdProjectDoctor(out, repoId);
    case "repo":
      return cmdRepo(out, rest);
    case "gateway":
      return runGatewayCli(rest, out);
    case "gc":
      return cmdGc(out, rest.includes("--apply"));
    case "outer-test":
      return cmdOuterTest(
        out,
        rest.includes("--run"),
        taskId,
        options.outerTestSpawn,
        options.restrictedOuterTestRun,
      );
    case "revoke":
      return cmdRevoke(out, rest.includes("--yes"));
    case "selfcheck":
      return cmdSelfCheck(out);
    default:
      if (cmd !== undefined) out(`未知命令：${cmd}`);
      out(USAGE);
      return 1;
  }
}

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
  Promise.resolve(runCli(process.argv.slice(2), (l) => console.log(l)))
    .then((code) => process.exit(code));
}
