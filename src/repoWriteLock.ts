import type { Layout } from "./layout.ts";
import { acquireRepoProcessLock, type RepoProcessLockHandle } from "./repoProcessLock.ts";

const repoTails = new Map<string, Promise<void>>();

/**
 * 按 repoId 串行化写临界区：保留 Gateway 进程内 FIFO 队列；只有排到队首的 active
 * critical section 才申请跨进程 lock。不同 repoId 仍完全独立，operation 本身不重试。
 */
export async function withRepoWriteLock<T>(
  repoId: string,
  operation: () => Promise<T> | T,
  layout: Pick<Layout, "controlRoot">,
): Promise<T> {
  const previous = repoTails.get(repoId);
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  repoTails.set(repoId, current);

  if (previous) await previous;
  let processLock: RepoProcessLockHandle | undefined;
  try {
    processLock = acquireRepoProcessLock(layout, repoId);
    return await operation();
  } finally {
    try {
      processLock?.release();
    } finally {
      releaseQueue();
      if (repoTails.get(repoId) === current) repoTails.delete(repoId);
    }
  }
}
