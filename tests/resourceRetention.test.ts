import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { createJob, finishJob, getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask, getTask, updateTaskState } from "../src/tasks.ts";
import { recordTaskPrMerged } from "../src/taskPrReceipt.ts";

const NOW = 1_950_000_000_000;
const OLD = NOW - 90 * 86400_000;
const TASK = "task_retention";
const JOB = "job_retention";
let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
let temporary: string;
let artifact: string;
let cache: string;

async function subject() {
  const api = await import("../src/resourceRetention.ts");
  expect(api.planResourceRetention).toBeTypeOf("function");
  expect(api.applyResourceRetention).toBeTypeOf("function");
  return api;
}

function oldFile(path: string, text = "disposable") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, OLD / 1000, OLD / 1000);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "retention-"));
  mkdirSync(join(root, "workspace", "demo"), { recursive: true });
  mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  saveRegistry(layout, [{ repoId: "demo", path: join(layout.workspaceRoot, "demo"), registered: true }]);
  const task = createTask(db, { taskId: TASK, repoId: "demo", branch: "grande/retention",
    baseCommit: "1".repeat(40), worktreePath: join(layout.worktreesRoot, "demo", TASK), state: "READY" });
  recordTaskPrMerged(db, { taskId: TASK, prNumber: 1, prUrl: "https://github.com/example/demo/pull/1",
    headSha: "2".repeat(40), baseRef: "main", baseSha: "1".repeat(40), mergeSha: "3".repeat(40) });
  updateTaskState(db, TASK, "CLOSED", task.stateVersion);
  temporary = join(layout.derivedRoot, "tmp", JOB);
  artifact = join(layout.artifactsDir, TASK, JOB, "output.log");
  cache = join(layout.derivedRoot, "dependency-cache", "demo", "a".repeat(64));
  oldFile(join(temporary, "home", "scratch"));
  oldFile(artifact, "old diagnostic output");
  oldFile(join(cache, "node_modules", ".grande-dependency-identity.json"), JSON.stringify({ repoId: "demo", key: "a".repeat(64) }));
  for (const path of [join(temporary, "home"), temporary, join(cache, "node_modules"), cache]) utimesSync(path, OLD / 1000, OLD / 1000);
  createJob(db, { jobId: JOB, taskId: TASK, profile: "unit", argv: [], pgid: null });
  finishJob(db, JOB, { state: "passed", exitCode: 0, artifactPath: artifact, summary: { durationMs: 10 } });
  db.prepare("UPDATE job SET startedAt=?, endedAt=? WHERE jobId=?").run(OLD, OLD + 10, JOB);
});

