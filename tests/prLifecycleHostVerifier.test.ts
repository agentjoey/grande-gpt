import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import type { GithubLifecycleApi, GithubPullRequestDetail } from "../src/githubApi.ts";
import { buildHostVerifierStaticPlan, HostVerifierCoordinator } from "../src/hostVerifier.ts";
import { createJob, finishJob, setRunningJobSummary } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { persistTrustedOuterTestPassV2 } from "../src/outerTestReceipt.ts";
import { createPrMergeTool } from "../src/prLifecycle.ts";
import { createTask } from "../src/tasks.ts";
import type { ToolDeps } from "../src/toolsCore.ts";

const taskId = "task_c3_host_gate";
const branch = "grande/c3-host-gate";
const token = "github_pat_c3_abcdefghijklmnopqrstuvwxyz";
let root: string;
let deps: ToolDeps;
let worktree: string;
let baseCommit: string;
let headSha: string;
let ciState: "success" | "failure" = "success";
let mergeable = true;
let mergeCalls: string[];
let lifecycleReads = 0;

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

function api(): GithubLifecycleApi {
  return {
    async findPullRequest() { return { number: 73, url: "https://github.com/fake/grande-gpt/pull/73" }; },
    async createPullRequest() { throw new Error("not used"); },
    async getPullRequest() {
      lifecycleReads += 1;
      const detail: GithubPullRequestDetail = {
        number: 73,
        url: "https://github.com/fake/grande-gpt/pull/73",
        state: "open",
        draft: false,
        merged: false,
        mergeable,
        headSha,
        headRef: branch,
        baseRef: "main",
      };
      return detail;
    },
    async listCheckRuns() {
      return [{
        id: 1,
        name: "unit",
        status: "completed" as const,
        conclusion: ciState,
        detailsUrl: null,
        output: null,
      }];
    },
    async listCommitStatuses() { return []; },
    async mergePullRequest(_owner, _repo, _number, sha) {
      mergeCalls.push(sha);
      return { merged: true, sha: "merge-sha", message: "merged" };
    },
  };
}

function attest(commit: string): void {
  const now = Date.now();
  const suffix = commit.slice(0, 10);
  const jobId = `job_att_${suffix}`;
  const toolchain = JSON.stringify({ node: "v24", pnpm: "10", lockfileSha256: "a".repeat(64) });
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, taskId, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", toolchain);
  deps.db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`att_${suffix}`, taskId, commit, "unit-selfhost", jobId, 0, now - 10, now, toolchain);
}

function writeEligibleAutoReceipt(commit = headSha, level: "smoke" | "full" = "smoke"): void {
  const plan = buildHostVerifierStaticPlan(level);
  const jobId = `job_host_${commit.slice(0, 10)}_${level}`;
  createJob(deps.db, { jobId, taskId, profile: "host-verifier", argv: ["trusted-host-verifier"], pgid: 1234 });
  finishJob(deps.db, jobId, {
    state: "passed",
    exitCode: 0,
    artifactPath: null,
    summary: {
      kind: "host-verifier-v2",
      mode: "auto",
      repoId: "grande-gpt",
      commit,
      level,
      files: plan.files,
      policyVersion: plan.policyVersion,
      resourceLimits: plan.resourceLimits,
      loopbackPorts: [49173],
      hostToolchain: { node: "v24.14.0", pnpm: "10.33.0", lockfileSha256: "b".repeat(64) },
    },
  });
  persistTrustedOuterTestPassV2(deps.db, taskId, jobId);
}

function writeVerifierFailure(kind: "test" | "infrastructure", suffix: string): string {
  const jobId = `job_${kind}_${suffix}`;
  createJob(deps.db, { jobId, taskId, profile: "host-verifier", argv: ["trusted-host-verifier"], pgid: 2000 });
  finishJob(deps.db, jobId, {
    state: "failed",
    exitCode: kind === "test" ? 1 : null,
    artifactPath: null,
    summary: {
      kind: "host-verifier-failure",
      repoId: "grande-gpt",
      commit: headSha,
      level: "smoke",
      testFailure: kind === "test",
      infrastructureFailure: kind === "infrastructure",
      error: kind === "infrastructure" ? "sandbox infrastructure unavailable" : undefined,
      cleaned: true,
    },
  });
  return jobId;
}

