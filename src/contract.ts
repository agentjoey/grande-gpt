/**
 * GrandeGPT 与控制台之间的**共享契约**。
 *
 * ## 为什么存在
 *
 * 2026-08-05 的架构审查发现：两个仓库之间有 4 处「必须同步移动」的定义
 * （schema 版本、`JobState` 六值、审计状态机、工具名单），而**没有任何机制强制**。
 * 改一边不会有任何报错。
 *
 * 后果已经真实发生过：`JobState` 有六个值，而控制台的图表只认三个，
 * 于是**墙钟超时的 job 在图上掉进一个没有名字的浅灰**——那是独立 Review 查出来的。
 * 有了这个文件，同类漏改会变成**编译错误**而不是运行时的静默错误。
 *
 * ## ⚠️ 这个文件必须保持【零 import】
 *
 * 控制台（Next.js）直接引用它。零 import 意味着：
 * ① 不会把网关的运行时代码拖进控制台的 bundle；
 * ② 不用处理 `.ts` 扩展名的解析差异——没有东西要解析。
 *
 * **加任何 import 都会破坏这两条。** 需要别的东西时，把它也做成零依赖的常量。
 */

// ─────────────────────────────────────────────────────────────────────────
// 状态库 schema
// ─────────────────────────────────────────────────────────────────────────

/**
 * 状态库 schema 版本。**网关与控制台必须一致**，否则控制台的查询可能读出
 * 似是而非的数字——那比读不出来更危险。
 *
 * 迁移历史见 `db.ts` 顶部。
 */
export const SCHEMA_VERSION = 6;

// ─────────────────────────────────────────────────────────────────────────
// Job 状态机
// ─────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ **六个值，不是三个。**
 *
 * `runner.ts` 里：墙钟超时写 `timeout`，RSS 兜底与重启对账写 `killed`。
 * 把这两者混为一谈，或者只认 passed/failed/killed，都会让一部分 job 无处归类。
 */
export const JOB_STATES = [
  "running", "passed", "failed", "timeout", "killed", "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** 已经结束的 job。`running` 之外的全部。 */
export const TERMINAL_JOB_STATES = JOB_STATES.filter((s) => s !== "running");

/**
 * 「没跑完就结束了」——超时 / 被杀 / 取消。
 * 对「有没有事」这个问题它们答案相同，所以控制台把它们合并成一个视觉分类。
 */
export const ABORTED_JOB_STATES: readonly JobState[] = ["timeout", "killed", "cancelled"];

// ─────────────────────────────────────────────────────────────────────────
// 审计状态机
// ─────────────────────────────────────────────────────────────────────────

export const AUDIT_DECISIONS = ["PENDING", "ALLOWED", "DENIED"] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

export const AUDIT_STATES = ["INTENT", "EXECUTING", "SUCCEEDED", "FAILED"] as const;
export type AuditState = (typeof AUDIT_STATES)[number];

/**
 * 审计的终态。**不要在别处再写一遍 `['SUCCEEDED','FAILED']`** ——
 * 那是遗留表 #1 记录的形状（`task_close` 写 `state === "running"` 而不用集合），
 * 今天行为等价，将来加状态就漏。
 */
export const TERMINAL_AUDIT_STATES: readonly AuditState[] = ["SUCCEEDED", "FAILED"];

export function isTerminalAudit(s: string): boolean {
  return (TERMINAL_AUDIT_STATES as readonly string[]).includes(s);
}

// ─────────────────────────────────────────────────────────────────────────
// 工具名单
// ─────────────────────────────────────────────────────────────────────────

/**
 * 会进审计账本的 MCP 工具。**只读工具不进账本**——所以这份名单等于账本里
 * `tool` 列的全部可能取值（`console_*` 除外，见下）。
 *
 * 上一版控制台按这份名单做过一个「仅写操作」筛选，实测发现它等于「全部」，
 * 因为账本本来就只记写操作。那个筛选已删。
 */
export const MCP_WRITE_TOOLS = [
  "grande_task_open", "grande_repo_edit", "grande_run", "grande_task_close",
  "grande_rollback", "grande_commit", "grande_sync_base", "grande_push", "grande_pr_open",
  "grande_capability_invoke", "grande_pr_merge", "grande_deploy", "grande_deploy_verify",
  "grande_deploy_rollback", "grande_repo_add_apply",
] as const;

/** 控制台经 Gateway 执行的操作（方案 A）。它们同样进账本。 */
export const CONSOLE_TOOLS = [
  "console_kill_job", "console_revoke_all", "console_audit_ack",
] as const;

export type AuditedTool = (typeof MCP_WRITE_TOOLS)[number] | (typeof CONSOLE_TOOLS)[number];