afterEach(() => { db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("B2-3 bounded retention", () => {
  it("plans disposable data without any deletion or database mutation", async () => {
    const { planResourceRetention } = await subject();
    const before = db.prepare("SELECT total_changes() n").get();
    const plan = planResourceRetention(db, layout, { now: NOW });
    expect(plan.items.map((item) => item.kind).sort()).toEqual(["artifact", "dependency-cache", "job-temp"]);
    expect(plan.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(temporary) && existsSync(artifact) && existsSync(cache)).toBe(true);
    expect(db.prepare("SELECT total_changes() n").get()).toEqual(before);
  });

  it("retires only planned disposable content and keeps task/job/receipt records", async () => {
    const { planResourceRetention, applyResourceRetention } = await subject();
    const result = applyResourceRetention(db, layout, planResourceRetention(db, layout, { now: NOW }), { now: NOW });
    expect(result.purged).toBe(3);
    expect(existsSync(temporary) || existsSync(artifact) || existsSync(cache)).toBe(false);
    expect(getTask(db, TASK)?.state).toBe("CLOSED");
    expect(getJob(db, JOB)?.state).toBe("passed");
    expect(getJob(db, JOB)?.summary?.artifactRetention).toMatchObject({ state: "pruned" });
    expect(db.prepare("SELECT mergeSha FROM task_pr_receipt WHERE taskId=?").get(TASK)).toBeDefined();
  });

  it("refuses a changed file rather than deleting content absent from the plan", async () => {
    const { planResourceRetention, applyResourceRetention } = await subject();
    const plan = planResourceRetention(db, layout, { now: NOW });
    writeFileSync(artifact, "new diagnostic evidence");
    const result = applyResourceRetention(db, layout, plan, { now: NOW });
    expect(result.skipped.some((item) => item.reason.includes("changed"))).toBe(true);
    expect(readFileSync(artifact, "utf8")).toBe("new diagnostic evidence");
  });

  it("rechecks active jobs after dry-run before retiring any resource", async () => {
    const { planResourceRetention, applyResourceRetention } = await subject();
    const plan = planResourceRetention(db, layout, { now: NOW });
    createJob(db, { jobId: "job_new", taskId: TASK, profile: "unit", argv: [], pgid: null });
    const result = applyResourceRetention(db, layout, plan, { now: NOW });
    expect(result.purged).toBe(0);
    expect(existsSync(temporary) && existsSync(artifact) && existsSync(cache)).toBe(true);
  });

  it("does not follow a substituted resource root symlink", async () => {
    const { planResourceRetention, applyResourceRetention } = await subject();
    const plan = planResourceRetention(db, layout, { now: NOW });
    const outside = join(root, "outside"); oldFile(join(outside, "keep"));
    rmSync(temporary, { recursive: true }); symlinkSync(outside, temporary);
    applyResourceRetention(db, layout, plan, { now: NOW });
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("disposable");
    expect(existsSync(temporary)).toBe(true);
  });

  it("rolls back retirement if the audit cannot be recorded", async () => {
    const { planResourceRetention, applyResourceRetention } = await subject();
    const plan = planResourceRetention(db, layout, { now: NOW });
    db.exec("CREATE TRIGGER refuse_retention_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    const result = applyResourceRetention(db, layout, plan, { now: NOW });
    expect(result.purged).toBe(0);
    expect(existsSync(temporary) && existsSync(artifact) && existsSync(cache)).toBe(true);
    expect(getJob(db, JOB)?.summary?.artifactRetention).toBeUndefined();
  });

  it("does not prune data needed by an open task", async () => {
    const { planResourceRetention } = await subject();
    db.prepare("UPDATE task SET state='READY' WHERE taskId=?").run(TASK);
    expect(planResourceRetention(db, layout, { now: NOW }).items).toHaveLength(0);
  });

  it("retains diagnostic output referenced by an attestation", async () => {
    const { planResourceRetention } = await subject();
    db.prepare(`INSERT INTO attestation (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
      VALUES ('att_keep',?,'head','unit',?,0,1,2,'{}')`).run(TASK, JOB);
    expect(planResourceRetention(db, layout, { now: NOW }).items.some((item) => item.kind === "artifact")).toBe(false);
  });

  it("never inventories current logs, checkpoints, backups or worktrees", async () => {
    const { planResourceRetention } = await subject();
    for (const path of [join(layout.controlRoot, "logs", "gateway.stdout.log"),
      join(layout.controlRoot, "backups", "keep"), join(layout.controlRoot, "checkpoints", "keep"),
      join(layout.worktreesRoot, "demo", "task_other", "keep")]) oldFile(path);
    const plan = planResourceRetention(db, layout, { now: NOW });
    expect(plan.items).toHaveLength(3);
  });

  it("excludes unresolved delivery even after its local config is gone", async () => {
    const { planResourceRetention } = await subject();
    db.prepare("INSERT INTO deployment_receipt (taskId,receiptJson,updatedAt) VALUES (?, '{}', ?)").run(TASK, OLD);
    expect(planResourceRetention(db, layout, { now: NOW }).items).toHaveLength(0);
  });

  it("bounds scanning and never treats an incompletely scanned resource as eligible", async () => {
    const { planResourceRetention } = await subject();
    const plan = planResourceRetention(db, layout, { now: NOW, maxScanEntries: 1 });
    expect(plan.truncated).toBe(true);
    expect(plan.scannedEntries).toBeLessThanOrEqual(1);
    expect(plan.items).toHaveLength(0);
  });

  it("binds an apply request to the dry-run plan and managed roots", async () => {
    const { planResourceRetention, applyResourceRetention } = await subject();
    const plan = planResourceRetention(db, layout, { now: NOW });
    expect(() => applyResourceRetention(db, layout, { ...plan, digest: "sha256:" + "0".repeat(64) }, { now: NOW })).toThrow();
    expect(existsSync(temporary) && existsSync(artifact) && existsSync(cache)).toBe(true);
  });
});
