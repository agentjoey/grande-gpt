import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { listJobs } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { acquireRepoProcessLock } from "../src/repoProcessLock.ts";
import { reserveManagedJob } from "../src/resourceAdmission.ts";
import { awaitAllJobsSettled, startJob } from "../src/runner.ts";
import { saveTaskCloseIntent } from "../src/taskCloseIntent.ts";
import { createTask, getTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps;
let worktree: string;
const TASK = "task_serial_admission";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null",
  "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-serialization-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace")); vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout);
  const canonical = join(layout.workspaceRoot, "demo"); mkdirSync(canonical);
  git(canonical, "init", "-qb", "main"); git(canonical, "commit", "--allow-empty", "-qm", "base");
  const base = git(canonical, "rev-parse", "HEAD");
  worktree = join(layout.worktreesRoot, "demo", TASK); mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-qb", "grande/serial-admission", worktree, base);
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n");
  writeFileSync(join(layout.configDir, "resource-policy.json"), '{"minFreeBytes":1}');
  writeFileSync(join(layout.configDir, "profiles.yaml"), 'repos:\n  demo:\n    test: { argv: ["/bin/echo", "test"], timeoutSeconds: 30 }\n');
  deps = { db: openDb(layout), layout, jobSandboxRunner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "",
    truncated: false, killedBy: null, killSignalSkipped: false, durationMs: 0, peakRssMb: 0 })) };
  createTask(deps.db, { taskId: TASK, repoId: "demo", branch: "grande/serial-admission", baseCommit: base, worktreePath: worktree, state: "READY" });
});
afterEach(async () => { await awaitAllJobsSettled(2000); deps.db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("B2-1 exclusion from close and repository mutations", () => {
  it("rejects admission after durable close intent", () => {
    const task = getTask(deps.db, TASK)!;
    saveTaskCloseIntent(deps.db, { taskId: TASK, expectedStateVersion: task.stateVersion, headSha: task.baseCommit });
    expect(() => reserveManagedJob(deps.db, layout, { taskId: TASK, jobId: "job_forbidden", profile: "test", argv: [], kind: "sandbox" })).toThrow(/close|关闭|准入/i);
    expect(listJobs(deps.db, TASK)).toHaveLength(0);
  });

  it("uses the existing cross-process repository lock before the public run prepares dependencies", async () => {
    const lock = acquireRepoProcessLock(layout, "demo");
    try {
      const tool = buildTools(deps).find((tool) => tool.name === "grande_run")!;
      const result = (await tool.handler({ taskId: TASK, profile: "test" })).structuredContent as { ok: boolean; error?: { code: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CANONICAL_BUSY");
      expect(deps.jobSandboxRunner).not.toHaveBeenCalled();
      expect(listJobs(deps.db, TASK)).toHaveLength(0);
    } finally { lock.release(); }
  });

  it("does not spawn when the durable reservation cannot be inserted", () => {
    deps.db.exec("CREATE TRIGGER deny_jobs BEFORE INSERT ON job BEGIN SELECT RAISE(ABORT,'cannot persist'); END");
    const audit = beginAudit(deps.db, { taskId: TASK, tool: "grande_run", input: {} }); audit.allowed();
    expect(() => startJob(deps, { taskId: TASK, repoId: "demo", worktreePath: worktree, profileName: "test" }, audit)).toThrow(/cannot persist/);
    expect(deps.jobSandboxRunner).not.toHaveBeenCalled();
    expect(listJobs(deps.db, TASK)).toHaveLength(0);
  });
});
