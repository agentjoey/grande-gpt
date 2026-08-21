import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db.ts";
import { reconcileHostVerifierJobsAtStartup } from "../../src/hostVerifierRecovery.ts";
import { createJob, getJob, setRunningJobSummary } from "../../src/jobs.ts";
import { ensureLayout, loadLayout } from "../../src/layout.ts";
import { saveRegistry } from "../../src/registry.ts";
import { createTask } from "../../src/tasks.ts";
import { execFileSync } from "node:child_process";

const roots: string[] = [];
const groups: number[] = [];

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGroup(pgid: number, expectedAlive: boolean): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (groupAlive(pgid) === expectedAlive) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    if (groupAlive(pgid)) {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host verifier restart recovery", () => {
  it("kills the recorded detached verifier process group and cleans only its disposable root", async () => {
    const root = mkdtempSync(join(tmpdir(), "verifier-recovery-host-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const control = join(root, "control");
    const canonical = join(workspace, "grande-gpt");
    const taskWorktree = join(root, "task-worktree");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(control, { recursive: true });
    mkdirSync(taskWorktree, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: canonical });

    const savedWorkspace = process.env.GRANDE_WORKSPACE;
    const savedControl = process.env.GRANDE_CONTROL;
    process.env.GRANDE_WORKSPACE = workspace;
    process.env.GRANDE_CONTROL = control;
    const layout = loadLayout();
    ensureLayout(layout);
    saveRegistry(layout, [{ repoId: "grande-gpt", path: canonical, registered: true }]);
    const db = openDb(layout);

    try {
      const taskId = "task-verifier-recovery-host";
      createTask(db, {
        taskId,
        repoId: "grande-gpt",
        branch: "grande/verifier-recovery-host",
        baseCommit: "0".repeat(40),
        worktreePath: taskWorktree,
        state: "READY",
      });

      const disposableRoot = mkdtempSync(join(tmpdir(), "grande-host-verifier-"));
      roots.push(disposableRoot);
      const child = spawn(process.execPath, [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          'setInterval(() => {}, 1000);',
        ].join("\n"),
      ], { detached: true, stdio: "ignore" });
      const pgid = child.pid;
      if (!pgid) throw new Error("detached verifier fixture produced no pgid");
      groups.push(pgid);
      expect(await waitForGroup(pgid, true)).toBe(true);

      const jobId = "job-verifier-recovery-host";
      createJob(db, {
        jobId,
        taskId,
        profile: "host-verifier",
        argv: ["trusted-host-verifier", "full", "a".repeat(40)],
        pgid,
      });
      setRunningJobSummary(db, jobId, {
        kind: "host-verifier-running",
        repoId: "grande-gpt",
        commit: "a".repeat(40),
        level: "full",
        disposableRoot,
      });

      expect(await reconcileHostVerifierJobsAtStartup({ db, layout })).toBe(1);
      expect(await waitForGroup(pgid, false)).toBe(true);
      expect(existsSync(disposableRoot)).toBe(false);
      expect(existsSync(taskWorktree)).toBe(true);
      expect(getJob(db, jobId)).toMatchObject({
        state: "killed",
        summary: {
          kind: "host-verifier-failure",
          infrastructureFailure: true,
          reason: "interrupted_by_gateway_restart",
          cleaned: true,
        },
      });
    } finally {
      db.close();
      if (savedWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
      else process.env.GRANDE_WORKSPACE = savedWorkspace;
      if (savedControl === undefined) delete process.env.GRANDE_CONTROL;
      else process.env.GRANDE_CONTROL = savedControl;
    }
  }, 10_000);
});
