import type { DatabaseSync } from "node:sqlite";
import {
  reconcileExpiredAuthorizations,
  type AuthorizationExpiryReconciliationResult,
} from "./authorizationExpiry.ts";
import type { Layout } from "./layout.ts";
import {
  reconcileTaskLifecycleWithRepoWriteLocks,
  type TaskLifecycleRecoveryResult,
} from "./taskLifecycleRecovery.ts";

const DEFAULT_INTERVAL_MS = 60_000;

type ReconcileFn = (
  db: DatabaseSync,
  layout: Layout,
) => Promise<TaskLifecycleRecoveryResult>;

type AuthorizationReconcileFn = (
  db: DatabaseSync,
) => AuthorizationExpiryReconciliationResult;

type IntervalHandle = ReturnType<typeof setInterval>;

export interface LifecycleReconciliationResult extends TaskLifecycleRecoveryResult {
  authorizationsExpired: number;
}

export interface TaskLifecycleReconcilerOptions {
  intervalMs?: number;
  reconcile?: ReconcileFn;
  reconcileAuthorizations?: AuthorizationReconcileFn;
  setIntervalFn?: (callback: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (timer: IntervalHandle) => void;
  onResult?: (phase: "startup" | "periodic", result: LifecycleReconciliationResult) => void;
  onError?: (phase: "startup" | "periodic", error: unknown) => void;
}

export interface TaskLifecycleReconcilerController {
  stop(): void;
}

/** Run startup reconciliation, then repeat at a bounded fixed interval without overlap. */
export async function startTaskLifecycleReconciler(
  db: DatabaseSync,
  layout: Layout,
  options: TaskLifecycleReconcilerOptions = {},
): Promise<TaskLifecycleReconcilerController> {
  const reconcile = options.reconcile ?? reconcileTaskLifecycleWithRepoWriteLocks;
  const reconcileAuthorizations = options.reconcileAuthorizations ?? reconcileExpiredAuthorizations;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;
  let stopped = false;

  const run = async (phase: "startup" | "periodic"): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      let taskResult: TaskLifecycleRecoveryResult | undefined;
      try {
        taskResult = await reconcile(db, layout);
      } catch (error) {
        options.onError?.(phase, error);
      }
      // Task recovery failure must not suppress the independent approval-TTL sweep.
      try {
        const authorizationResult = reconcileAuthorizations(db);
        if (taskResult) {
          options.onResult?.(phase, {
            ...taskResult,
            authorizationsExpired: authorizationResult.expired,
          });
        }
      } catch (error) {
        options.onError?.(phase, error);
      }
    } finally {
      running = false;
    }
  };

  await run("startup");
  const timer = setIntervalFn(() => { void run("periodic"); }, intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}
