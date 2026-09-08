import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";

/**
 * Minimal V2 Task 1：显式、不可变的 delivery target。
 *
 * Phase 8 的 `resolveDeliveryTarget`（deliveryTarget.ts）只能从已有证据投影 target——
 * 因为那时不能动 public tool schema。V2 在 `grande_task_open` 增加可选字段
 * `deliveryTarget`，在 Task 创建时把显式选择持久化到 `task_delivery_target` 表：
 *
 * - 未提供时保持现有安全默认（legacy 投影：GitHub origin → pr，否则 local）；
 * - `deploy` 只能由这个显式字段产生，绝不从 repo 内容、README、已有 receipt 推断；
 * - target 创建后不可变：要换 target 就关掉旧 Task 开新 Task，于是重复写入不同取值
 *   是 `STALE_STATE`，相同取值是幂等 no-op（调用方重试/重入不该被罚）。
 */
export type DeliveryTarget = "local" | "pr" | "deploy";

const TARGETS: ReadonlySet<string> = new Set(["local", "pr", "deploy"]);

/** 校验外部输入为精确的 target 取值；拒绝一切自由文本与同义词（如 "production"）。 */
export function parseDeliveryTarget(value: unknown): DeliveryTarget {
  if (typeof value === "string" && TARGETS.has(value)) return value as DeliveryTarget;
  throw new StateError(
    "INVALID_INPUT",
    `deliveryTarget 必须是 "local"、"pr" 或 "deploy" 之一，收到 ${JSON.stringify(value)}。`,
  );
}

/**
 * 持久化 Task 创建时给出的显式 target。`BEGIN IMMEDIATE` 把「读旧值 → 决定 → 插入」
 * 收敛成一次写临界区：两个并发写入者不会都读到「没有行」再各自插入不同取值——
 * 后到的那个会在拿到写锁后看见先到的行，按不可变语义抛 STALE_STATE。
 */
export function saveExplicitDeliveryTarget(
  db: DatabaseSync,
  taskId: string,
  target: DeliveryTarget,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT target FROM task_delivery_target WHERE taskId=?")
      .get(taskId) as { target: string } | undefined;
    if (existing) {
      if (existing.target === target) {
        db.exec("COMMIT");
        return;
      }
      throw new StateError(
        "STALE_STATE",
        `任务 ${taskId} 的 deliveryTarget 已固定为 ${JSON.stringify(existing.target)}，` +
          `不可改为 ${JSON.stringify(target)}。如需更换 target，请关闭该任务后创建新任务。`,
      );
    }
    db.prepare("INSERT INTO task_delivery_target (taskId,target,createdAt) VALUES (?,?,?)")
      .run(taskId, target, Date.now());
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 连接可能已处于无法回滚的状态；原始错误才是调用方需要的信息。
    }
    throw error;
  }
}

/** 读取显式 target；没有行的旧任务返回 `undefined`，调用方回退到 legacy 投影。 */
export function getExplicitDeliveryTarget(
  db: DatabaseSync,
  taskId: string,
): DeliveryTarget | undefined {
  const row = db
    .prepare("SELECT target FROM task_delivery_target WHERE taskId=?")
    .get(taskId) as { target: string } | undefined;
  return row ? parseDeliveryTarget(row.target) : undefined;
}
