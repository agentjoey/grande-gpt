import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: () => {
      const server = {
        once: () => server,
        listen: (_port: number, _host: string, callback: () => void) => { callback(); return server; },
        address: () => ({ address: "127.0.0.1", family: "IPv4", port: 49174 }),
        close: (callback: (error?: Error) => void) => { callback(); return server; },
      };
      return server;
    },
  };
});

import { captureDependencyBootstrapIdentity, publishPreparedDependencies } from "../src/dependencyBootstrap.ts";
import { openDb } from "../src/db.ts";
import { buildHostVerifierStaticPlan, type HostVerifierRequest } from "../src/hostVerifier.ts";
import { createDefaultHostVerifierRuntimeAdapter } from "../src/hostVerifierRuntime.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb> | undefined;
let commit: string;
let canonical: string;
let taskWorktree: string;
let savedWorkspace: string | undefined;
let savedControl: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

beforeEach(() => {
  savedWorkspace = process.env.GRANDE_WORKSPACE;
  savedControl = process.env.GRANDE_CONTROL;
  root = mkdtempSync(join(tmpdir(), "host-verifier-dependency-bootstrap-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);

  canonical = join(layout.workspaceRoot, "grande-gpt");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "config", "user.name", "Verifier Bootstrap");
  git(canonical, "config", "user.email", "verifier-bootstrap@example.invalid");
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
  const identity = captureDependencyBootstrapIdentity("grande-gpt", canonical);
  publishPreparedDependencies(layout, identity, canonical);
  rmSync(join(canonical, "node_modules"), { recursive: true, force: true });
  expect(existsSync(join(canonical, "node_modules"))).toBe(false);

  saveRegistry(layout, [{ repoId: "grande-gpt", path: canonical, registered: true }]);
  writeFileSync(join(layout.configDir, "profiles.yaml"), "repos: {}\ndepDirs:\n  grande-gpt:\n    - node_modules\n", "utf8");

  taskWorktree = join(layout.worktreesRoot, "grande-gpt", "task-host-bootstrap");
  mkdirSync(join(layout.worktreesRoot, "grande-gpt"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/host-bootstrap", taskWorktree, commit);

  db = openDb(layout);
  createTask(db, {
    taskId: "task-host-bootstrap",
    repoId: "grande-gpt",
    branch: "grande/host-bootstrap",
    baseCommit: commit,
    worktreePath: taskWorktree,
    state: "READY",
  });
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(root, { recursive: true, force: true });
  if (savedWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = savedWorkspace;
  if (savedControl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = savedControl;
});

describe("GG-BL-031 exact-SHA host verifier dependency preparation", () => {
  it("prepares verifier dependencies from the identity cache when canonical node_modules is absent", async () => {
    const request: HostVerifierRequest = {
      taskId: "task-host-bootstrap",
      repoId: "grande-gpt",
      commit,
      level: "full",
    };
    const adapter = createDefaultHostVerifierRuntimeAdapter(
      { db: db!, layout },
      { readPrHead: async () => commit },
    );
    const disposableRoot = mkdtempSync(join(tmpdir(), "grande-host-verifier-bootstrap-"));
    const prepared = await adapter.prepare({
      request,
      plan: buildHostVerifierStaticPlan("full"),
      jobId: "job-host-bootstrap",
      disposableRoot,
    });

    expect(existsSync(join(prepared.sourceRoot, "node_modules", "vitest", "vitest.mjs"))).toBe(true);
    expect(prepared.hostToolchain).toMatchObject({ packageManager: "pnpm" });
    expect(existsSync(join(canonical, "node_modules"))).toBe(false);

    await adapter.cleanup(prepared);
  });
});
