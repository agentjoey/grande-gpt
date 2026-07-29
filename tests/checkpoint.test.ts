import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import {
  createCheckpoint,
  restoreCheckpoint,
  type CheckpointManifestEntry,
} from "../src/checkpoint.ts";

const roots: string[] = [];

function makeLayout(): { layout: Layout; worktreeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "grande-checkpoint-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const controlRoot = join(root, "control");
  const worktreeRoot = join(workspaceRoot, ".grande-work", "worktrees", "grande-gpt", "task-1");
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  return {
    layout: {
      workspaceRoot,
      controlRoot,
      stateDb: join(controlRoot, "state", "grande.db"),
      configDir: join(controlRoot, "config"),
      reposConfig: join(controlRoot, "config", "repos.yaml"),
      artifactsDir: join(controlRoot, "artifacts"),
      derivedRoot: join(workspaceRoot, ".grande-work"),
      worktreesRoot: join(workspaceRoot, ".grande-work", "worktrees"),
    },
    worktreeRoot,
  };
}

function manifest(layout: Layout, checkpointId: string): CheckpointManifestEntry[] {
  return JSON.parse(
    readFileSync(join(layout.controlRoot, "checkpoints", "task-1", checkpointId, "manifest.json"), "utf8"),
  ) as CheckpointManifestEntry[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("checkpoint", () => {
  it("restores an existing file byte-for-byte", () => {
    const { layout, worktreeRoot } = makeLayout();
    const original = Buffer.from([0, 1, 2, 255, 10, 13]);
    const path = join(worktreeRoot, "src", "a.bin");
    mkdirSync(join(worktreeRoot, "src"), { recursive: true });
    writeFileSync(path, original);
    const checkpointId = createCheckpoint(layout, "task-1", worktreeRoot, ["src/a.bin"]);
    writeFileSync(path, Buffer.from("changed"));

    expect(restoreCheckpoint(layout, "task-1", worktreeRoot, checkpointId)).toEqual(["src/a.bin"]);
    expect(readFileSync(path)).toEqual(original);
  });

  it("moves a newly-created file to trash when restoring an absent path", () => {
    const { layout, worktreeRoot } = makeLayout();
    const checkpointId = createCheckpoint(layout, "task-1", worktreeRoot, ["created.txt"]);
    writeFileSync(join(worktreeRoot, "created.txt"), "new content", "utf8");

    restoreCheckpoint(layout, "task-1", worktreeRoot, checkpointId);

    expect(existsSync(join(worktreeRoot, "created.txt"))).toBe(false);
    const trashTaskRoot = join(layout.controlRoot, "trash", "task-1");
    const batches = readdirSync(trashTaskRoot);
    expect(batches).toHaveLength(1);
    expect(readFileSync(join(trashTaskRoot, batches[0]!, "created.txt"), "utf8")).toBe("new content");
  });

  it("snapshots only the explicitly requested paths", () => {
    const { layout, worktreeRoot } = makeLayout();
    writeFileSync(join(worktreeRoot, "included.txt"), "included", "utf8");
    writeFileSync(join(worktreeRoot, "other.txt"), "other", "utf8");

    const checkpointId = createCheckpoint(layout, "task-1", worktreeRoot, ["included.txt"]);
    const filesRoot = join(layout.controlRoot, "checkpoints", "task-1", checkpointId, "files");

    expect(readFileSync(join(filesRoot, "included.txt"), "utf8")).toBe("included");
    expect(existsSync(join(filesRoot, "other.txt"))).toBe(false);
  });

  it("records existedBefore and sha256 correctly in manifest.json", () => {
    const { layout, worktreeRoot } = makeLayout();
    const bytes = Buffer.from("before\n", "utf8");
    writeFileSync(join(worktreeRoot, "existing.txt"), bytes);

    const checkpointId = createCheckpoint(layout, "task-1", worktreeRoot, [
      "existing.txt",
      "missing.txt",
    ]);

    expect(manifest(layout, checkpointId)).toEqual([
      { path: "existing.txt", existedBefore: true, sha256: sha256(bytes) },
      { path: "missing.txt", existedBefore: false },
    ]);
  });

  it("throws NOT_FOUND for an unknown checkpoint without changing the worktree", () => {
    const { layout, worktreeRoot } = makeLayout();
    const path = join(worktreeRoot, "safe.txt");
    writeFileSync(path, "safe", "utf8");

    expect(() => restoreCheckpoint(layout, "task-1", worktreeRoot, "missing-checkpoint")).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(readFileSync(path, "utf8")).toBe("safe");
  });

  it("keeps consecutive checkpoints independent", () => {
    const { layout, worktreeRoot } = makeLayout();
    const path = join(worktreeRoot, "value.txt");
    writeFileSync(path, "one", "utf8");
    const first = createCheckpoint(layout, "task-1", worktreeRoot, ["value.txt"]);
    writeFileSync(path, "two", "utf8");
    const second = createCheckpoint(layout, "task-1", worktreeRoot, ["value.txt"]);
    expect(first).not.toBe(second);

    writeFileSync(path, "three", "utf8");
    restoreCheckpoint(layout, "task-1", worktreeRoot, first);
    expect(readFileSync(path, "utf8")).toBe("one");
    restoreCheckpoint(layout, "task-1", worktreeRoot, second);
    expect(readFileSync(path, "utf8")).toBe("two");
  });
});
