import type { DatabaseSync } from "node:sqlite";
import { getJob, TERMINAL } from "./jobs.ts";

export const JOB_RESULT_WAIT_MS = 15_000;

const DEFAULT_INTERVAL_MS = 250;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  },
): Promise<void> {
  const timeoutMs = Math.min(
    JOB_RESULT_WAIT_MS,
    Math.max(0, options?.timeoutMs ?? JOB_RESULT_WAIT_MS),
  );
  const intervalMs = Math.max(1, options?.intervalMs ?? DEFAULT_INTERVAL_MS);
  const sleep = options?.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;

  let job = getJob(db, jobId);
  while (job && !TERMINAL.has(job.state) && Date.now() < deadline) {
    await sleep(Math.min(intervalMs, deadline - Date.now()));
    job = getJob(db, jobId);
  }
}
