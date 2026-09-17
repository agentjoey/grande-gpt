import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDisposableVerifierRoot, type HostVerifierLaunchResult, type HostVerifierRequest, type HostVerifierStaticPlan } from "./hostVerifier.ts";
import type { HostVerifierExecutionResult, HostVerifierPreparedRun, HostVerifierRuntimeAdapter, HostVerifierRuntimeDeps } from "./hostVerifierRuntime.ts";
import { finishJob, getJob, setRunningJobPgid, setRunningJobSummary, TERMINAL, type JobState } from "./jobs.ts";
import { persistTrustedOuterTestPassV2, type TrustedHostVerifierSummary } from "./outerTestReceipt.ts";
import { markManagedJobLaunching, reserveManagedJob } from "./resourceAdmission.ts";
import { trackJobSettlement } from "./runner.ts";
import { getTask } from "./tasks.ts";

export interface HostVerifierLauncherOptions {
  receiptMode?: "auto" | "manual";
  requirePrHead?: boolean;
}

function executionState(result: HostVerifierExecutionResult): Exclude<JobState, "running"> {
  if (result.killedBy === "timeout") return "timeout";
  if (result.killedBy === "rss") return "killed";
  return result.exitCode === 0 ? "passed" : "failed";
}

function failureSummary(request: HostVerifierRequest, prepared: HostVerifierPreparedRun | undefined, detail: Record<string, unknown>): Record<string, unknown> {
  return { kind: "host-verifier-failure", repoId: request.repoId, commit: request.commit,
    level: request.level, disposableRoot: prepared?.disposableRoot ?? null, ...detail };
}

function trustedSummary(request: HostVerifierRequest, plan: HostVerifierStaticPlan, prepared: HostVerifierPreparedRun, mode: "auto" | "manual"): TrustedHostVerifierSummary {
  return { kind: "host-verifier-v2", mode, repoId: request.repoId, commit: request.commit,
    level: request.level, files: [...plan.files], policyVersion: plan.policyVersion,
    resourceLimits: { ...plan.resourceLimits }, loopbackPorts: [...prepared.loopbackPorts],
    hostToolchain: { ...prepared.hostToolchain } };
}

