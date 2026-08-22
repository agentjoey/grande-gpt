import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./layout.ts";

export type RepoProcessLockErrorCode = "REPO_BUSY" | "LOCK_METADATA_INVALID" | "LOCK_OWNERSHIP_LOST";

export class RepoProcessLockError extends Error {
  readonly code: RepoProcessLockErrorCode;

  constructor(code: RepoProcessLockErrorCode, message: string) {
    super(message);
    this.name = `RepoProcessLockError [${code}]`;
    this.code = code;
  }
}

interface RepoProcessLockMetadata {
  pid: number;
  repoId: string;
  acquiredAt: number;
  nonce: string;
}

export interface RepoProcessLockHandle {
  repoId: string;
  lockPath: string;
  recoveredStale: boolean;
  release(): void;
}

function lockRoot(layout: Pick<Layout, "controlRoot">): string {
  return join(layout.controlRoot, "locks", "repos");
}

function lockPath(layout: Pick<Layout, "controlRoot">, repoId: string): string {
  if (typeof repoId !== "string" || repoId.length === 0) {
    throw new RepoProcessLockError("LOCK_METADATA_INVALID", "repo process lock 的 repoId 不能为空");
  }
  // repoId 本身不进入路径。哈希文件名既固定、可重算，又不会把分隔符/Unicode 变成路径语义。
  const digest = createHash("sha256").update(repoId, "utf8").digest("hex");
  return join(lockRoot(layout), `${digest}.lock`);
}

function parseMetadata(raw: string, path: string): RepoProcessLockMetadata {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RepoProcessLockError("LOCK_METADATA_INVALID", `repo lock metadata malformed / 不可信，需 Human 检查：${path}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new RepoProcessLockError("LOCK_METADATA_INVALID", `repo lock metadata malformed / 不可信，需 Human 检查：${path}`);
  }
  const row = value as Record<string, unknown>;
  if (
    !Number.isInteger(row.pid) || (row.pid as number) <= 0
    || typeof row.repoId !== "string" || row.repoId.length === 0
    || !Number.isInteger(row.acquiredAt) || (row.acquiredAt as number) <= 0
    || typeof row.nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.nonce)
  ) {
    throw new RepoProcessLockError("LOCK_METADATA_INVALID", `repo lock metadata malformed / 不可信，需 Human 检查：${path}`);
  }
  return row as unknown as RepoProcessLockMetadata;
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM 仍表示进程存在，只是无权 signal；只有 ESRCH 明确表示不存在。
    return code !== "ESRCH";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

/**
 * 跨进程、fail-closed 的窄 repo advisory lock。创建用 O_EXCL (`wx`)；live owner 立即 busy；
 * dead PID 允许清理一次 stale lock 后重试。malformed metadata 永不自动删除。
 */
export function acquireRepoProcessLock(
  layout: Pick<Layout, "controlRoot">,
  repoId: string,
): RepoProcessLockHandle {
  const root = lockRoot(layout);
  const path = lockPath(layout, repoId);
  mkdirSync(root, { recursive: true });

  let recoveredStale = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const metadata: RepoProcessLockMetadata = {
      pid: process.pid,
      repoId,
      acquiredAt: Date.now(),
      nonce: randomUUID(),
    };
    try {
      writeFileSync(path, JSON.stringify(metadata), { encoding: "utf8", flag: "wx", mode: 0o600 });
      let released = false;
      return {
        repoId,
        lockPath: path,
        recoveredStale,
        release(): void {
          if (released) return;
          const current = parseMetadata(readFileSync(path, "utf8"), path);
          if (current.pid !== metadata.pid || current.repoId !== metadata.repoId || current.nonce !== metadata.nonce) {
            throw new RepoProcessLockError(
              "LOCK_OWNERSHIP_LOST",
              `repo lock ownership/nonce 已变化，拒绝删除不属于当前 owner 的锁：${path}`,
            );
          }
          unlinkSync(path);
          released = true;
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const raw = readFileSync(path, "utf8");
      const existing = parseMetadata(raw, path);
      if (existing.repoId !== repoId) {
        throw new RepoProcessLockError(
          "LOCK_METADATA_INVALID",
          `repo lock metadata repoId 与 lock key 不一致，拒绝自动处理：${path}`,
        );
      }
      if (pidIsLive(existing.pid)) {
        throw new RepoProcessLockError(
          "REPO_BUSY",
          `repo ${repoId} busy：live process pid=${existing.pid} 已持有跨进程写锁`,
        );
      }
      if (attempt > 0) {
        throw new RepoProcessLockError("REPO_BUSY", `repo ${repoId} stale lock recovery 已重试一次，拒绝继续竞争`);
      }

      // 删除前重新读一次，若内容已变化则说明有竞争者接管/改写，fail closed 而不是误删。
      if (readFileSync(path, "utf8") !== raw) {
        throw new RepoProcessLockError("REPO_BUSY", `repo ${repoId} lock 在 stale recovery 期间发生变化，拒绝删除`);
      }
      unlinkSync(path);
      recoveredStale = true;
    }
  }

  throw new RepoProcessLockError("REPO_BUSY", `repo ${repoId} 无法取得跨进程写锁`);
}
