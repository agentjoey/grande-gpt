import { execFileSync, type ChildProcess } from "node:child_process";

export type TerminationReason = "timeout" | "rss" | "cancel";
export interface SupervisedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  killedBy: TerminationReason | null;
  killSignalSkipped: boolean;
  durationMs: number;
  peakRssMb: number;
}
export interface ProcessSupervisionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  maxRssMb?: number;
  signal?: AbortSignal;
  onSpawn?: (pgid: number) => void;
  /** Internal deterministic timing seam; never a public/profile cancellation input. */
  killGraceMs?: number;
  extinctionGraceMs?: number;
}

export class ProcessSupervisionError extends Error {
  readonly safeToFinalize: boolean;
  constructor(message: string, safeToFinalize: boolean) {
    super(message);
    this.name = "ProcessSupervisionError";
    this.safeToFinalize = safeToFinalize;
  }
}

function groupState(pgid: number): "gone" | "present" | "unknown" {
  if (!Number.isInteger(pgid) || pgid <= 0) return "gone";
  try { process.kill(-pgid, 0); return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
}

function groupRss(pgid: number): number {
  if (pgid <= 0) return 0;
  try {
    const output = execFileSync("/bin/ps", ["-o", "rss=", "-g", String(pgid)], {
      encoding: "utf8", timeout: 1000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    return Math.round(output.split("\n").reduce((total, line) => total + (Number(line.trim()) || 0), 0) / 1024);
  } catch { return 0; }
}

/**
 * Supervise only a child object just spawned by a trusted adapter. Cancellation cannot
 * supply argv, a pid or a signal. Timers/listeners are removed before final settlement.
 * Once the leader has exited, do not signal an integer that could have been reused;
 * require group extinction or report uncertainty and retain the caller's reservation.
 */
export function superviseOwnedProcess(child: ChildProcess, options: ProcessSupervisionOptions): Promise<SupervisedProcessResult> {
  const startedAt = Date.now();
  const pgid = child.pid ?? 0;
  const killGraceMs = options.killGraceMs ?? 5000;
  const extinctionGraceMs = options.extinctionGraceMs ?? 2000;
  return new Promise((resolve, reject) => {
    let finished = false;
    let closed = false;
    let exited = false;
    let exitCode: number | null = null;
    let failure: unknown;
    let killedBy: TerminationReason | null = null;
    let stopping = false;
    let killSignalSkipped = false;
    let bytes = 0;
    let truncated = false;
    let peakRssMb = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timeout: NodeJS.Timeout | undefined;
    let rssPoll: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    let extinctionPoll: NodeJS.Timeout | undefined;
    let uncertaintyDeadline: NodeJS.Timeout | undefined;

    const leaderIsOwned = () => pgid > 0 && !exited && child.exitCode == null && child.signalCode == null;
    const collect = (chunk: Buffer | string, target: Buffer[]) => {
      if (finished || truncated) return;
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = options.maxOutputBytes - bytes;
      if (remaining <= 0) { truncated = true; return; }
      const slice = input.subarray(0, remaining);
      bytes += slice.byteLength;
      target.push(slice);
      if (bytes >= options.maxOutputBytes) truncated = true;
    };
    const collectOut = (chunk: Buffer | string) => collect(chunk, stdout);
    const collectErr = (chunk: Buffer | string) => collect(chunk, stderr);
    const dispose = () => {
      for (const timer of [timeout, rssPoll, hardKill, extinctionPoll, uncertaintyDeadline]) {
        if (timer) clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout?.removeListener("data", collectOut);
      child.stderr?.removeListener("data", collectErr);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    const finish = (uncertain = false) => {
      if (finished) return;
      finished = true;
      dispose();
      if (uncertain) {
        reject(new ProcessSupervisionError("process-group extinction is unproven; keep the job reservation and inspect ownership", false));
      } else if (failure) {
        reject(new ProcessSupervisionError(failure instanceof Error ? failure.message : String(failure), true));
      } else {
        resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
          truncated, killedBy, killSignalSkipped, durationMs: Date.now() - startedAt, peakRssMb });
      }
    };
    const inspectExtinction = () => {
      if (!finished && closed && groupState(pgid) === "gone") finish();
    };
    const waitForExtinction = (deadlineMs: number) => {
      if (finished) return;
      if (!extinctionPoll) extinctionPoll = setInterval(inspectExtinction, 25);
      if (!uncertaintyDeadline) uncertaintyDeadline = setTimeout(() => {
        inspectExtinction();
        if (!finished) finish(true);
      }, deadlineMs);
      inspectExtinction();
    };
    const signalGroup = (signal: "SIGTERM" | "SIGKILL") => {
      if (!leaderIsOwned()) { killSignalSkipped = true; return; }
      try { process.kill(-pgid, signal); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error;
      }
    };
    const stop = (reason: TerminationReason | null) => {
      if (finished || stopping) return;
      stopping = true;
      killedBy = reason;
      signalGroup("SIGTERM");
      hardKill = setTimeout(() => {
        if (!finished) signalGroup("SIGKILL");
      }, killGraceMs);
      waitForExtinction(killGraceMs + extinctionGraceMs);
    };
    function onAbort() { stop("cancel"); }
    function onExit(code: number | null) { exited = true; exitCode = code; }
    function onClose(code: number | null) {
      exited = true; closed = true; exitCode = code;
      if (timeout) clearTimeout(timeout);
      if (rssPoll) clearInterval(rssPoll);
      // No delayed kill may outlive the owned leader or a completed process group.
      if (hardKill) clearTimeout(hardKill);
      waitForExtinction(extinctionGraceMs);
    }
    function onError(error: Error) { failure = error; }
    child.stdout?.on("data", collectOut);
    child.stderr?.on("data", collectErr);
    child.once("exit", onExit);
    child.once("close", onClose);
    child.once("error", onError);
    timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    rssPoll = setInterval(() => {
      if (finished || exited) return;
      const rss = groupRss(pgid);
      peakRssMb = Math.max(peakRssMb, rss);
      if (options.maxRssMb !== undefined && rss > options.maxRssMb) stop("rss");
    }, 2000);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (pgid > 0) options.onSpawn?.(pgid);
    } catch (error) {
      failure = error;
      stop(null);
    }
    if (options.signal?.aborted) onAbort();
  });
}
