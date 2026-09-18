import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { safeGit } from "../src/gitExec.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";
import { toMcpTextResult } from "../src/mcpToolResult.ts";

vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, execFileSync: vi.fn(real.execFileSync) };
});
let root: string;
let worktree: string;
let deps: ToolDeps;
const TASK = "task_status_reads";
const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args,
], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "status-reads-"));
  mkdirSync(join(root, "workspace", "demo"), { recursive: true }); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace")); vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  const layout = loadLayout(); ensureLayout(layout);
  const canonical = join(layout.workspaceRoot, "demo");
  git(canonical, "init", "-q", "-b", "main"); git(canonical, "commit", "--allow-empty", "-qm", "base");
  const base = git(canonical, "rev-parse", "HEAD");
  worktree = join(layout.worktreesRoot, "demo", TASK); mkdirSync(join(worktree, ".."), { recursive: true });
  git(canonical, "worktree", "add", "-qb", "grande/status-reads", worktree, base);
  saveRegistry(layout, [{ repoId: "demo", path: canonical, registered: true }]);
  deps = { layout, db: openDb(layout), defaultRepoId: "demo" };
  createTask(deps.db, { taskId: TASK, repoId: "demo", branch: "grande/status-reads", baseCommit: base, worktreePath: worktree, state: "READY" });
});
afterEach(() => { deps.db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function gitReads(): string[] {
  return vi.mocked(execFileSync).mock.calls.filter(([command]) => command === "git")
    .map(([, args, options]) => JSON.stringify([(options as { cwd?: string })?.cwd, args]));
}

describe("B2-4 read-request observations", () => {
  it("executes each identical Git read once through the real status tool, then refreshes next request", async () => {
    const status = buildTools(deps).find((tool) => tool.name === "grande_task_status")!;
    vi.mocked(execFileSync).mockClear();
    await status.handler({ taskId: TASK });
    const reads = gitReads();
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBe(new Set(reads).size);
    writeFileSync(join(worktree, "new.txt"), "fresh change");
    vi.mocked(execFileSync).mockClear();
    const response = (await status.handler({ taskId: TASK })).structuredContent as { data: { filesChanged: number } };
    expect(response.data.filesChanged).toBe(1);
    expect(gitReads().length).toBeGreaterThan(0);
  });

  it("does not carry cached state into writes or into a later scope", async () => {
    const { withStatusReadScope } = await import("../src/statusReadScope.ts");
    await withStatusReadScope(async () => {
      const first = safeGit.local(worktree, ["rev-parse", "HEAD"]);
      safeGit.local(worktree, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "changed"]);
      expect(safeGit.local(worktree, ["rev-parse", "HEAD"])).not.toBe(first);
    });
    vi.mocked(execFileSync).mockClear();
    await withStatusReadScope(async () => { safeGit.local(worktree, ["rev-parse", "HEAD"]); });
    expect(gitReads()).toHaveLength(1);
  });

  it("bounds the complete MCP text representation of a byte-limited map page", async () => {
    for (let i = 0; i < 500; i++) writeFileSync(join(worktree, `${i}-${'草地"'.repeat(35)}.ts`), "x");
    const map = buildTools(deps).find((tool) => tool.name === "grande_repo_map")!;
    const response = await map.handler({ taskId: TASK, maxEntries: 500 });
    const payload = response.structuredContent;
    expect(Buffer.byteLength(JSON.stringify(toMcpTextResult(payload)))).toBeLessThanOrEqual(32 * 1024);
    expect(payload).toMatchObject({ ok: true, data: { truncated: true } });
  });
});
