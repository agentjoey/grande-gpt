import type { DatabaseSync } from "node:sqlite";
import { getJob, TERMINAL } from "./jobs.ts";

export const JOB_RESULT_WAIT_MS = 15_000;

const DEFAULT_INTERVAL_MS = 250;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const defaultNow = (): number => performance.now();

/**
 * Wait briefly for an existing running job to reach a terminal state.
 * This observes SQLite only; it never changes or restarts the job.
 */
export async function waitForTerminalJob(
  db: DatabaseSync,
  jobId: string,
  options?: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<void> {
  const timeoutMs = Math.min(
    JOB_RESULT_WAIT_MS,
    Math.max(0, options?.timeoutMs ?? JOB_RESULT_WAIT_MS),
  );
  const intervalMs = Math.max(1, options?.intervalMs ?? DEFAULT_INTERVAL_MS);
  const sleep = options?.sleep ?? defaultSleep;
  const now = options?.now ?? defaultNow;

  let job = getJob(db, jobId);
  if (!job || TERMINAL.has(job.state)) return;

  const deadline = now() + timeoutMs;
  while (job && !TERMINAL.has(job.state)) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return;
    await sleep(Math.min(intervalMs, remainingMs));
    job = getJob(db, jobId);
  }
}
