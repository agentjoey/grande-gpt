import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Layout } from "./layout.ts";
import { createJob, finishJob, type JobState } from "./jobs.ts";
import { assertTaskId, resolveRepoPath } from "./paths.ts";
import { getDeploymentProfile } from "./profiles.ts";
import { registeredIds } from "./registry.ts";
import { defaultExecRoots } from "./sandbox.ts";

export class DeploymentHostRunnerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `DeploymentHostRunnerError [${code}]`;
    this.code = code;
  }
}

export interface DeploymentHostRunnerDeps {
  db: DatabaseSync;
  layout: Layout;
}

export interface StartedDeploymentHostJob {
  jobId: string;
  state: "running";
  pollAfterSeconds: number;
}

interface HostRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  killedBy: null | "timeout" | "rss";
  durationMs: number;
  peakRssMb: number;
}

const RSS_POLL_MS = 2000;
const inFlight = new Map<string, Promise<void>>();

function pollHint(timeoutSeconds: number): number {
  return Math.min(20, Math.max(3, Math.round(timeoutSeconds / 10)));
}

function groupRssMb(pgid: number): number {
  if (!pgid) return 0;
  try {
    const out = execFileSync("/bin/ps", ["-o", "rss=", "-g", String(pgid)], { encoding: "utf8" });
    const kb = out.split("\n").reduce((sum, line) => sum + (Number(line.trim()) || 0), 0);
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

function safeWrite(path: string, body: string): void {
  try {
    writeFileSync(path, body, "utf8");
  } catch (error) {
    console.error(`[deployment-host-runner] 写 artifact 失败 ${path}：${(error as Error).message}`);
  }
}

function safeFinish(
  db: DatabaseSync,
  jobId: string,
  result: {
    state: Exclude<JobState, "running">;
    exitCode: number | null;
    artifactPath: string | null;
    summary: Record<string, unknown> | null;
  },
): void {
  try {
    finishJob(db, jobId, result);
  } catch (error) {
    console.error(`[deployment-host-runner] ${jobId} 收尾失败：${(error as Error).message}`);
  }
}

async function runHostProcess(options: {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  maxRssMb: number;
  onSpawn: (pgid: number) => void;
}): Promise<HostRunResult> {
  const startedAt = Date.now();
  const [command, ...args] = options.argv;
  if (!command) throw new DeploymentHostRunnerError("INVALID_INPUT", "deployment-host profile argv 不能为空。");

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pgid = child.pid ?? 0;
  if (pgid) options.onSpawn(pgid);

  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let truncated = false;
  let killedBy: HostRunResult["killedBy"] = null;
  let peakRssMb = 0;

  const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
    if (truncated) return;
    const remaining = options.maxOutputBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const slice = chunk.subarray(0, remaining);
    bytes += slice.byteLength;
    if (target === "stdout") stdout += slice.toString("utf8");
    else stderr += slice.toString("utf8");
    if (bytes >= options.maxOutputBytes) truncated = true;
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));

  const killGroup = (reason: NonNullable<HostRunResult["killedBy"]>) => {
    if (killedBy) return;
    killedBy = reason;
    if (!pgid) return;
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      return;
    }
    setTimeout(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already exited
      }
    }, 5000).unref();
  };

  const timeout = setTimeout(() => killGroup("timeout"), options.timeoutMs);
  const rssPoller = setInterval(() => {
    const current = groupRssMb(pgid);
    if (current > peakRssMb) peakRssMb = current;
    if (current > options.maxRssMb) killGroup("rss");
  }, RSS_POLL_MS);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  clearTimeout(timeout);
  clearInterval(rssPoller);

  return {
    exitCode,
    stdout,
    stderr,
    truncated,
    killedBy,
    durationMs: Date.now() - startedAt,
    peakRssMb,
  };
}

/**
 * Start a control-plane-authorized deployment profile directly on the trusted host.
 * This function is intentionally not exposed as an MCP tool. The only production caller is
 * deployment.ts after it has checked the deploy/verify role and merged deployment receipt.
 */
export function startDeploymentHostJob(
  deps: DeploymentHostRunnerDeps,
  args: { taskId: string; repoId: string; profileName: string },
): StartedDeploymentHostJob {
  assertTaskId(args.taskId);
  const profile = getDeploymentProfile(deps.layout, args.repoId, args.profileName);
  if (profile.execution !== "deployment-host") {
    throw new DeploymentHostRunnerError(
      "POLICY_DENIED",
      `profile ${args.repoId}/${args.profileName} 未由控制面授权 execution: deployment-host。`,
    );
  }

  const canonicalRepo = realpathSync(
    resolveRepoPath(deps.layout, args.repoId, registeredIds(deps.layout)),
  );
  const jobId = `job_${randomUUID()}`;
  const artifactDir = join(deps.layout.artifactsDir, args.taskId, jobId);
  const artifactPath = join(artifactDir, "output.log");
  mkdirSync(artifactDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    PATH: defaultExecRoots().join(":"),
    HOME: process.env.HOME ?? dirname(deps.layout.controlRoot),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    GRANDE_WORKSPACE: deps.layout.workspaceRoot,
    GRANDE_CONTROL: deps.layout.controlRoot,
  };

  let pgid: number | null = null;
  const run = runHostProcess({
    argv: profile.argv,
    cwd: canonicalRepo,
    env,
    timeoutMs: profile.timeoutSeconds * 1000,
    maxOutputBytes: profile.maxOutputBytes,
    maxRssMb: profile.maxRssMb,
    onSpawn: (pid) => { pgid = pid; },
  });

  const settled = run
    .then((result) => {
      safeWrite(artifactPath, `${result.stdout}\n--- stderr ---\n${result.stderr}\n`);
      const state: Exclude<JobState, "running"> =
        result.killedBy === "timeout" ? "timeout"
        : result.killedBy === "rss" ? "killed"
        : result.exitCode === 0 ? "passed"
        : "failed";
      safeFinish(deps.db, jobId, {
        state,
        exitCode: result.exitCode,
        artifactPath,
        summary: {
          execution: "deployment-host",
          truncated: result.truncated,
          killedBy: result.killedBy,
          durationMs: result.durationMs,
          peakRssMb: result.peakRssMb,
        },
      });
    })
    .catch((error: unknown) => {
      safeWrite(artifactPath, `deployment-host runner 内部错误：${(error as Error).message}\n`);
      safeFinish(deps.db, jobId, {
        state: "killed",
        exitCode: null,
        artifactPath,
        summary: { execution: "deployment-host", error: (error as Error).message },
      });
    })
    .finally(() => {
      inFlight.delete(jobId);
    });

  try {
    createJob(deps.db, {
      jobId,
      taskId: args.taskId,
      profile: profile.name,
      argv: [...profile.argv],
      pgid,
    });
  } catch (error) {
    if (pgid) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already exited
      }
    }
    void settled;
    throw error;
  }

  inFlight.set(jobId, settled);
  return { jobId, state: "running", pollAfterSeconds: pollHint(profile.timeoutSeconds) };
}

export function awaitDeploymentHostJobSettled(jobId: string): Promise<void> {
  return inFlight.get(jobId) ?? Promise.resolve();
}

export async function awaitAllDeploymentHostJobsSettled(timeoutMs: number): Promise<number> {
  const pending = [...inFlight.values()];
  if (pending.length === 0) return 0;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled(pending), deadline]);
  if (timer) clearTimeout(timer);
  return pending.length;
}
