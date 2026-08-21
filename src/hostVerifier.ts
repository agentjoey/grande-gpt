import { basename, isAbsolute, sep } from "node:path";
import {
  hostFilesForLevel,
  type RunnableHostVerificationLevel,
} from "./hostVerification.ts";
import { HOST_VERIFIER_POLICY_VERSION } from "./hostVerifierSandbox.ts";
import {
  computeOuterTestPlanDigest,
  type HostVerifierResourceLimits,
} from "./outerTestReceipt.ts";

export interface HostVerifierRequest {
  taskId: string;
  repoId: string;
  commit: string;
  level: RunnableHostVerificationLevel;
}

export interface HostVerifierStaticPlan {
  level: RunnableHostVerificationLevel;
  files: string[];
  policyVersion: number;
  resourceLimits: HostVerifierResourceLimits;
  staticPlanDigest: string;
}

export const HOST_VERIFIER_RESOURCE_LIMITS: Readonly<HostVerifierResourceLimits> = Object.freeze({
  wallTimeoutMs: 120_000,
  maxRssMb: 1536,
  maxOutputBytes: 256 * 1024,
});

export function buildHostVerifierStaticPlan(level: RunnableHostVerificationLevel): HostVerifierStaticPlan {
  const files = hostFilesForLevel(level, "auto").sort();
  if (files.length === 0) throw new Error(`no trusted auto host files for ${level}`);
  const resourceLimits = { ...HOST_VERIFIER_RESOURCE_LIMITS };
  return {
    level,
    files,
    policyVersion: HOST_VERIFIER_POLICY_VERSION,
    resourceLimits,
    staticPlanDigest: computeOuterTestPlanDigest({
      level,
      files,
      policyVersion: HOST_VERIFIER_POLICY_VERSION,
      resourceLimits,
      loopbackPorts: [],
    }),
  };
}

/**
 * Generate a minimal trusted Vitest config. The selected files come from the
 * running Gateway manifest; candidate vitest config/plugins are never imported.
 */
export function buildTrustedVitestConfig(files: readonly string[]): string {
  if (files.length === 0 || files.some((file) => !/^tests\/host\/[^/]+\.host\.test\.ts$/u.test(file))) {
    throw new Error("trusted host verifier files must be manifest host tests");
  }
  return [
    "export default {",
    `  test: { include: ${JSON.stringify([...files].sort())}, environment: "node", watch: false, pool: "threads", maxWorkers: 1, minWorkers: 1, fileParallelism: false },`,
    "};",
    "",
  ].join("\n");
}

function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function overlaps(a: string, b: string): boolean {
  return isUnder(a, b) || isUnder(b, a);
}

/**
 * Cleanup receives only a verifier-owned temporary root. This guard makes the
 * real task/workspace/control trees structurally impossible cleanup targets.
 */
export function assertDisposableVerifierRoot(
  root: string,
  bounds: { workspaceRoot: string; controlRoot: string; taskWorktree: string },
): void {
  if (!isAbsolute(root)) throw new Error("disposable verifier root must be absolute");
  for (const [label, path] of [
    ["workspace", bounds.workspaceRoot],
    ["control", bounds.controlRoot],
    ["task", bounds.taskWorktree],
  ] as const) {
    if (overlaps(root, path)) throw new Error(`disposable verifier root overlaps ${label} path`);
  }
  if (!basename(root).startsWith("grande-host-verifier-")) {
    throw new Error("disposable verifier root must use the trusted grande-host-verifier-* prefix");
  }
}

export interface HostVerifierLaunchResult {
  jobId: string;
  settled: Promise<void>;
}

export interface HostVerifierDispatch {
  state: "running" | "busy";
  jobId: string;
  coalesced: boolean;
  staticPlanDigest: string;
}

type HostVerifierLauncher = (
  request: HostVerifierRequest,
  plan: HostVerifierStaticPlan,
) => HostVerifierLaunchResult;

interface ActiveVerifier {
  key: string;
  jobId: string;
  staticPlanDigest: string;
}

function requestKey(request: HostVerifierRequest, plan: HostVerifierStaticPlan): string {
  return [request.taskId, request.repoId, request.commit, request.level, plan.staticPlanDigest].join("\0");
}

/**
 * Pure in-process coordinator: exactly one verifier globally. Identical requests
 * coalesce; a different tuple observes the existing verifier as busy instead of
 * creating a second process. D1 later adds restart reconciliation for persisted jobs.
 */
export class HostVerifierCoordinator {
  private active: ActiveVerifier | null = null;
  private readonly launch: HostVerifierLauncher;

  constructor(launch: HostVerifierLauncher) {
    this.launch = launch;
  }

  start(request: HostVerifierRequest): HostVerifierDispatch {
    if (!/^[0-9a-f]{40}$/u.test(request.commit)) throw new Error("verifier commit must be an exact 40-hex SHA");
    if (!request.taskId || !request.repoId) throw new Error("verifier task/repo binding required");
    const plan = buildHostVerifierStaticPlan(request.level);
    const key = requestKey(request, plan);
    if (this.active) {
      if (this.active.key === key) {
        return {
          state: "running",
          jobId: this.active.jobId,
          coalesced: true,
          staticPlanDigest: this.active.staticPlanDigest,
        };
      }
      return {
        state: "busy",
        jobId: this.active.jobId,
        coalesced: false,
        staticPlanDigest: plan.staticPlanDigest,
      };
    }

    const started = this.launch(request, plan);
    this.active = { key, jobId: started.jobId, staticPlanDigest: plan.staticPlanDigest };
    const clear = () => {
      if (this.active?.jobId === started.jobId) this.active = null;
    };
    void started.settled.then(clear, clear);
    return {
      state: "running",
      jobId: started.jobId,
      coalesced: false,
      staticPlanDigest: plan.staticPlanDigest,
    };
  }
}
