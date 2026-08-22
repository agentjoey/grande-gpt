import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { safeGit } from "./gitExec.ts";
import { getJob, listJobs, TERMINAL, type JobRow } from "./jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "./layout.ts";
import { computeOuterTestPlanDigest, getOuterTestReceipt } from "./outerTestReceipt.ts";
import { createProductionHostVerification } from "./hostVerificationProduction.ts";
import { loadDepDirs } from "./profiles.ts";
import { saveRegistry } from "./registry.ts";
import { createTask } from "./tasks.ts";
import type { HostVerifierCoordinator, HostVerifierRequest } from "./hostVerifier.ts";

export const ACTIVATION_SOAK_RUNS = 20;
const SOAK_LEVEL = "full" as const;
const SOAK_TASK_PREFIX = "task_host_verifier_activation_soak";
const SOAK_RUNNING_DISPATCH: ReadonlySet<string> = new Set(["running"]);

interface SoakCoordinator {
  start(request: HostVerifierRequest): ReturnType<HostVerifierCoordinator["start"]>;
}

export interface SequentialHostVerifierSoakInput {
  db: DatabaseSync;
  coordinator: SoakCoordinator;
  request: HostVerifierRequest;
  runs: number;
  sentinel: string;
  probeGateway: () => Promise<void>;
  pollIntervalMs?: number;
  perRunTimeoutMs?: number;
}

