import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { buildDependencyBootstrapIdentity, dependencyCacheDir, materializePreparedDependencies,
  preparedDependencyCachePresent, publishPreparedDependencies } from "../src/dependencyBootstrap.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { planResourceRetention } from "../src/resourceRetention.ts";
import { recordTaskPrMerged } from "../src/taskPrReceipt.ts";
import { createTask, updateTaskState } from "../src/tasks.ts";

const NOW = 1_950_000_000_000;
const OLD = NOW - 90 * 86_400_000;
let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "retention-progress-"));
  mkdirSync(join(root, "workspace", "demo"), { recursive: true }); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace")); vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  saveRegistry(layout, [{ repoId: "demo", path: join(layout.workspaceRoot, "demo"), registered: true }]);
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("B2-3 retention progress", () => {
  it("can continue beyond old jobs whose resources no longer exist", () => {
    const task = createTask(db, { taskId: "task_many", repoId: "demo", branch: "grande/many", baseCommit: "1".repeat(40),
      worktreePath: join(layout.worktreesRoot, "demo", "task_many"), state: "READY" });
    updateTaskState(db, task.taskId, "CLOSED", task.stateVersion);
    recordTaskPrMerged(db, { taskId: task.taskId, prNumber: 1, prUrl: "https://github.com/example/demo/pull/1",
      headSha: "2".repeat(40), baseRef: "main", baseSha: "1".repeat(40), mergeSha: "3".repeat(40) });
    for (let i = 0; i < 130; i++) {
      const jobId = `job_many_${i.toString().padStart(4, "0")}`;
      createJob(db, { jobId, taskId: task.taskId, profile: "unit", argv: [], pgid: null });
      finishJob(db, jobId, { state: "passed", exitCode: 0, artifactPath: null, summary: null });
      db.prepare("UPDATE job SET endedAt=? WHERE jobId=?").run(OLD + i, jobId);
    }
    const dir = join(layout.derivedRoot, "tmp", "job_many_0129"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "last"), "still exists");
    utimesSync(join(dir, "last"), OLD / 1000, OLD / 1000); utimesSync(dir, OLD / 1000, OLD / 1000);
    const first = planResourceRetention(db, layout, { now: NOW });
    expect(first.nextCursor).toBeTypeOf("string");
    const second = planResourceRetention(db, layout, { now: NOW, cursor: first.nextCursor! });
    expect(second.items.some((item) => item.key === "job_many_0129")).toBe(true);
    expect(second.nextCursor).toBeNull();
  });

  it("touches cache last-use only when it is actually materialized, not inspected", () => {
    const identity = buildDependencyBootstrapIdentity("demo", { node: "v24", packageManager: "pnpm",
      packageManagerVersion: "10", lockfile: "pnpm-lock.yaml", lockfileSha256: "a".repeat(64) });
    const source = join(root, "source"); const target = join(root, "target");
    mkdirSync(join(source, "node_modules"), { recursive: true }); mkdirSync(target);
    writeFileSync(join(source, "node_modules", "file"), "dependency");
    publishPreparedDependencies(layout, identity, source);
    const cache = dependencyCacheDir(layout, identity);
    const oldUse = (Date.now() - 90 * 86_400_000) / 1000;
    utimesSync(cache, oldUse, oldUse);
    const before = statSync(cache).mtimeMs;
    expect(preparedDependencyCachePresent(layout, identity)).toBe(true);
    expect(statSync(cache).mtimeMs).toBe(before);
    expect(materializePreparedDependencies(layout, identity, target)).toBe(true);
    expect(statSync(cache).mtimeMs).toBeGreaterThan(before);
    expect(existsSync(join(target, "node_modules", "file"))).toBe(true);
  });
});
