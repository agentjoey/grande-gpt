import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAudit, listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { addFlowSimplification } from "../src/flowSimplification.ts";
import type { GithubLifecycleApi, GithubPullRequestDetail } from "../src/githubApi.ts";
import { createJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createPrMergeTool } from "../src/prLifecycle.ts";
import { wrapPrMergeToolD2 } from "../src/prMergeD2.ts";
import { saveRegistry } from "../src/registry.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { projectTaskProgress } from "../src/taskProgress.ts";
import { readTaskPrReceipt, recordTaskPrMerged, recordTaskPrOpened } from "../src/taskPrReceipt.ts";
import { createTask, getTask, updateTaskState } from "../src/tasks.ts";
import type { ToolDef, ToolDeps } from "../src/toolsCore.ts";

const TASK = "task_closeout_repair";
const BRANCH = "grande/closeout-repair";
const PR_URL = "https://github.com/example/demo/pull/54";
const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
  "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args,
], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let root: string;
let canonical: string;
let worktree: string;
let deps: ToolDeps;
let baseSha: string;
let headSha: string;
let mergeSha: string;
let attestationCount: number;
let detail: GithubPullRequestDetail;
let api: GithubLifecycleApi;

function attest(commit = headSha): void {
  const id = ++attestationCount;
  const toolchain = JSON.stringify({ node: "v24", pnpm: "10", lockfileSha256: "lock" });
  deps.db.prepare(`INSERT INTO job
    (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
    VALUES (?,?, 'typecheck','[]','passed',0,1,2,'digest',?)`)
    .run(`job_pass_${id}`, TASK, toolchain);
  deps.db.prepare(`INSERT INTO attestation
    (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
    VALUES (?,?,?,'typecheck',?,0,1,2,?)`)
    .run(`att_${id}`, TASK, commit, `job_pass_${id}`, toolchain);
}

function receiptInput() {
  return { taskId: TASK, prNumber: 54, prUrl: PR_URL, headSha, baseRef: "main", baseSha, mergeSha };
}

function closeAndRemove(): void {
  const task = getTask(deps.db, TASK)!;
  git(canonical, "worktree", "remove", worktree);
  git(canonical, "branch", "-d", BRANCH);
  updateTaskState(deps.db, TASK, "CLOSED", task.stateVersion);
  // This is only a historical reconciliation hint, not proof of merge identity.
  const audit = beginAudit(deps.db, { taskId: TASK, tool: "grande_pr_merge", input: {} });
  audit.allowed(); audit.executing(); audit.succeeded();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "closeout-repair-"));
  mkdirSync(join(root, "workspace"));
  mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  const layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(join(layout.controlRoot, "secrets", "github-token"), "github_pat_fixture_only_abcdefghijklmnopqrstuvwxyz\n", { mode: 0o600 });
  canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical);
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "commit", "--allow-empty", "-qm", "base");
  baseSha = git(canonical, "rev-parse", "HEAD");
  saveRegistry(layout, [{ repoId: "demo", path: canonical, registered: true }]);
  worktree = join(layout.worktreesRoot, "demo", TASK);
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-qb", BRANCH, worktree, baseSha);
  writeFileSync(join(worktree, "tracked.txt"), "delivered\n");
  git(worktree, "add", "tracked.txt");
  git(worktree, "commit", "-qm", `change\n\nGrande-Task: ${TASK}`);
  headSha = git(worktree, "rev-parse", "HEAD");
  git(canonical, "merge", "--no-ff", "-qm", "merge", headSha);
  mergeSha = git(canonical, "rev-parse", "HEAD");
  git(canonical, "remote", "add", "origin", "https://github.com/example/demo.git");
  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  createTask(deps.db, { taskId: TASK, repoId: "demo", branch: BRANCH, baseCommit: baseSha, worktreePath: worktree, state: "READY" });
  saveExplicitDeliveryTarget(deps.db, TASK, "pr");
  attestationCount = 0;
  attest();
  detail = { number: 54, url: PR_URL, state: "closed", draft: false, merged: true,
    mergeable: null, headSha, headRef: BRANCH, baseRef: "main", baseSha, mergeCommitSha: mergeSha };
  api = {
    findPullRequest: vi.fn(async () => ({ number: detail.number, url: detail.url })),
    getPullRequest: vi.fn(async () => detail),
    createPullRequest: vi.fn(async () => { throw new Error("remote create forbidden"); }),
    mergePullRequest: vi.fn(async () => { throw new Error("remote merge forbidden"); }),
    listCheckRuns: vi.fn(async () => []),
    listCommitStatuses: vi.fn(async () => []),
  };
});

