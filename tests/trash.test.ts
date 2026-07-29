import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import { moveToTrash } from "../src/trash.ts";

const roots: string[] = [];

function makeLayout(): { layout: Layout; worktreeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "grande-trash-"));
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

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("moveToTrash()", () => {
  it("moves a file out of the worktree and preserves its bytes", () => {
    const { layout, worktreeRoot } = makeLayout();
    const source = join(worktreeRoot, "src", "a.bin");
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13]);
    mkdirSync(join(worktreeRoot, "src"), { recursive: true });
    writeFileSync(source, bytes);

    const entry = moveToTrash(layout, "task-1", worktreeRoot, "src/a.bin");

    expect(existsSync(source)).toBe(false);
    expect(readFileSync(entry.trashPath)).toEqual(bytes);
    expect(entry.relativePath).toBe("src/a.bin");
    expect(Number.isFinite(entry.movedAt)).toBe(true);
  });

  it("stores trash under controlRoot and outside workspaceRoot", () => {
    const { layout, worktreeRoot } = makeLayout();
    const source = join(worktreeRoot, "a.txt");
    writeFileSync(source, "hello", "utf8");

    const entry = moveToTrash(layout, "task-1", worktreeRoot, "a.txt");

    expect(isUnder(layout.controlRoot, entry.trashPath)).toBe(true);
    expect(isUnder(layout.workspaceRoot, entry.trashPath)).toBe(false);
  });

  it("keeps both copies when the same path is trashed twice", () => {
    const { layout, worktreeRoot } = makeLayout();
    const source = join(worktreeRoot, "same.txt");
    writeFileSync(source, "first", "utf8");
    const first = moveToTrash(layout, "task-1", worktreeRoot, "same.txt");

    writeFileSync(source, "second", "utf8");
    const second = moveToTrash(layout, "task-1", worktreeRoot, "same.txt");

    expect(first.trashPath).not.toBe(second.trashPath);
    expect(readFileSync(first.trashPath, "utf8")).toBe("first");
    expect(readFileSync(second.trashPath, "utf8")).toBe("second");
  });

  it("preserves nested relative directory structure", () => {
    const { layout, worktreeRoot } = makeLayout();
    const source = join(worktreeRoot, "a", "b", "c.ts");
    mkdirSync(join(worktreeRoot, "a", "b"), { recursive: true });
    writeFileSync(source, "export {};\n", "utf8");

    const entry = moveToTrash(layout, "task-1", worktreeRoot, "a/b/c.ts");

    expect(entry.trashPath.endsWith(join("a", "b", "c.ts"))).toBe(true);
    expect(readFileSync(entry.trashPath, "utf8")).toBe("export {};\n");
  });

  it("rejects a path-shaped taskId before creating anything outside controlRoot", () => {
    const { layout, worktreeRoot } = makeLayout();
    const source = join(worktreeRoot, "safe.txt");
    writeFileSync(source, "safe", "utf8");
    const outside = join(layout.controlRoot, "..", "evil");

    expect(() => moveToTrash(layout, "../evil", worktreeRoot, "safe.txt")).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(existsSync(source)).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });

  it("throws FILE_NOT_FOUND when the source file does not exist", () => {
    const { layout, worktreeRoot } = makeLayout();

    expect(() => moveToTrash(layout, "task-1", worktreeRoot, "missing.txt")).toThrow(
      expect.objectContaining({ code: "FILE_NOT_FOUND" }),
    );
  });
});
