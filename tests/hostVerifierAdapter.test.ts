import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// unit-selfhost intentionally denies network-bind. Mock only the trusted parent's
// ephemeral-port allocator here; the real createServer/listen path is exercised by
// the dedicated real-host verifier probe.
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: () => {
      const server = {
        once: () => server,
        listen: (_port: number, _host: string, callback: () => void) => { callback(); return server; },
        address: () => ({ address: "127.0.0.1", family: "IPv4", port: 49173 }),
        close: (callback: (error?: Error) => void) => { callback(); return server; },
      };
      return server;
    },
  };
});

import { openDb } from "../src/db.ts";
import { buildHostVerifierStaticPlan, type HostVerifierRequest } from "../src/hostVerifier.ts";
import { createDefaultHostVerifierRuntimeAdapter } from "../src/hostVerifierRuntime.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
let commit: string;
let taskWorktree: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-verifier-adapter-unit-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);

  const canonical = join(workspace, "grande-gpt");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "config", "user.name", "Verifier Unit");
  git(canonical, "config", "user.email", "verifier@example.invalid");
  mkdirSync(join(canonical, "tests", "host"), { recursive: true });
  writeFileSync(join(canonical, "package.json"), '{"type":"module"}\n', "utf8");
  writeFileSync(join(canonical, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(join(canonical, "tests", "host", "server-auto.host.test.ts"), "export {};\n", "utf8");
  writeFileSync(join(canonical, "tests", "host", "git-hook.host.test.ts"), "export {};\n", "utf8");
  git(canonical, "add", ".");
  git(canonical, "commit", "-q", "-m", "fixture");
  commit = git(canonical, "rev-parse", "HEAD");

  mkdirSync(join(canonical, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(canonical, "node_modules", "vitest", "vitest.mjs"), "export {};\n", "utf8");
  saveRegistry(layout, [{ repoId: "grande-gpt", path: canonical, registered: true }]);
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos: {}\ndepDirs:\n  grande-gpt:\n    - node_modules\n",
    "utf8",
  );

  taskWorktree = join(layout.worktreesRoot, "grande-gpt", "task-host-adapter");
  mkdirSync(join(layout.worktreesRoot, "grande-gpt"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/host-adapter", taskWorktree, commit);

  db = openDb(layout);
  createTask(db, {
    taskId: "task-host-adapter",
    repoId: "grande-gpt",
    branch: "grande/host-adapter",
    baseCommit: commit,
    worktreePath: taskWorktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("default host verifier runtime adapter", () => {
  it("prepares an exact-SHA detached source, trusted deps, exact ports and fixed policy/config, then cleans only it", async () => {
    const request: HostVerifierRequest = {
      taskId: "task-host-adapter",
      repoId: "grande-gpt",
      commit,
      level: "full",
    };
    const plan = buildHostVerifierStaticPlan("full");
    const disposableRoot = mkdtempSync(join(tmpdir(), "grande-host-verifier-"));
    const adapter = createDefaultHostVerifierRuntimeAdapter(
      { db, layout },
      { readPrHead: async () => commit },
    );

    const prepared = await adapter.prepare({ request, plan, jobId: "job-adapter", disposableRoot });
    expect(git(prepared.sourceRoot, "rev-parse", "HEAD")).toBe(commit);
    expect(git(prepared.sourceRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(existsSync(join(prepared.sourceRoot, "node_modules", "vitest", "vitest.mjs"))).toBe(true);
    expect(prepared.loopbackPorts).toEqual([49173]);
    expect(prepared.loopbackPorts[0]).not.toBe(8787);

    const config = readFileSync(join(prepared.jobTmp, "verifier.vitest.config.mjs"), "utf8");
    expect(config).toContain("tests/host/server-auto.host.test.ts");
    expect(config).toContain("tests/host/git-hook.host.test.ts");
    expect(config).not.toContain("vitest.config.ts");

    const profile = readFileSync(join(prepared.jobTmp, "verifier.sb"), "utf8");
    expect(profile).not.toContain("localhost:*");
    expect(profile).toContain(`localhost:${prepared.loopbackPorts[0]}`);
    expect(profile).toContain("git-hook-probe/repo/.git/hooks/pre-commit");
    expect(profile).not.toContain(`(allow process-exec (subpath \"${prepared.jobTmp}`);

    const heads = await adapter.readCurrentHeads(request);
    expect(heads).toEqual({ taskHead: commit, prHead: commit });

    await adapter.cleanup(prepared);
    expect(existsSync(disposableRoot)).toBe(false);
    expect(existsSync(taskWorktree)).toBe(true);
    const worktrees = git(join(layout.workspaceRoot, "grande-gpt"), "worktree", "list", "--porcelain");
    expect(worktrees).not.toContain(prepared.sourceRoot);
  });
});
