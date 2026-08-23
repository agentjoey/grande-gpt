import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { HostVerifierCoordinator } from "../src/hostVerifier.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, TOOLSET_EPOCH, toolsetIdentity } from "../src/tools.ts";
import type { ToolDeps } from "../src/toolsCore.ts";

const taskId = "task_activation_wiring";
const branch = "grande/activation-wiring";
const token = "github_pat_activation_abcdefghijklmnopqrstuvwxyz";
let root: string;
let deps: ToolDeps;
let worktree: string;
let baseCommit: string;
let headSha: string;
let originalFetch: typeof fetch;

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

function attest(commit: string): void {
  const now = Date.now();
  const jobId = "job_activation_attestation";
  const toolchain = JSON.stringify({ node: "v24", pnpm: "10", lockfileSha256: "a".repeat(64) });
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, taskId, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", toolchain);
  deps.db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("att_activation", taskId, commit, "unit-selfhost", jobId, 0, now - 10, now, toolchain);
}

function hostJob(input: {
  jobId: string;
  sha: string;
  state: "running" | "passed" | "failed";
  startedAt: number;
  endedAt?: number;
  summary: Record<string, unknown>;
}): void {
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,summary)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.jobId,
    taskId,
    "host-verifier",
    JSON.stringify(["trusted-host-verifier", "smoke", input.sha]),
    input.state,
    input.state === "passed" ? 0 : input.state === "failed" ? 1 : null,
    input.startedAt,
    input.endedAt ?? null,
    JSON.stringify({ repoId: "grande-gpt", commit: input.sha, level: "smoke", ...input.summary }),
  );
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-verification-production-wiring-"));
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
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "feature.ts"), "export const feature = true;\n", "utf8");
  git(worktree, "add", "src/feature.ts");
  git(worktree, "-c", "user.name=Grande", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "feature");
  headSha = git(worktree, "rev-parse", "HEAD");
  git(worktree, "remote", "add", "origin", "https://github.com/fake-owner/grande-gpt.git");
  createTask(deps.db, { taskId, repoId: "grande-gpt", branch, baseCommit, worktreePath: worktree, state: "READY" });
  attest(headSha);

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/pulls?") && !url.includes("/pulls/73")) {
      return json([{ number: 73, html_url: "https://github.com/fake-owner/grande-gpt/pull/73" }]);
    }
    if (url.endsWith("/pulls/73")) {
      return json({
        number: 73,
        html_url: "https://github.com/fake-owner/grande-gpt/pull/73",
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        head: { sha: headSha, ref: branch },
        base: { ref: "main" },
      });
    }
    if (url.includes("/check-runs")) {
      return json({ check_runs: [{ id: 1, name: "unit", status: "completed", conclusion: "success", details_url: null, output: null }] });
    }
    if (url.includes("/statuses?")) return json([]);
    throw new Error(`unexpected GitHub URL: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  deps.db.close();
  delete process.env.GRANDE_WORKSPACE;
  delete process.env.GRANDE_CONTROL;
  rmSync(root, { recursive: true, force: true });
});

describe("production Host Verifier lifecycle wiring", () => {
  it("forwards trusted auto mode and the shared coordinator through buildTools", async () => {
    let launches = 0;
    const coordinator = new HostVerifierCoordinator(() => {
      launches += 1;
      return { jobId: "job-production-auto", settled: new Promise<void>(() => {}) };
    });

    const tools = (buildTools as any)(deps, {
      hostVerificationMode: "auto",
      hostVerifierCoordinator: coordinator,
    });
    const merge = tools.find((tool: { name: string }) => tool.name === "grande_pr_merge");
    expect(merge).toBeDefined();

    const envelope = (await merge.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope).toMatchObject({
      ok: true,
      data: { merged: false, verification: { state: "running", jobId: "job-production-auto" } },
    });
    expect(launches).toBe(1);
  });

  it("projects the same trusted auto mode through grande_task_status without mandatory pr_status preflight", async () => {
    const prAudit = beginAudit(deps.db, { taskId, tool: "grande_pr_open", input: { taskId } });
    expect(prAudit.allowed()).toBe(true);
    expect(prAudit.executing()).toBe(true);
    expect(prAudit.succeeded([])).toBe(true);

    const tools = (buildTools as any)(deps, { hostVerificationMode: "auto" });
    const status = tools.find((tool: { name: string }) => tool.name === "grande_task_status");
    expect(status).toBeDefined();

    const envelope = (await status.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope.data.deliveryTarget).toBe("pr");
    expect(envelope.data.developmentRisk).toBe("L2");
    expect(envelope.data.progress).toMatchObject({
      phase: "host-verification",
      hostVerification: {
        requiredLevel: "smoke",
        manualOnlyRequired: false,
        receiptEligible: false,
        state: "required",
        retryCount: 0,
        jobId: null,
      },
      blocker: null,
      nextAction: "直接调用 grande_pr_merge 创建或观察当前 exact-SHA host verifier",
    });
    expect(envelope.data.hostVerifier).toMatchObject({
      mode: "auto",
      enabled: true,
      state: "idle",
      lastAttemptAt: null,
      lastAttemptSha: null,
      lastResult: null,
      lastDurationMs: null,
      lastSuccessAt: null,
      lastSuccessSha: null,
      lastFailureAt: null,
      lastFailureClass: null,
      lastFailureReason: null,
      activeJobId: null,
      queueDepth: 0,
      currentSha: headSha,
      currentResult: null,
    });
    expect(envelope.data.hostVerifier.verifierBuild).toMatch(/^(git:[0-9a-f]{40}|dev)$/);
    expect(envelope.data.hostVerifier.verifierVersion).toEqual(expect.any(Number));
  });

  it("projects a trusted PASS with SHA and duration, but does not reuse it as the current SHA result", async () => {
    const startedAt = 1000;
    const endedAt = 1123;
    hostJob({
      jobId: "job-old-pass",
      sha: baseCommit,
      state: "passed",
      startedAt,
      endedAt,
      summary: { kind: "host-verifier-v2", mode: "auto" },
    });

    const tools = (buildTools as any)(deps, { hostVerificationMode: "auto" });
    const status = tools.find((tool: { name: string }) => tool.name === "grande_task_status");
    const envelope = (await status.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.data.hostVerifier).toMatchObject({
      state: "idle",
      lastAttemptAt: startedAt,
      lastAttemptSha: baseCommit,
      lastResult: "passed",
      lastDurationMs: 123,
      lastSuccessAt: endedAt,
      lastSuccessSha: baseCommit,
      currentSha: headSha,
      currentResult: null,
    });
  });

  it("projects a running verifier from persisted control-plane state", async () => {
    hostJob({
      jobId: "job-running-visible",
      sha: headSha,
      state: "running",
      startedAt: 2000,
      summary: { kind: "host-verifier-running", receiptMode: "auto" },
    });

    const tools = (buildTools as any)(deps, { hostVerificationMode: "auto" });
    const status = tools.find((tool: { name: string }) => tool.name === "grande_task_status");
    const envelope = (await status.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.data.hostVerifier).toMatchObject({
      state: "running",
      lastAttemptSha: headSha,
      lastResult: "running",
      activeJobId: "job-running-visible",
      queueDepth: 0,
      currentSha: headSha,
      currentResult: "running",
    });
  });

  it("projects candidate failure class/reason as blocked without reading artifact logs", async () => {
    hostJob({
      jobId: "job-candidate-red",
      sha: headSha,
      state: "failed",
      startedAt: 3000,
      endedAt: 3042,
      summary: {
        kind: "host-verifier-failure",
        failureClass: "candidate",
        reason: "test_failed",
        testFailure: true,
      },
    });

    const tools = (buildTools as any)(deps, { hostVerificationMode: "auto" });
    const status = tools.find((tool: { name: string }) => tool.name === "grande_task_status");
    const envelope = (await status.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.data.hostVerifier).toMatchObject({
      state: "blocked",
      lastAttemptSha: headSha,
      lastResult: "candidate_failed",
      lastDurationMs: 42,
      lastFailureAt: 3042,
      lastFailureClass: "candidate",
      lastFailureReason: "test_failed",
      activeJobId: null,
      currentSha: headSha,
      currentResult: "candidate_failed",
    });
  });

  it("keeps the public MCP tool contract identical between manual and auto modes", () => {
    const coordinator = new HostVerifierCoordinator(() => ({
      jobId: "job-contract-never-runs",
      settled: Promise.resolve(),
    }));
    const manual = buildTools(deps, { hostVerificationMode: "manual" });
    const auto = buildTools(deps, {
      hostVerificationMode: "auto",
      hostVerifierCoordinator: coordinator,
    });

    expect(TOOLSET_EPOCH).toBe(2);
    expect(manual).toHaveLength(25);
    expect(auto).toHaveLength(25);
    expect(toolsetIdentity(auto)).toEqual(toolsetIdentity(manual));
  });
});