function writeRunningVerifier(): string {
  const jobId = "job_persisted_running";
  createJob(deps.db, { jobId, taskId, profile: "host-verifier", argv: ["trusted-host-verifier"], pgid: 2222 });
  setRunningJobSummary(deps.db, jobId, {
    kind: "host-verifier-running",
    repoId: "grande-gpt",
    commit: headSha,
    level: "smoke",
  });
  return jobId;
}

function commitChange(path: string): void {
  const absolute = join(worktree, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, `${Date.now()}\n`, "utf8");
  git(worktree, "add", path);
  git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "-q", "-m", `change ${path}`);
  headSha = git(worktree, "rev-parse", "HEAD");
}

function tool(options: Record<string, unknown> = {}) {
  return createPrMergeTool(deps, {
    apiFactory: () => api(),
    readRemoteUrl: () => "https://github.com/fake-owner/grande-gpt.git",
    readLocalHead: () => headSha,
    canonicalRefresher: () => ({ action: "none", relation: "equal", branch: "main", before: baseCommit, after: "merge-sha", remoteHead: "merge-sha" }),
    ...options,
  } as any);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "c3-host-gate-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  const layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(join(layout.controlRoot, "secrets", "github-token"), `${token}\n`, { mode: 0o600 });
  deps = { db: openDb(layout), layout, defaultRepoId: "grande-gpt" };

  worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "-q", "-b", branch);
  writeFileSync(join(worktree, "README.md"), "base\n", "utf8");
  git(worktree, "add", "README.md");
  git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "base");
  baseCommit = git(worktree, "rev-parse", "HEAD");
  commitChange("src/feature.ts");
  git(worktree, "remote", "add", "origin", "https://github.com/fake-owner/grande-gpt.git");
  createTask(deps.db, { taskId, repoId: "grande-gpt", branch, baseCommit, worktreePath: worktree, state: "READY" });
  attest(headSha);
  ciState = "success";
  mergeable = true;
  mergeCalls = [];
  lifecycleReads = 0;
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("C3 host verification merge gate", () => {
  it("auto mode creates/observes one restricted verifier and never merges in that invocation", async () => {
    let launches = 0;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const coordinator = new HostVerifierCoordinator((request, plan) => {
      launches += 1;
      expect(request).toMatchObject({ taskId, repoId: "grande-gpt", commit: headSha, level: "smoke" });
      expect(plan.level).toBe("smoke");
      return { jobId: "job-c3-auto", settled };
    });
    const merge = tool({ hostVerificationMode: "auto", hostVerifierCoordinator: coordinator });

    const first = (await merge.handler({ taskId })).structuredContent as Record<string, any>;
    const second = (await merge.handler({ taskId })).structuredContent as Record<string, any>;
    expect(first).toMatchObject({ ok: true, data: { merged: false, verification: { state: "running", jobId: "job-c3-auto" } } });
    expect(second.data.verification.jobId).toBe("job-c3-auto");
    expect(launches).toBe(1);
    expect(mergeCalls).toEqual([]);
    settle();
  });

  it("observes a persisted matching running verifier instead of creating a duplicate", async () => {
    const runningJob = writeRunningVerifier();
    let launches = 0;
    const coordinator = new HostVerifierCoordinator(() => {
      launches += 1;
      return { jobId: "duplicate", settled: Promise.resolve() };
    });
    const envelope = (await tool({ hostVerificationMode: "auto", hostVerifierCoordinator: coordinator }).handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope).toMatchObject({ ok: true, data: { merged: false, verification: { state: "running", jobId: runningJob, persisted: true } } });
    expect(launches).toBe(0);
    expect(mergeCalls).toEqual([]);
  });

  it("manual mode returns the single Human action instead of spawning candidate tests", async () => {
    const envelope = (await tool({ hostVerificationMode: "manual" }).handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope).toMatchObject({ ok: true, data: { merged: false, verification: { state: "manual_required" } } });
    expect(JSON.stringify(envelope)).toContain(`grande outer-test --task ${taskId} --run`);
    expect(mergeCalls).toEqual([]);
  });

  it("manual-only plan never starts auto verifier even when auto mode is enabled", async () => {
    commitChange("src/hostVerifierRuntime.ts");
    attest(headSha);
    let launches = 0;
    const coordinator = new HostVerifierCoordinator(() => {
      launches += 1;
      return { jobId: "should-not-start", settled: Promise.resolve() };
    });
    const envelope = (await tool({ hostVerificationMode: "auto", hostVerifierCoordinator: coordinator }).handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope).toMatchObject({ ok: true, data: { merged: false, verification: { state: "human_gate", manualOnlyRequired: true, level: "full" } } });
    expect(launches).toBe(0);
    expect(mergeCalls).toEqual([]);
  });

  it("code test failure is actionable and never auto-retried for the same SHA", async () => {
    const failedJob = writeVerifierFailure("test", "red");
    let launches = 0;
    const coordinator = new HostVerifierCoordinator(() => {
      launches += 1;
      return { jobId: "wrong-retry", settled: Promise.resolve() };
    });
    const envelope = (await tool({ hostVerificationMode: "auto", hostVerifierCoordinator: coordinator }).handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope).toMatchObject({
      ok: true,
      data: { merged: false, verification: { state: "failed", kind: "test", jobId: failedJob, retryable: false } },
    });
    expect(launches).toBe(0);
    expect(mergeCalls).toEqual([]);
  });

  it("one infrastructure failure is retried once on the next merge invocation", async () => {
    const failedJob = writeVerifierFailure("infrastructure", "first");
    let launches = 0;
    const coordinator = new HostVerifierCoordinator(() => {
      launches += 1;
      return { jobId: "job-infra-retry", settled: new Promise<void>(() => {}) };
    });
    const envelope = (await tool({ hostVerificationMode: "auto", hostVerifierCoordinator: coordinator }).handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope).toMatchObject({
      ok: true,
      data: { merged: false, verification: { state: "running", jobId: "job-infra-retry", retryOf: failedJob } },
    });
    expect(launches).toBe(1);
    expect(mergeCalls).toEqual([]);
  });

  it("two consecutive infrastructure failures stop auto retry and become a Human Gate", async () => {
    writeVerifierFailure("infrastructure", "first");
    const second = writeVerifierFailure("infrastructure", "second");
    let launches = 0;
    const coordinator = new HostVerifierCoordinator(() => {
      launches += 1;
      return { jobId: "must-not-run", settled: Promise.resolve() };
    });
    const envelope = (await tool({ hostVerificationMode: "auto", hostVerifierCoordinator: coordinator }).handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        merged: false,
        verification: { state: "human_gate", kind: "infrastructure", jobId: second, consecutiveFailures: 2 },
      },
    });
    expect(JSON.stringify(envelope)).toContain(`grande outer-test --task ${taskId} --run`);
    expect(launches).toBe(0);
    expect(mergeCalls).toEqual([]);
  });

  it("a passed receipt only enables a later merge call, which re-fetches CI/mergeability/SHA", async () => {
    let settle!: () => void;
    const coordinator = new HostVerifierCoordinator(() => ({
      jobId: "job-c3-pass",
      settled: new Promise<void>((resolve) => { settle = resolve; }),
    }));
    const merge = tool({ hostVerificationMode: "auto", hostVerifierCoordinator: coordinator });
    const first = (await merge.handler({ taskId })).structuredContent as Record<string, any>;
    expect(first.data.merged).toBe(false);
    expect(mergeCalls).toEqual([]);
    settle();
    writeEligibleAutoReceipt();

    ciState = "failure";
    const blocked = (await merge.handler({ taskId })).structuredContent as Record<string, any>;
    expect(blocked.ok).toBe(false);
    expect(mergeCalls).toEqual([]);

    ciState = "success";
    const merged = (await merge.handler({ taskId })).structuredContent as Record<string, any>;
    expect(merged).toMatchObject({ ok: true, data: { merged: true, headSha } });
    expect(mergeCalls).toEqual([headSha]);
    expect(lifecycleReads).toBeGreaterThanOrEqual(3);
  });

  it("plan drift makes an old V2 receipt ineligible and schedules the current full auto-safe plan", async () => {
    writeEligibleAutoReceipt(headSha, "smoke");
    commitChange("src/server.ts");
    attest(headSha);
    let requestLevel: string | undefined;
    const coordinator = new HostVerifierCoordinator((request) => {
      requestLevel = request.level;
      return { jobId: "job-c3-full", settled: new Promise<void>(() => {}) };
    });
    const envelope = (await tool({ hostVerificationMode: "auto", hostVerifierCoordinator: coordinator }).handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope).toMatchObject({ ok: true, data: { merged: false, verification: { state: "running", level: "full", jobId: "job-c3-full" } } });
    expect(requestLevel).toBe("full");
    expect(mergeCalls).toEqual([]);
  });
});
