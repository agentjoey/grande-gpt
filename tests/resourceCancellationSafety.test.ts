import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { registerJobCancellation, requestJobCancellation } from "../src/jobCancellation.ts";
import { createJob, finishJob, getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { reserveManagedJob } from "../src/resourceAdmission.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
const TASK = "task_cancel_safety";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cancel-safety-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace")); vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  writeFileSync(join(layout.configDir, "resource-policy.json"), '{"minFreeBytes":1}');
  for (const taskId of [TASK, "task_other"]) createTask(db, { taskId, repoId: "demo", branch: `grande/${taskId}`,
    baseCommit: "1".repeat(40), worktreePath: join(layout.worktreesRoot, "demo", taskId), state: "READY" });
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function owned() {
  reserveManagedJob(db, layout, { jobId: "job_owned", taskId: TASK, profile: "test", argv: [], kind: "sandbox" });
  return registerJobCancellation(db, "job_owned");
}

describe("B2-2 cancellation authorization and audit", () => {
  it("rejects a different task binding without notifying the supervisor", () => {
    const control = owned();
    expect(() => requestJobCancellation(db, "task_other", "job_owned")).toThrow(/绑定/);
    expect(control.signal.aborted).toBe(false); control.dispose();
  });

  it.each(["insert", "success-update"])("never aborts when the cancellation audit fails at %s", (stage) => {
    const control = owned();
    db.exec(stage === "insert"
      ? "CREATE TRIGGER fail_cancel BEFORE INSERT ON audit WHEN NEW.tool='grande_job_cancel' BEGIN SELECT RAISE(ABORT,'audit failed'); END"
      : "CREATE TRIGGER fail_cancel BEFORE UPDATE ON audit WHEN NEW.tool='grande_job_cancel' AND NEW.state='SUCCEEDED' BEGIN SELECT RAISE(ABORT,'audit failed'); END");
    const before = getJob(db, "job_owned");
    expect(() => requestJobCancellation(db, TASK, "job_owned")).toThrow();
    expect(control.signal.aborted).toBe(false);
    expect(getJob(db, "job_owned")).toEqual(before);
    expect(listAudit(db, TASK)).toHaveLength(0); control.dispose();
  });

  it("refuses a stored pgid after the original supervisor is no longer attached", () => {
    const control = owned(); control.dispose();
    db.close(); db = openDb(layout);
    expect(() => requestJobCancellation(db, TASK, "job_owned")).toThrow(/supervisor|PID/);
    expect(getJob(db, "job_owned")?.state).toBe("running");
  });

  it("cannot cancel an unowned production deployment job", () => {
    createJob(db, { jobId: "job_deploy", taskId: TASK, profile: "deploy-production", argv: [], pgid: 2_000_001 });
    expect(() => requestJobCancellation(db, TASK, "job_deploy")).toThrow(/production|supervisor/);
    expect(() => registerJobCancellation(db, "job_deploy")).toThrow();
    expect(getJob(db, "job_deploy")?.state).toBe("running");
  });

  it("keeps an uncertain supervisor reservation, but removes its cancellation authority", () => {
    const control = owned(); control.quarantine();
    expect(getJob(db, "job_owned")).toMatchObject({ state: "running", summary: { reason: "process_supervision_uncertain" } });
    expect(() => requestJobCancellation(db, TASK, "job_owned")).toThrow(/supervisor/);
    expect(() => reserveManagedJob(db, layout, { jobId: "job_next", taskId: TASK, profile: "test", argv: [], kind: "sandbox" })).toThrow(/capacity|已有/);
  });

  it("leaves every terminal result immutable", () => {
    const control = owned();
    finishJob(db, "job_owned", { state: "failed", exitCode: 2, artifactPath: null, summary: { reason: "test_failed" } });
    const before = getJob(db, "job_owned");
    expect(requestJobCancellation(db, TASK, "job_owned")).toMatchObject({ requested: false, state: "failed" });
    expect(getJob(db, "job_owned")).toEqual(before);
    expect(control.signal.aborted).toBe(false); control.dispose();
  });
});
