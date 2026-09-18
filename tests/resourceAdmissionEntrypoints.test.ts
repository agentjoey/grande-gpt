import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { captureDependencyBootstrapIdentity, publishPreparedDependencies } from "../src/dependencyBootstrap.ts";
import { prepareDependencyPrerequisite } from "../src/dependencyBootstrapTools.ts";
import { buildHostVerifierStaticPlan } from "../src/hostVerifier.ts";
import { createHostVerifierLauncher, type HostVerifierRuntimeAdapter } from "../src/hostVerifierRuntime.ts";
import { createJob, listJobs } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { awaitAllJobsSettled } from "../src/runner.ts";
import { addTaskLifecycleCrashRecovery } from "../src/taskLifecycleToolWiring.ts";
import { createTask, getTask } from "../src/tasks.ts";
import type { ToolDef } from "../src/toolsCore.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
let worktree: string;
const TASK = "task_entrypoints";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-entry-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  const canonical = join(layout.workspaceRoot, "grande-gpt");
  mkdirSync(join(canonical, ".git"), { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: grande-gpt\n    registered: true\n");
  writeFileSync(join(layout.configDir, "resource-policy.json"), '{"minFreeBytes":1}');
  writeFileSync(join(layout.configDir, "profiles.yaml"), 'depDirs:\n  grande-gpt: ["node_modules"]\nrepos:\n  grande-gpt:\n    test: { argv: ["npm", "test"], timeoutSeconds: 30 }\n');
  worktree = join(layout.worktreesRoot, "grande-gpt", TASK); mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "package.json"), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(join(worktree, "package-lock.json"), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}');
  createTask(db, { taskId: TASK, repoId: "grande-gpt", branch: "grande/entrypoints",
    baseCommit: "1".repeat(40), worktreePath: worktree, state: "READY" });
});

afterEach(async () => {
  await awaitAllJobsSettled(2000);
  db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

function blocker() {
  createJob(db, { jobId: "job_live", taskId: TASK, profile: "test", argv: [], pgid: null });
}

function prerequisite() {
  return prepareDependencyPrerequisite({ db, layout,
    dependencyBootstrapSandboxRunner: async () => { throw new Error("installation must not start"); },
  }, getTask(db, TASK)!, "test");
}

describe("B2-1 resource-consuming entrypoints", () => {
  it("blocks dependency installation while another execution owns the worktree", () => {
    blocker();
    expect(prerequisite).toThrow(/capacity|已有|准入/i);
    expect(listJobs(db, TASK)).toHaveLength(1);
  });

  it("blocks cache materialization before it modifies node_modules", () => {
    const source = join(root, "cache-source"); mkdirSync(join(source, "node_modules"), { recursive: true });
    const identity = captureDependencyBootstrapIdentity("grande-gpt", worktree);
    publishPreparedDependencies(layout, identity, source);
    blocker();
    expect(prerequisite).toThrow(/capacity|已有|准入/i);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("applies low-disk rejection to dependency setup", () => {
    writeFileSync(join(layout.configDir, "resource-policy.json"), JSON.stringify({ minFreeBytes: Number.MAX_SAFE_INTEGER }));
    expect(prerequisite).toThrow(/disk|磁盘|空间/i);
    expect(listJobs(db, TASK)).toHaveLength(0);
  });

  it("reserves automatic verifier capacity before its preparation adapter runs", () => {
    blocker();
    const prepare = vi.fn(async () => { throw new Error("must not prepare"); });
    const adapter: HostVerifierRuntimeAdapter = { prepare,
      execute: async () => { throw new Error("must not execute"); },
      readCurrentHeads: async () => ({ taskHead: null, prHead: null }), cleanup: async () => {},
    };
    const launch = createHostVerifierLauncher({ db, layout }, adapter);
    expect(() => launch({ taskId: TASK, repoId: "grande-gpt", commit: "1".repeat(40), level: "full" },
      buildHostVerifierStaticPlan("full"))).toThrow(/capacity|已有|准入/i);
    expect(prepare).not.toHaveBeenCalled();
    expect(listJobs(db, TASK)).toHaveLength(1);
  });

  it("rejects task creation under low disk without calling worktree allocation", async () => {
    writeFileSync(join(layout.configDir, "resource-policy.json"), JSON.stringify({ minFreeBytes: Number.MAX_SAFE_INTEGER }));
    const handler = vi.fn(async () => ({ structuredContent: { ok: false } }));
    const tool: ToolDef = { name: "grande_task_open", description: "fixture", inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, handler };
    addTaskLifecycleCrashRecovery({ db, layout }, [tool]);
    const result = (await tool.handler({ taskId: "task_new", repoId: "grande-gpt", slug: "new" })).structuredContent as {
      ok: boolean; error?: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/disk|磁盘|空间/i);
    expect(getTask(db, "task_new")).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
