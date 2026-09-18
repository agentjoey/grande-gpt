import { constants, closeSync, fstatSync, openSync, readFileSync, statfsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateError } from "./errors.ts";
import type { Layout } from "./layout.ts";

export interface ResourcePolicy {
  globalJobs: number;
  perTaskJobs: number;
  minFreeBytes: number;
}

/** Conservative defaults, not a measured host capacity or a filesystem quota. */
export const DEFAULT_RESOURCE_POLICY: Readonly<ResourcePolicy> = Object.freeze({
  globalJobs: 2,
  perTaskJobs: 1,
  minFreeBytes: 2 * 1024 ** 3,
});

/** Only the fixed trusted control-plane file is read; repo files and MCP args cannot override it. */
export function loadResourcePolicy(layout: Layout): ResourcePolicy {
  let fd: number;
  try { fd = openSync(join(layout.configDir, "resource-policy.json"), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_RESOURCE_POLICY };
    throw new StateError("POLICY_DENIED", "无法读取可信 resource-policy.json 配置。");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("resource policy must be a bounded regular file");
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid resource policy object");
    const result = { ...DEFAULT_RESOURCE_POLICY };
    for (const [key, input] of Object.entries(value)) {
      if (key !== "globalJobs" && key !== "perTaskJobs" && key !== "minFreeBytes") throw new Error(`unknown resource policy key: ${key}`);
      if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1
          || (key !== "minFreeBytes" && input > 64)) throw new Error(`invalid resource policy ${key}`);
      result[key] = input;
    }
    if (result.perTaskJobs > result.globalJobs) throw new Error("perTaskJobs exceeds globalJobs");
    return result;
  } catch (error) {
    throw new StateError("POLICY_DENIED", `资源配置无效：${error instanceof Error ? error.message : String(error)}`);
  } finally { closeSync(fd); }
}

export interface DiskHeadroom { device: string; availableBytes: number; minimumBytes: number; roots: string[] }

function existingAncestor(path: string): string {
  let current = path;
  for (;;) {
    try {
      if (!statSync(current).isDirectory()) throw new Error("resource root is not a directory");
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      current = dirname(current);
    }
  }
}

/** Probe every destination volume before allocation. Recovery reads never call this gate. */
export function assertDiskHeadroom(
  layout: Layout,
  policy = loadResourcePolicy(layout),
  additionalRoots: readonly string[] = [],
): DiskHeadroom[] {
  const volumes = new Map<string, DiskHeadroom>();
  const roots = [layout.workspaceRoot, layout.derivedRoot, layout.controlRoot, layout.artifactsDir, ...additionalRoots];
  try {
    for (const root of new Set(roots)) {
      const path = existingAncestor(root);
      const device = String(statSync(path, { bigint: true }).dev);
      const previous = volumes.get(device);
      if (previous) { previous.roots.push(root); continue; }
      const stat = statfsSync(path, { bigint: true });
      if (stat.bsize <= 0n || stat.bavail < 0n) throw new Error("invalid filesystem capacity");
      const free = stat.bavail * stat.bsize;
      const availableBytes = Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free);
      volumes.set(device, { device, availableBytes, minimumBytes: policy.minFreeBytes, roots: [root] });
    }
  } catch (error) {
    throw new StateError("RESOURCE_EXHAUSTED", `无法可靠检查磁盘空间；拒绝新资源消耗：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const volume of volumes.values()) {
    if (volume.availableBytes < volume.minimumBytes) {
      throw new StateError("RESOURCE_EXHAUSTED", `磁盘空间不足：device=${volume.device}, available=${volume.availableBytes}, minimum=${volume.minimumBytes} bytes；查询、取消和维护仍可用。`);
    }
  }
  return [...volumes.values()];
}