export interface HostVerifierSoakSummary {
  runs: number;
  passed: number;
  mode: "auto";
  level: "full";
  commit: string;
  jobIds: string[];
  staticPlanDigest: string;
  gatewayProbes: number;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function boundedArtifactTail(job: JobRow, maxChars = 4000): string | null {
  if (!job.artifactPath || !existsSync(job.artifactPath)) return null;
  try {
    const text = readFileSync(job.artifactPath, "utf8");
    return text.length <= maxChars ? text : text.slice(-maxChars);
  } catch {
    return null;
  }
}

export function describeSoakJobFailure(job: JobRow): string {
  const detail = {
    jobId: job.jobId,
    state: job.state,
    exitCode: job.exitCode,
    pgid: job.pgid,
    summary: job.summary,
    artifactTail: boundedArtifactTail(job),
  };
  return JSON.stringify(detail);
}

/**
 * Copy only the trusted dependency-directory allowlist required by the real
 * verifier runtime into the isolated soak control plane. No run profiles,
 * repository content, argv, cwd or environment are imported from the candidate.
 */
export function copyTrustedSoakDepDirs(sourceLayout: Layout, targetLayout: Layout, repoId: string): string[] {
  const depDirs = [...loadDepDirs(sourceLayout, repoId)];
  if (depDirs.length === 0) throw new Error(`activation soak has no trusted dependency roots for ${repoId}`);
  writeFileSync(
    join(targetLayout.configDir, "profiles.yaml"),
    `${JSON.stringify({ depDirs: { [repoId]: depDirs } }, null, 2)}\n`,
    "utf8",
  );
  return depDirs;
}

function assertNoSentinel(job: JobRow, sentinel: string): void {
  if (!sentinel) throw new Error("soak sentinel required");
  const summary = JSON.stringify(job.summary ?? {});
  if (summary.includes(sentinel)) throw new Error(`soak secret sentinel leaked into job summary ${job.jobId}`);
  if (job.artifactPath && existsSync(job.artifactPath)) {
    const artifact = readFileSync(job.artifactPath, "utf8");
    if (artifact.includes(sentinel)) throw new Error(`soak secret sentinel leaked into artifact ${job.jobId}`);
  }
}

function assertPassedAutoReceipt(db: DatabaseSync, request: HostVerifierRequest, job: JobRow): void {
  if (job.profile !== "host-verifier" || job.state !== "passed" || job.exitCode !== 0 || job.endedAt === null) {
    throw new Error(`soak verifier job did not pass cleanly: ${describeSoakJobFailure(job)}`);
  }
  const summary = job.summary as Record<string, unknown> | null;
  if (!summary || summary.kind !== "host-verifier-v2" || summary.mode !== "auto") {
    throw new Error(`soak verifier job ${job.jobId} did not produce trusted auto V2 summary`);
  }
  if (summary.repoId !== request.repoId || summary.commit !== request.commit || summary.level !== request.level) {
    throw new Error(`soak verifier job ${job.jobId} exact request binding mismatch`);
  }
  if (!Array.isArray(summary.files) || summary.files.some((file) => typeof file !== "string")) {
    throw new Error(`soak verifier job ${job.jobId} trusted file list missing`);
  }
  const policyVersion = summary.policyVersion;
  const resourceLimits = summary.resourceLimits;
  const loopbackPorts = summary.loopbackPorts;
  if (!Number.isInteger(policyVersion) || typeof resourceLimits !== "object" || resourceLimits === null || !Array.isArray(loopbackPorts)) {
    throw new Error(`soak verifier job ${job.jobId} trusted plan metadata missing`);
  }
  const planDigest = computeOuterTestPlanDigest({
    level: request.level,
    files: summary.files as string[],
    policyVersion: policyVersion as number,
    resourceLimits: resourceLimits as Parameters<typeof computeOuterTestPlanDigest>[0]["resourceLimits"],
    loopbackPorts: loopbackPorts as number[],
  });

  const receipt = getOuterTestReceipt(db, request.taskId);
  if (!receipt || !("version" in receipt) || receipt.version !== 2 || receipt.mode !== "auto") {
    throw new Error(`soak receipt for ${job.jobId} is not auto V2`);
  }
  if (
    receipt.jobId !== job.jobId || receipt.taskId !== request.taskId || receipt.repoId !== request.repoId ||
    receipt.commit !== request.commit || receipt.level !== request.level || receipt.planDigest !== planDigest
  ) {
    throw new Error(`soak receipt for ${job.jobId} exact job/SHA/plan binding mismatch`);
  }
}

async function waitForTerminalJob(
  db: DatabaseSync,
  jobId: string,
  probeGateway: () => Promise<void>,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<{ job: JobRow; probes: number }> {
  const deadline = Date.now() + timeoutMs;
  let probes = 0;
  while (Date.now() < deadline) {
    await probeGateway();
    probes += 1;
    const job = getJob(db, jobId);
    if (!job) throw new Error(`soak verifier job disappeared: ${jobId}`);
    if (TERMINAL.has(job.state)) return { job, probes };
    await sleep(pollIntervalMs);
  }
  throw new Error(`soak verifier job ${jobId} exceeded host-side observation timeout`);
}

/**
 * Sequential activation soak over one production-equivalent auto coordinator.
 * It never writes candidate files or selects argv/cwd/env. Each iteration must
 * create a fresh verifier job and trusted auto V2 receipt for the exact SHA.
 */
export async function runSequentialHostVerifierSoak(
  input: SequentialHostVerifierSoakInput,
): Promise<HostVerifierSoakSummary> {
  if (!Number.isInteger(input.runs) || input.runs <= 0) throw new Error("soak runs must be a positive integer");
  if (input.request.level !== SOAK_LEVEL) throw new Error("activation soak must use full verification");
  if (!/^[0-9a-f]{40}$/u.test(input.request.commit)) throw new Error("activation soak requires exact 40-hex SHA");

  const startedAt = Date.now();
  const jobIds: string[] = [];
  let staticPlanDigest: string | null = null;
  let gatewayProbes = 0;
  const pollIntervalMs = input.pollIntervalMs ?? 1000;
  const perRunTimeoutMs = input.perRunTimeoutMs ?? 135_000;

  for (let index = 0; index < input.runs; index += 1) {
    await input.probeGateway();
    gatewayProbes += 1;
    const dispatch = input.coordinator.start(input.request);
    if (!SOAK_RUNNING_DISPATCH.has(dispatch.state) || dispatch.coalesced) {
      throw new Error(`soak run ${index + 1} did not create a fresh verifier job`);
    }
    if (jobIds.includes(dispatch.jobId)) throw new Error(`soak verifier job id repeated: ${dispatch.jobId}`);
    if (staticPlanDigest === null) staticPlanDigest = dispatch.staticPlanDigest;
    else if (dispatch.staticPlanDigest !== staticPlanDigest) throw new Error("soak static plan digest drifted between runs");

    const observed = await waitForTerminalJob(
      input.db,
      dispatch.jobId,
      input.probeGateway,
      pollIntervalMs,
      perRunTimeoutMs,
    );
    gatewayProbes += observed.probes;
    await input.probeGateway();
    gatewayProbes += 1;

    assertPassedAutoReceipt(input.db, input.request, observed.job);
    assertNoSentinel(observed.job, input.sentinel);
    if (observed.job.pgid !== null && groupAlive(observed.job.pgid)) {
      throw new Error(`soak verifier process group still alive after terminal job ${observed.job.jobId}`);
    }
    jobIds.push(observed.job.jobId);
  }

  const unsettled = listJobs(input.db, input.request.taskId).filter((job) => !TERMINAL.has(job.state));
  if (unsettled.length > 0) throw new Error(`soak left ${unsettled.length} permanent running job(s)`);
  if (jobIds.length !== input.runs || new Set(jobIds).size !== input.runs) {
    throw new Error("soak did not produce the required number of unique verifier jobs");
  }

  return {
    runs: input.runs,
    passed: jobIds.length,
    mode: "auto",
    level: SOAK_LEVEL,
    commit: input.request.commit,
    jobIds,
    staticPlanDigest: staticPlanDigest ?? "",
    gatewayProbes,
    durationMs: Date.now() - startedAt,
  };
}

async function probeProductionGateway(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch("http://127.0.0.1:8787/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (response.status !== 401) throw new Error(`production Gateway readiness expected 401, received ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

function parseArgs(argv: readonly string[]): { taskWorktree: string; commit: string } {
  let taskWorktree: string | undefined;
  let commit: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--task-worktree") taskWorktree = argv[++index];
    else if (arg === "--commit") commit = argv[++index];
    else throw new Error(`unknown soak argument: ${arg}`);
  }
  if (!taskWorktree || !commit) throw new Error("usage: hostVerifierSoak --task-worktree <path> --commit <40-hex-sha>");
  return { taskWorktree, commit };
}

/**
 * Host-only activation entry. Uses an isolated temporary control plane so the
 * 20-run reliability evidence never pollutes production Gateway jobs/receipts.
 * The actual workspace, exact commit, dependencies, Seatbelt and process-group
 * runtime are real. PR-head equality is injected host-side solely for this soak;
 * production Gateway startup continues to use the trusted GitHub observer.
 */
export async function runActivationHostVerifierSoak(input: {
  taskWorktree: string;
  commit: string;
}): Promise<HostVerifierSoakSummary> {
  if (!/^[0-9a-f]{40}$/u.test(input.commit)) throw new Error("activation soak commit must be exact 40-hex SHA");
  const workspace = process.env.GRANDE_WORKSPACE;
  if (!workspace) throw new Error("GRANDE_WORKSPACE is required for activation soak");
  const taskWorktree = realpathSync(input.taskWorktree);
  const status = safeGit.local(taskWorktree, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (status) throw new Error("activation soak task worktree must be clean");
  const head = safeGit.local(taskWorktree, ["rev-parse", "HEAD"]).trim();
  if (head !== input.commit) throw new Error(`activation soak task HEAD ${head} does not match requested ${input.commit}`);
  const branch = safeGit.local(taskWorktree, ["branch", "--show-current"]).trim();
  if (!branch.startsWith("grande/")) throw new Error("activation soak must target a Grande task branch");

  const trustedControlLayout = loadLayout();
  const controlRoot = mkdtempSync(join(tmpdir(), "grande-host-verifier-soak-control-"));
  const priorControl = process.env.GRANDE_CONTROL;
  const sentinelName = "GRANDE_SOAK_SECRET_SENTINEL";
  const priorSentinel = process.env[sentinelName];
  const sentinel = `grande-soak-secret-${randomUUID()}`;
  let db: ReturnType<typeof openDb> | undefined;
  try {
    process.env.GRANDE_CONTROL = controlRoot;
    const layout = loadLayout();
    ensureLayout(layout);
    saveRegistry(layout, [{ repoId: "grande-gpt", path: join(layout.workspaceRoot, "grande-gpt"), registered: true }]);
    copyTrustedSoakDepDirs(trustedControlLayout, layout, "grande-gpt");
    db = openDb(layout);
    const taskId = `${SOAK_TASK_PREFIX}_${process.pid}`;
    createTask(db, {
      taskId,
      repoId: "grande-gpt",
      branch,
      baseCommit: input.commit,
      worktreePath: taskWorktree,
      state: "READY",
    });
    process.env[sentinelName] = sentinel;

    const runtime = createProductionHostVerification(
      { db, layout },
      { mode: "auto", concurrency: 1 },
      { readPrHead: async (request) => request.commit },
    );
    if (runtime.hostVerificationMode !== "auto" || !runtime.hostVerifierCoordinator) {
      throw new Error("production auto verifier coordinator was not constructed for soak");
    }

    return await runSequentialHostVerifierSoak({
      db,
      coordinator: runtime.hostVerifierCoordinator,
      request: { taskId, repoId: "grande-gpt", commit: input.commit, level: SOAK_LEVEL },
      runs: ACTIVATION_SOAK_RUNS,
      sentinel,
      probeGateway: probeProductionGateway,
    });
  } finally {
    db?.close();
    if (priorControl === undefined) delete process.env.GRANDE_CONTROL;
    else process.env.GRANDE_CONTROL = priorControl;
    if (priorSentinel === undefined) delete process.env[sentinelName];
    else process.env[sentinelName] = priorSentinel;
    rmSync(controlRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runActivationHostVerifierSoak(args);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
