import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "./layout.ts";
import { assertTaskId, resolveInRepo } from "./paths.ts";
import { moveToTrash } from "./trash.ts";

export interface CheckpointManifestEntry {
  path: string;
  existedBefore: boolean;
  sha256?: string;
}

export class CheckpointError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = `CheckpointError [${code}]`;
    this.code = code;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkpointRoot(layout: Layout, taskId: string, checkpointId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(checkpointId)) {
    throw new CheckpointError("NOT_FOUND", `checkpoint 不存在：${checkpointId}`);
  }
  return join(layout.controlRoot, "checkpoints", taskId, checkpointId);
}

function createCheckpointId(): string {
  return `${new Date().toISOString()}-${randomBytes(6).toString("hex")}`;
}

/** Snapshot only the requested worktree paths in their current state. */
export function createCheckpoint(
  layout: Layout,
  taskId: string,
  worktreeRoot: string,
  relativePaths: readonly string[],
): string {
  assertTaskId(taskId);
  const checkpointId = createCheckpointId();
  const root = checkpointRoot(layout, taskId, checkpointId);
  const filesRoot = join(root, "files");
  mkdirSync(filesRoot, { recursive: true });

  const manifest: CheckpointManifestEntry[] = [];
  for (const relativePath of relativePaths) {
    const source = resolveInRepo(worktreeRoot, relativePath);
    const existedBefore = existsSync(source) && statSync(source).isFile();
    if (!existedBefore) {
      manifest.push({ path: relativePath, existedBefore: false });
      continue;
    }

    const bytes = readFileSync(source);
    const snapshotPath = join(filesRoot, relativePath);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, bytes);
    manifest.push({ path: relativePath, existedBefore: true, sha256: sha256(bytes) });
  }

  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return checkpointId;
}

/** Restore the requested worktree paths to a checkpoint and return paths actually changed. */
export function restoreCheckpoint(
  layout: Layout,
  taskId: string,
  worktreeRoot: string,
  checkpointId: string,
): string[] {
  assertTaskId(taskId);
  const root = checkpointRoot(layout, taskId, checkpointId);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new CheckpointError("NOT_FOUND", `checkpoint 不存在：${checkpointId}`);
  }

  const entries = JSON.parse(readFileSync(manifestPath, "utf8")) as CheckpointManifestEntry[];
  const restored: string[] = [];

  for (const entry of entries) {
    const target = resolveInRepo(worktreeRoot, entry.path);
    if (!entry.existedBefore) {
      if (existsSync(target)) {
        moveToTrash(layout, taskId, worktreeRoot, entry.path);
        restored.push(entry.path);
      }
      continue;
    }

    const snapshot = join(root, "files", entry.path);
    const snapshotBytes = readFileSync(snapshot);
    const currentMatches =
      existsSync(target) && statSync(target).isFile() && sha256(readFileSync(target)) === entry.sha256;
    if (!currentMatches) {
      if (existsSync(target)) {
        moveToTrash(layout, taskId, worktreeRoot, entry.path);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, snapshotBytes);
      restored.push(entry.path);
    }
  }

  return restored;
}
