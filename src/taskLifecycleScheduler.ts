import type { DatabaseSync } from "node:sqlite";
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

type IntervalHandle = ReturnType<typeof setInterval>;

export interface TaskLifecycleReconcilerOptions {
  intervalMs?: number;
  reconcile?: ReconcileFn;
  setIntervalFn?: (callback: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (timer: IntervalHandle) => void;
  onResult?: (phase: "startup" | "periodic", result: TaskLifecycleRecoveryResult) => void;
  onError?: (phase: "startup" | "periodic", error: unknown) => void;
}

export interface TaskLifecycleReconcilerController {
  stop(): void;
}

/** Run one startup reconciliation, then repeat at a bounded fixed interval without overlap. */
export async function startTaskLifecycleReconciler(
  db: DatabaseSync,
  layout: Layout,
  options: TaskLifecycleReconcilerOptions = {},
): Promise<TaskLifecycleReconcilerController> {
  const reconcile = options.reconcile ?? reconcileTaskLifecycleWithRepoWriteLocks;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;
  let stopped = false;

  const run = async (phase: "startup" | "periodic"): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await reconcile(db, layout);
      options.onResult?.(phase, result);
    } catch (error) {
      options.onError?.(phase, error);
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
