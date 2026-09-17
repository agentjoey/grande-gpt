import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { safeGit } from "../src/gitExec.ts";
import { reconcileHostVerifierJobsAtStartup } from "../src/hostVerifierRecovery.ts";
import { getJob, setRunningJobPgid } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { markManagedJobLaunching, reserveManagedJob } from "../src/resourceAdmission.ts";
import { assertDiskHeadroom, loadResourcePolicy } from "../src/resourcePolicy.ts";
import { createTask, getTask } from "../src/tasks.ts";
import { buildTools } from "../src/tools.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
const TASK = "task_owned_verifier";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-safety-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  writeFileSync(join(layout.configDir, "resource-policy.json"), '{"minFreeBytes":1}');
  const canonical = join(layout.workspaceRoot, "grande-gpt"); mkdirSync(canonical);
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-qb", "main"], { cwd: canonical });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd: canonical });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: grande-gpt\n    registered: true\n");
  createTask(db, { taskId: TASK, repoId: "grande-gpt", branch: "grande/owned",
    baseCommit: "1".repeat(40), worktreePath: join(layout.worktreesRoot, "grande-gpt", TASK), state: "READY" });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function reserve() {
  reserveManagedJob(db, layout, { jobId: "job_verifier", taskId: TASK,
    profile: "host-verifier", argv: [], kind: "host-verifier" });
}

describe("B2-1 production entrypoint and recovery safety", () => {
  it("checks disk before canonical refresh through the actual tool assembly", async () => {
    writeFileSync(join(layout.configDir, "resource-policy.json"), JSON.stringify({ minFreeBytes: Number.MAX_SAFE_INTEGER }));
    const git = vi.spyOn(safeGit, "local");
    const tool = buildTools({ db, layout }).find((t) => t.name === "grande_task_open")!;
    const before = git.mock.calls.length;
    const result = (await tool.handler({ taskId: "task_new", repoId: "grande-gpt", slug: "new" })).structuredContent as {
      ok: boolean; error?: { code: string; message: string };
    };
    expect(result.error?.code).toBe("RESOURCE_EXHAUSTED");
    expect(git.mock.calls.slice(before)).toEqual([]);
    expect(getTask(db, "task_new")).toBeUndefined();
  });

  it("never reaps a verifier still owned by a live supervisor", async () => {
    reserve(); markManagedJobLaunching(db, "job_verifier"); setRunningJobPgid(db, "job_verifier", 2000000);
    const killGroup = vi.fn(async () => {});
    const cleanupDisposable = vi.fn(async () => ({ cleaned: true }));
    expect(await reconcileHostVerifierJobsAtStartup({ db, layout }, {
      isAlive: () => true, killGroup, cleanupDisposable,
    })).toBe(0);
    expect(killGroup).not.toHaveBeenCalled(); expect(cleanupDisposable).not.toHaveBeenCalled();
    expect(getJob(db, "job_verifier")?.state).toBe("running");
  });

  it("does not guess ownership of a live recorded group after its owner died", async () => {
    reserve(); markManagedJobLaunching(db, "job_verifier"); setRunningJobPgid(db, "job_verifier", 2000000);
    db.prepare("UPDATE job SET summary=json_set(summary,'$.resourceOwner.pid',2147483647)").run();
    const killGroup = vi.fn(async () => {});
    expect(await reconcileHostVerifierJobsAtStartup({ db, layout }, { isAlive: () => true, killGroup })).toBe(0);
    expect(killGroup).not.toHaveBeenCalled();
    expect(getJob(db, "job_verifier")?.state).toBe("running");
  });

  it("rejects a symlinked resource policy instead of following it", () => {
    const policyPath = join(layout.configDir, "resource-policy.json");
    rmSync(policyPath);
    const external = join(root, "external.json"); writeFileSync(external, '{"minFreeBytes":1}');
    symlinkSync(external, policyPath);
    expect(() => loadResourcePolicy(layout)).toThrow(/配置|policy/);
  });

  it("fails closed when a disk destination cannot be reliably inspected", () => {
    const file = join(root, "file"); writeFileSync(file, "not a directory");
    expect(() => assertDiskHeadroom(layout, loadResourcePolicy(layout), [join(file, "child")])).toThrow(/磁盘|空间/);
  });
});
