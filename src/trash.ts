import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "./layout.ts";
import { assertTaskId, resolveInRepo } from "./paths.ts";

export interface TrashEntry {
  trashPath: string;
  relativePath: string;
  movedAt: number;
}

export class TrashError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = `TrashError [${code}]`;
    this.code = code;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function createUniqueBatchDir(base: string, movedAt: number): string {
  mkdirSync(base, { recursive: true });
  const timestamp = new Date(movedAt).toISOString();

  for (let seq = 0; ; seq += 1) {
    const candidate = join(base, `${timestamp}-${seq}`);
    try {
      mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw error;
    }
  }
}

/** Move one worktree file into the control-plane trash while preserving its relative structure. */
export function moveToTrash(
  layout: Layout,
  taskId: string,
  worktreeRoot: string,
  relativePath: string,
): TrashEntry {
  assertTaskId(taskId);
  const source = resolveInRepo(worktreeRoot, relativePath);
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new TrashError("FILE_NOT_FOUND", `文件不存在：${relativePath}`);
  }

  const movedAt = Date.now();
  const batchDir = createUniqueBatchDir(join(layout.controlRoot, "trash", taskId), movedAt);
  const trashPath = join(batchDir, relativePath);
  mkdirSync(dirname(trashPath), { recursive: true });

  try {
    renameSync(source, trashPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EXDEV") throw error;
    copyFileSync(source, trashPath);
    unlinkSync(source);
  }

  return { trashPath, relativePath, movedAt };
}