/** One trusted launcher, shared by manual/automatic entrypoints. Admission precedes all preparation. */
export function createHostVerifierLauncher(
  deps: HostVerifierRuntimeDeps,
  adapter: HostVerifierRuntimeAdapter,
  options: HostVerifierLauncherOptions = {},
): (request: HostVerifierRequest, plan: HostVerifierStaticPlan) => HostVerifierLaunchResult {
  const receiptMode = options.receiptMode ?? "auto";
  const requirePrHead = options.requirePrHead ?? true;
  return (request, plan) => {
    if (request.repoId !== "grande-gpt") throw new Error(`host verifier is scoped to grande-gpt, received repo ${request.repoId}`);
    if (!/^[0-9a-f]{40}$/u.test(request.commit)) throw new Error("host verifier requires an exact 40-hex commit");
    const task = getTask(deps.db, request.taskId);
    if (!task) throw new Error(`host verifier task does not exist: ${request.taskId}`);
    if (task.repoId !== request.repoId) throw new Error("host verifier task/repo binding mismatch");

    const jobId = `job_${randomUUID()}`;
    reserveManagedJob(deps.db, deps.layout, { jobId, taskId: request.taskId, profile: "host-verifier",
      argv: ["trusted-host-verifier", request.level, request.commit], kind: "host-verifier" }, [tmpdir()]);
    let disposableRoot: string | undefined;
    const artifactDir = join(deps.layout.artifactsDir, request.taskId, jobId);
    const artifactPath = join(artifactDir, "output.log");
    try {
      disposableRoot = realpathSync(mkdtempSync(join(tmpdir(), "grande-host-verifier-")));
      assertDisposableVerifierRoot(disposableRoot, { workspaceRoot: deps.layout.workspaceRoot,
        controlRoot: deps.layout.controlRoot, taskWorktree: task.worktreePath });
      setRunningJobSummary(deps.db, jobId, { kind: "host-verifier-preparing", repoId: request.repoId,
        commit: request.commit, level: request.level, receiptMode,
        staticPlanDigest: plan.staticPlanDigest, disposableRoot });
      mkdirSync(artifactDir, { recursive: true });
      markManagedJobLaunching(deps.db, jobId);
    } catch (error) {
      if (disposableRoot) rmSync(disposableRoot, { recursive: true, force: true });
      finishJob(deps.db, jobId, { state: "failed", exitCode: null, artifactPath: null,
        summary: failureSummary(request, undefined, { reason: "prepare_failed", failureClass: "infrastructure" }) });
      throw error;
    }
    const root = disposableRoot;
    const settled = (async () => {
      let prepared: HostVerifierPreparedRun | undefined;
      let cleaned = false;
      let result: HostVerifierExecutionResult | undefined;
      let phase: "prepare" | "execute" | "cleanup" | "head_check" = "prepare";
      try {
        prepared = await adapter.prepare({ request, plan, jobId, disposableRoot: root });
        if (prepared.disposableRoot !== root) throw new Error("runtime adapter changed the trusted disposable root");
        assertDisposableVerifierRoot(prepared.disposableRoot, { workspaceRoot: deps.layout.workspaceRoot,
          controlRoot: deps.layout.controlRoot, taskWorktree: task.worktreePath });
        setRunningJobSummary(deps.db, jobId, { kind: "host-verifier-running", repoId: request.repoId,
          commit: request.commit, level: request.level, receiptMode, staticPlanDigest: plan.staticPlanDigest,
          disposableRoot: root, loopbackPorts: [...prepared.loopbackPorts] });
        phase = "execute";
        result = await adapter.execute(prepared, (pgid) => {
          if (!setRunningJobPgid(deps.db, jobId, pgid)) throw new Error("verifier pgid arrived after job stopped or was already attached");
        });
        writeFileSync(artifactPath, `${result.stdout}\n--- stderr ---\n${result.stderr}\n`, "utf8");
        phase = "cleanup";
        await adapter.cleanup(prepared);
        cleaned = true;
        const state = executionState(result);
        if (state !== "passed") {
          finishJob(deps.db, jobId, { state, exitCode: result.exitCode, artifactPath,
            summary: failureSummary(request, prepared, {
              failureClass: state === "failed" ? "candidate" : "infrastructure",
              reason: state === "failed" ? "test_failed" : result.killedBy === "timeout" ? "timeout" : "rss_limit",
              testFailure: state === "failed", infrastructureFailure: state !== "failed",
              killedBy: result.killedBy, truncated: result.truncated, durationMs: result.durationMs,
              peakRssMb: result.peakRssMb, cleaned: true,
            }) });
          return;
        }
        phase = "head_check";
        const heads = await adapter.readCurrentHeads(request);
        const exactHeadStillCurrent = heads.taskHead === request.commit && (!requirePrHead || heads.prHead === request.commit);
        const baseSummary = trustedSummary(request, plan, prepared, receiptMode);
        const summary = exactHeadStillCurrent ? baseSummary : { ...baseSummary, kind: "host-verifier-v2-stale",
          staleReason: requirePrHead ? "task-or-pr-sha-drift" : "task-sha-drift",
          observedTaskHead: heads.taskHead, observedPrHead: heads.prHead };
        finishJob(deps.db, jobId, { state: "passed", exitCode: 0, artifactPath, summary });
        if (exactHeadStillCurrent) persistTrustedOuterTestPassV2(deps.db, request.taskId, jobId);
      } catch (error) {
        if (prepared && !cleaned) {
          try { await adapter.cleanup(prepared); cleaned = true; } catch { cleaned = false; }
        } else if (!prepared) {
          try { rmSync(root, { recursive: true, force: true }); cleaned = true; } catch { cleaned = false; }
        }
        const current = getJob(deps.db, jobId);
        if (current && !TERMINAL.has(current.state)) {
          try { writeFileSync(artifactPath, `host verifier infrastructure error: ${(error as Error).message}\n`, "utf8"); }
          catch { /* Artifact failure must not leave a settled job forever running. */ }
          finishJob(deps.db, jobId, { state: "failed", exitCode: result?.exitCode ?? null, artifactPath,
            summary: failureSummary(request, prepared, { failureClass: "infrastructure", reason: `${phase}_failed`,
              infrastructureFailure: true, error: error instanceof Error ? error.message : String(error), cleaned }) });
        }
      }
    })();
    trackJobSettlement(jobId, settled);
    return { jobId, settled };
  };
}