afterEach(() => {
  deps?.db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const project = () => projectTaskProgress(deps.db, getTask(deps.db, TASK)!);

describe("production default-path lifecycle projection", () => {
  it("archives a removed CLOSED task using actual filesystem and exact attestation", () => {
    recordTaskPrMerged(deps.db, receiptInput());
    closeAndRemove();
    const before = deps.db.prepare("SELECT total_changes() AS n").get();
    const progress = project();
    expect(progress).toMatchObject({ completed: true, phase: "completed", blocker: null, cleanupRequired: false });
    expect(progress.stages.code.state).toBe("unknown");
    expect(progress.stages.tests.state).toBe("done");
    expect(progress.stages.tests.detail).not.toContain("未提交");
    expect(progress.cleanupEligibility?.eligible).toBe(false);
    expect(deps.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it("does not invent a historical test PASS from CLOSED or merged alone", () => {
    recordTaskPrMerged(deps.db, receiptInput());
    closeAndRemove();
    deps.db.prepare("DELETE FROM attestation WHERE taskId=?").run(TASK);
    expect(project().stages.tests.state).toBe("unknown");
  });

  it.each(["tracked.txt", "untracked.txt"])("refuses real dirty content: %s", (path) => {
    recordTaskPrMerged(deps.db, receiptInput());
    writeFileSync(join(worktree, path), "do not lose this\n");
    expect(project().cleanupEligibility?.eligible).toBe(false);
  });

  it("does not let an exact-head attestation hide a nonterminal job", () => {
    recordTaskPrMerged(deps.db, receiptInput());
    createJob(deps.db, { jobId: "job_live", taskId: TASK, profile: "unit", argv: [], pgid: null });
    expect(project().stages.tests.state).toBe("done");
    expect(project().cleanupEligibility?.eligible).toBe(false);
  });

  it("refuses a clean but unmerged newer head", () => {
    recordTaskPrMerged(deps.db, receiptInput());
    git(worktree, "commit", "--allow-empty", "-qm", "unpublished change");
    expect(project().cleanupEligibility?.eligible).toBe(false);
  });

  it("refuses unreadable Git state without treating it as clean", () => {
    recordTaskPrMerged(deps.db, receiptInput());
    rmSync(join(worktree, ".git"));
    expect(project().cleanupEligibility?.eligible).toBe(false);
  });

  it("keeps a verified clean merged worktree a reconciliation candidate, not a deletion action", () => {
    recordTaskPrMerged(deps.db, receiptInput());
    expect(project().cleanupEligibility?.eligible).toBe(true);
    expect(existsSync(worktree)).toBe(true);
  });

  it("keeps unresolved deployment fail-closed", () => {
    recordTaskPrMerged(deps.db, receiptInput());
    deps.db.prepare("UPDATE task_delivery_target SET target='deploy' WHERE taskId=?").run(TASK);
    expect(project().cleanupEligibility?.eligible).toBe(false);
  });
});

function wrapped() {
  const base = createPrMergeTool(deps, { apiFactory: () => api });
  const baseHandler = vi.fn(base.handler);
  const refresh = vi.fn(() => { throw new Error("historical reconciliation must not refresh/cleanup"); });
  return { baseHandler, refresh, tool: wrapPrMergeToolD2(deps, { ...base, handler: baseHandler }, {
    apiFactory: () => api, canonicalRefresher: refresh,
  }) };
}

async function invoke() {
  const { tool, baseHandler, refresh } = wrapped();
  const result = (await tool.handler({ taskId: TASK })).structuredContent as {
    ok: boolean; data?: { merged?: boolean; reconciled?: boolean }; error?: { code: string; message: string };
  };
  expect(baseHandler).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(api.mergePullRequest).not.toHaveBeenCalled();
  expect(api.createPullRequest).not.toHaveBeenCalled();
  return result;
}

describe("historical CLOSED task evidence-only reconciliation", () => {
  it("recovers a missing receipt without a worktree and is idempotent after database reopen", async () => {
    closeAndRemove();
    const taskBefore = getTask(deps.db, TASK);
    const refsBefore = git(canonical, "show-ref");
    const initialAuditCount = listAudit(deps.db, TASK, 100).length;
    expect(await invoke()).toMatchObject({ ok: true, data: { merged: true, reconciled: true } });
    const receipt = readTaskPrReceipt(deps.db, TASK);
    expect(receipt).toMatchObject(receiptInput());
    const auditsBefore = listAudit(deps.db, TASK, 100);
    expect(auditsBefore).toHaveLength(initialAuditCount + 1);
    expect(auditsBefore[0]).toMatchObject({ tool: "grande_pr_merge", state: "SUCCEEDED", pathsTouched: [] });
    deps.db.close(); deps.db = openDb(deps.layout);
    expect((await invoke()).ok).toBe(true);
    expect(readTaskPrReceipt(deps.db, TASK)).toEqual(receipt);
    expect(listAudit(deps.db, TASK, 100)).toEqual(auditsBefore);
    expect(getTask(deps.db, TASK)).toEqual(taskBefore);
    expect(git(canonical, "show-ref")).toBe(refsBefore);
    expect(existsSync(worktree)).toBe(false);
    expect(project()).toMatchObject({ completed: true, blocker: null });
  });

  it("derives historical merge base from the merge commit, not moving GitHub base.sha", async () => {
    closeAndRemove();
    git(canonical, "commit", "--allow-empty", "-qm", "later canonical commit");
    detail.baseSha = git(canonical, "rev-parse", "HEAD");
    expect((await invoke()).ok).toBe(true);
    expect(readTaskPrReceipt(deps.db, TASK)).toMatchObject({ baseSha, mergeSha });
  });

  it.each([
    { label: "unmerged PR", patch: { merged: false } },
    { label: "wrong task branch", patch: { headRef: "grande/other" } },
    { label: "wrong repository URL", patch: { url: "https://github.com/other/demo/pull/54" } },
    { label: "unattested head", patch: { headSha: "9".repeat(40) } },
    { label: "unknown merge object", patch: { mergeCommitSha: "9".repeat(40) } },
    { label: "wrong base branch", patch: { baseRef: "release" } },
  ])("rejects $label without a receipt write", async ({ patch }) => {
    closeAndRemove(); Object.assign(detail, patch);
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
  });

  it("requires trusted local exact-head evidence, not a legacy success audit", async () => {
    closeAndRemove();
    deps.db.prepare("DELETE FROM attestation WHERE taskId=?").run(TASK);
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
  });

  it("rejects stale head evidence when a newer attested task head exists", async () => {
    closeAndRemove(); attest("9".repeat(40));
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
  });

  it("does not relabel a later canonical commit as this PR's merge", async () => {
    closeAndRemove();
    git(canonical, "commit", "--allow-empty", "-qm", "not the PR merge");
    detail.mergeCommitSha = git(canonical, "rev-parse", "HEAD");
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
  });

  it("preserves conflicting receipt identity", async () => {
    recordTaskPrOpened(deps.db, { ...receiptInput(), prNumber: 55, prUrl: PR_URL.replace("54", "55") });
    closeAndRemove();
    const before = readTaskPrReceipt(deps.db, TASK);
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toEqual(before);
  });

  it("rolls receipt and success audit back together if the audit write fails", async () => {
    closeAndRemove();
    deps.db.exec(`CREATE TRIGGER fail_reconcile_audit BEFORE INSERT ON audit
      WHEN NEW.tool='grande_pr_merge' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    const before = listAudit(deps.db, TASK, 100);
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
    expect(listAudit(deps.db, TASK, 100)).toEqual(before);
  });

  it("refuses a CLOSED task with a live job", async () => {
    closeAndRemove();
    createJob(deps.db, { jobId: "job_live", taskId: TASK, profile: "unit", argv: [], pgid: null });
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
  });

  it("does not route explicit deployment through PR-only historical recovery", async () => {
    closeAndRemove();
    deps.db.prepare("UPDATE task_delivery_target SET target='deploy' WHERE taskId=?").run(TASK);
    expect((await invoke()).ok).toBe(false);
    expect(api.findPullRequest).not.toHaveBeenCalled();
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
  });

  it("detects changed task version after the remote read", async () => {
    closeAndRemove();
    vi.mocked(api.getPullRequest).mockImplementation(async () => {
      deps.db.prepare("UPDATE task SET stateVersion=stateVersion+1 WHERE taskId=?").run(TASK);
      return detail;
    });
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
  });

  it("preserves worktree content that reappears while reading the PR", async () => {
    closeAndRemove();
    vi.mocked(api.getPullRequest).mockImplementation(async () => {
      mkdirSync(worktree); writeFileSync(join(worktree, "human.txt"), "keep\n");
      return detail;
    });
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
    expect(existsSync(join(worktree, "human.txt"))).toBe(true);
  });

  it("refuses a dirty canonical without discarding changes", async () => {
    closeAndRemove(); writeFileSync(join(canonical, "human.txt"), "keep\n");
    expect((await invoke()).ok).toBe(false);
    expect(readTaskPrReceipt(deps.db, TASK)).toBeNull();
    expect(existsSync(join(canonical, "human.txt"))).toBe(true);
  });
});

async function statusEnvelope() {
  const source = { ok: true, hint: "worktree 不存在；运行 grande gc", data: {
    state: "CLOSED", base: { error: "stale/ghost worktree" }, progress: project(),
  } };
  const status: ToolDef = {
    name: "grande_task_status", description: "status fixture", inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async () => ({ structuredContent: source }),
  };
  addFlowSimplification(deps, [status]);
  await status.handler({ taskId: TASK });
  return source;
}

describe("status envelope after cleanup", () => {
  it("does not call a proven archived task a ghost or suggest gc", async () => {
    recordTaskPrMerged(deps.db, receiptInput()); closeAndRemove();
    const response = await statusEnvelope();
    expect(response.hint).not.toContain("grande gc");
    expect(response.data.base).not.toHaveProperty("error");
    expect(response.data.progress).toMatchObject({ completed: true, phase: "completed", blocker: null });
  });

  it("preserves recovery hints when historical completion has not been proven", async () => {
    closeAndRemove();
    const response = await statusEnvelope();
    expect(response.hint).toContain("grande gc");
    expect(response.data.progress.completed).toBe(false);
  });
});
