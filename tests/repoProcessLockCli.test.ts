import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { acquireRepoProcessLock } from "../src/repoProcessLock.ts";
import { saveRegistry } from "../src/registry.ts";
import { runCli } from "../src/cli.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let ws: string;
let ctrl: string;
let layout: Layout;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "repo-lock-cli-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "repo-lock-cli-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = saved.ctrl;
});

function createOrphanWorktree(): { canonical: string; orphan: string } {
  const canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-q", "-m", "init");
  saveRegistry(layout, [{ repoId: "demo", path: canonical, registered: true }]);

  const orphan = join(layout.worktreesRoot, "demo", "task_orphan");
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/orphan", orphan, "HEAD");
  return { canonical, orphan };
}

describe("GG-BL-017 CLI cross-process repo lock", () => {
  it("gc --apply fails closed with zero branch/worktree/canonical side effects when another live owner holds the repo lock", () => {
    const { canonical, orphan } = createOrphanWorktree();
    const beforeCanonicalHead = git(canonical, "rev-parse", "HEAD");
    const beforeWorktrees = git(canonical, "worktree", "list", "--porcelain");
    const beforeBranch = git(canonical, "rev-parse", "grande/orphan");
    const held = acquireRepoProcessLock(layout, "demo");
    const lines: string[] = [];
    try {
      const result = runCli(["gc", "--apply"], (line) => lines.push(line));
      expect(typeof result).toBe("number");
      expect(result).not.toBe(0);
      expect(lines.join("\n")).toMatch(/busy|lock|占用|写锁/i);
      expect(existsSync(orphan)).toBe(true);
      expect(git(canonical, "rev-parse", "HEAD")).toBe(beforeCanonicalHead);
      expect(git(canonical, "rev-parse", "grande/orphan")).toBe(beforeBranch);
      expect(git(canonical, "worktree", "list", "--porcelain")).toBe(beforeWorktrees);
    } finally {
      held.release();
    }
  });
});
