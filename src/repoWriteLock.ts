const repoTails = new Map<string, Promise<void>>();

/**
 * 进程内、按 repoId 串行化写临界区。只协调当前 Gateway 进程；不做跨进程锁、
 * 不重试 operation，也不引入持久队列。不同 repoId 完全独立。
 */
export async function withRepoWriteLock<T>(
  repoId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const previous = repoTails.get(repoId);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  repoTails.set(repoId, current);

  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repoTails.get(repoId) === current) repoTails.delete(repoId);
  }
}
