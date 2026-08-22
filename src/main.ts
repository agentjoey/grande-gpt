import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { openDb } from "./db.ts";
import { ensureLayout, loadLayout } from "./layout.ts";
import { startGateway } from "./server.ts";
import { loadAccessConfig, AccessConfigError, type AccessConfig } from "./accessGate.ts";
import { loadConsoleAccessConfig } from "./consoleAuth.ts";
import { awaitAllJobsSettled } from "./runner.ts";
import { planGc, applyGcWithRepoWriteLocks } from "./worktreeGc.ts";

/**
 * Gateway 的进程入口。
 *
 * `GRANDE_ISSUER` 必须显式给出，且必须与 ChatGPT 侧配置的 Server URL 同源 ——
 * 它决定令牌 `aud` 的取值与发现文档里的每一个 URL。猜错的后果不是启动失败，
 * 而是**签出来的令牌打不开自己的端点**，症状极隐蔽。与 `GRANDE_WORKSPACE`
 * 一样，不给默认值：失败得响远比失败得静默好。
 */
async function main(): Promise<void> {
  const issuer = process.env.GRANDE_ISSUER;
  if (!issuer) {
    throw new Error(
      "GRANDE_ISSUER 未设置。请指向 ChatGPT 侧配置的 Server URL 的源，" +
        "例如 GRANDE_ISSUER=https://grande.agentjoey.ai",
    );
  }
  const layout = loadLayout();
  ensureLayout(layout);
  // 在启动时读一次、校验一次——缺失或格式错误必须在这里响亮地拒绝启动，
  // 而不是留到第一个用户登录时才在请求路径里发现。
  const accessConfig = loadAccessConfig(layout);
  // 控制台配置缺失不致命：没配就是没装控制台，写端点整组不挂载。
  // 但**格式错误是致命的**——那说明有人试图配它却配错了，静默跳过会让人以为装上了。
  let consoleAccessConfig: AccessConfig | undefined;
  try {
    consoleAccessConfig = loadConsoleAccessConfig(layout);
  } catch (e) {
    if (e instanceof AccessConfigError && e.code === "MISSING_CONFIG") {
      console.log("[gateway] 未配置控制台 Access（access-console.yaml 不存在），写端点不挂载");
    } else {
      throw e;
    }
  }
  const db = openDb(layout);

  const gw = await startGateway({ issuer, layout, db, accessConfig, consoleAccessConfig });
  const port = Number(process.env.PORT || "8787");
  // 打印【实际】绑定地址而不是硬编码的 127.0.0.1——上一版那行字是假的，
  // 而它恰恰是「以为只绑了 loopback」这个错误认知的来源之一。
  console.log(`[gateway] listening on ${process.env.GRANDE_HOST ?? "127.0.0.1"}:${port}  issuer=${issuer}`);
  console.log(`[gateway] workspace=${layout.workspaceRoot}`);
  console.log(`[gateway] control=${layout.controlRoot}`);

  // 方向 B：幽灵 task → CLOSED（纯数据修复，零风险——worktree 目录已经不存在，
  // 没有东西可删）。Gateway 已经开始监听，因此即使这是启动对账，也必须和正常写工具
  // 共用 repo write lock，不能与同 repo 的 task_open/close 等写操作重叠。
  const gcPlan = planGc(db, layout);
  if (gcPlan.ghostTasks.length > 0) {
    const { closed } = await applyGcWithRepoWriteLocks(db, layout, {
      orphanWorktrees: [],
      ghostTasks: gcPlan.ghostTasks,
      closedResidualWorktrees: [],
    });
    console.log(`[gateway] 启动对账：关闭了 ${closed} 个幽灵 task（worktree 已不存在的 task 记录）`);
  }

  // 方向 A：孤儿 worktree（磁盘有、库里没有）绝不在启动时自动删除——删文件必须是
  // 人显式 `grande gc --apply` 的动作。只提示有 N 个孤儿、建议跑 grande gc。
  if (gcPlan.orphanWorktrees.length > 0) {
    console.log(`[gateway] 发现 ${gcPlan.orphanWorktrees.length} 个孤儿 worktree（磁盘上有但没有对应 task 记录），建议运行 \`grande gc\` 查看详情`);
  }
  // 第三类同样涉及删除真实 worktree：启动时只提示，绝不自动清理。
  if (gcPlan.closedResidualWorktrees.length > 0) {
    console.log(`[gateway] 发现 ${gcPlan.closedResidualWorktrees.length} 个 CLOSED task 残留 worktree，建议运行 \`grande gc\` 查看详情`);
  }

  // 优雅关停：先停止接受新连接，**再等在途的后台 job 收尾写完 artifact**，最后才
  // 关库退出。硬杀会让 runner 的 .then 链在 db.close() 之后落地——那正是 S0-C 修过的
  // unhandled rejection 形态。
  //
  // 这段此前只有注释没有实现：`gw.close()` 之后直接 `db.close(); process.exit(0)`，
  // 从不调用为此存在的 awaitAllJobsSettled。实测后果（本机 job 表里留下的证据）：
  // 一个在子进程里真正跑完 90 秒的成功 job 被记成 `killed`、`artifactPath=null`，
  // 时长记的是下次启动时 reconcile 的时刻（66.1s）而不是真实的 90.0s。
  // 子进程是 detached 的，父进程退出杀不掉它，所以输出确实产生了——只是没人写下来。
  //
  // 超时 30s：足够绝大多数 job 收尾（收尾只是写 artifact + 一次 UPDATE），又不会让
  // 关停被一个刚起步的长 job 拖住。超时后照常退出，退化回 reconcile 兜底。
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      console.log(`\n[gateway] 收到 ${sig}，正在关停…`);
      void (async () => {
        await gw.close();
        const n = await awaitAllJobsSettled(30_000);
        if (n > 0) console.log(`[gateway] 已等待 ${n} 个在途 job 收尾`);
        db.close();
        process.exit(0);
      })();
    });
  }
}

/**
 * 入口守卫。用 `pathToFileURL(realpathSync(argv[1]))` 而不是拼
 * `file://${argv[1]}` —— 后者在经符号链接调用（`pnpm link` / `node_modules/.bin`
 * 的 shim 就是符号链接）、或路径含空格与非 ASCII 时会静默失配，结果是
 * **exit 0 且零输出**。S0-A 的 CLI 正是栽在这里，包装脚本会把它读成成功。
 */
const argv1 = process.argv[1];
if (argv1 !== undefined && pathToFileURL(realpathSync(argv1)).href === import.meta.url) {
  main().catch((e: unknown) => {
    console.error(`[gateway] 启动失败：${(e as Error).message}`);
    process.exit(1);
  });
}
