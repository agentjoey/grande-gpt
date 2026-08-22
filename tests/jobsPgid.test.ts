import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import {
  createJob,
  finishJob,
  getJob,
  setRunningJobPgid,
  setRunningJobSummary,
} from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let db: ReturnType<typeof openDb>;
const taskId = "task-pgid";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jobs-pgid-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  const worktree = join(root, "worktree");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  const layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch: "grande/pgid",
    baseCommit: "a".repeat(40),
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("running job metadata CAS", () => {
  it("writes the real pgid exactly once while the job is still running", () => {
    createJob(db, { jobId: "job-pgid", taskId, profile: "host-verifier", argv: [], pgid: null });
    expect(setRunningJobPgid(db, "job-pgid", 43210)).toBe(true);
    expect(getJob(db, "job-pgid")?.pgid).toBe(43210);
    expect(setRunningJobPgid(db, "job-pgid", 54321)).toBe(false);
    expect(getJob(db, "job-pgid")?.pgid).toBe(43210);
  });

  it("stores trusted preparation metadata only while still running", () => {
    createJob(db, { jobId: "job-summary", taskId, profile: "host-verifier", argv: [], pgid: null });
    expect(setRunningJobSummary(db, "job-summary", { kind: "host-verifier-preparing", disposableRoot: "/tmp/x" })).toBe(true);
    expect(getJob(db, "job-summary")?.summary).toMatchObject({ kind: "host-verifier-preparing" });
    finishJob(db, "job-summary", { state: "killed", exitCode: null, artifactPath: null, summary: { terminal: true } });
    expect(setRunningJobSummary(db, "job-summary", { overwritten: true })).toBe(false);
    expect(getJob(db, "job-summary")?.summary).toEqual({ terminal: true });
  });

  it("does not attach a pgid after the job reached a terminal state", () => {
    createJob(db, { jobId: "job-terminal", taskId, profile: "host-verifier", argv: [], pgid: null });
    finishJob(db, "job-terminal", { state: "killed", exitCode: null, artifactPath: null, summary: null });
    expect(setRunningJobPgid(db, "job-terminal", 43210)).toBe(false);
    expect(getJob(db, "job-terminal")?.pgid).toBeNull();
  });

  it("rejects invalid pgids", () => {
    createJob(db, { jobId: "job-invalid", taskId, profile: "host-verifier", argv: [], pgid: null });
    expect(() => setRunningJobPgid(db, "job-invalid", 0)).toThrow(/pgid|positive/i);
    expect(() => setRunningJobPgid(db, "job-invalid", -1)).toThrow(/pgid|positive/i);
  });
});
