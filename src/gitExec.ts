import { execFileSync } from "node:child_process";
import { basicCredential, redactToken } from "./githubAuth.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MIN_CAPTURE_BUFFER = 64 * 1024;

export interface SafeGitOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  input?: string;
  expectedBranch?: string;
  expectedHead?: string;
}

export class GitExecError extends Error {
  readonly code: "GIT_FAILED" | "STALE_STATE";
  readonly status: number | null;

  constructor(code: "GIT_FAILED" | "STALE_STATE", message: string, status: number | null = null) {
    super(message);
    this.name = `GitExecError [${code}]`;
    this.code = code;
    this.status = status;
  }
}

interface RunOptions extends SafeGitOptions {
  token?: string;
  env?: NodeJS.ProcessEnv;
  allowExitOneWithStdout?: boolean;
}

function boundedPositive(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function redactDetail(detail: string, cwd: string, token?: string): string {
  let safe = detail.replaceAll(cwd, "<repo>");
  if (token) safe = redactToken(safe, token);
  return safe;
}

function safeEnvForGithub(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of [
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GIT_TRACE",
    "GIT_TRACE2",
    "GIT_TRACE2_EVENT",
    "GIT_TRACE_CURL",
    "GIT_TRACE_CURL_NO_DATA",
    "GIT_TRACE_PACKET",
    "GIT_CURL_VERBOSE",
  ]) {
    delete env[key];
  }
  return env;
}

function runGit(cwd: string, argv: string[], options: RunOptions = {}): string {
  const timeout = boundedPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxOutputBytes = boundedPositive(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  const maxBuffer = Math.max(MIN_CAPTURE_BUFFER, Math.min(MAX_OUTPUT_BYTES, maxOutputBytes * 4));
  try {
    const stdout = execFileSync("git", argv, {
      cwd,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input: options.input,
      env: options.env ?? process.env,
      timeout,
      killSignal: "SIGKILL",
      maxBuffer,
    });
    return truncateUtf8(stdout, maxOutputBytes);
  } catch (error) {
    const e = error as {
      status?: unknown;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
      code?: string;
    };
    const status = typeof e.status === "number" ? e.status : null;
    const stdout = e.stdout === undefined ? "" : String(e.stdout);
    if (options.allowExitOneWithStdout && status === 1 && stdout.length > 0) {
      return truncateUtf8(stdout, maxOutputBytes);
    }
    const raw = e.stderr !== undefined && String(e.stderr).trim().length > 0
      ? String(e.stderr).trim()
      : stdout.trim().length > 0
        ? stdout.trim()
        : (e.message ?? e.code ?? "git failed");
    const detail = truncateUtf8(redactDetail(raw, cwd, options.token), maxOutputBytes);
    throw new GitExecError("GIT_FAILED", `git failed: ${detail}`, status);
  }
}

function localArgv(args: readonly string[]): string[] {
  return ["-c", "core.hooksPath=/dev/null", ...args];
}

function assertExpectedState(cwd: string, options: SafeGitOptions): void {
  if (options.expectedBranch !== undefined) {
    let actual: string;
    try {
      actual = runGit(cwd, localArgv(["symbolic-ref", "-q", "--short", "HEAD"]), {
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      }).trim();
    } catch {
      throw new GitExecError("STALE_STATE", `git branch check failed; expected ${options.expectedBranch}.`);
    }
    if (actual !== options.expectedBranch) {
      throw new GitExecError(
        "STALE_STATE",
        `git branch mismatch: expected ${options.expectedBranch}, actual ${actual}.`,
      );
    }
  }
  if (options.expectedHead !== undefined) {
    const actual = runGit(cwd, localArgv(["rev-parse", "HEAD"]), {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    }).trim();
    if (actual !== options.expectedHead) {
      throw new GitExecError("STALE_STATE", `git HEAD mismatch: expected ${options.expectedHead}, actual ${actual}.`);
    }
  }
}

function local(cwd: string, args: readonly string[], options: SafeGitOptions = {}): string {
  assertExpectedState(cwd, options);
  return runGit(cwd, localArgv(args), options);
}

function github(cwd: string, args: readonly string[], token: string, options: SafeGitOptions = {}): string {
  assertExpectedState(cwd, options);
  const argv = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", `http.extraHeader=Authorization: Basic ${basicCredential(token)}`,
    ...args,
  ];
  return runGit(cwd, argv, { ...options, token, env: safeEnvForGithub() });
}

function diff(cwd: string, args: readonly string[], options: SafeGitOptions = {}): string {
  if (args[0] !== "diff") {
    throw new GitExecError("GIT_FAILED", "safeGit.diff only accepts the git diff subcommand.");
  }
  const argv = localArgv(["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)]);
  return runGit(cwd, argv, {
    ...options,
    allowExitOneWithStdout: args.includes("--no-index"),
  });
}

function tryRelation(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    runGit(cwd, localArgv(["merge-base", "--is-ancestor", ancestor, descendant]));
    return true;
  } catch (error) {
    if (error instanceof GitExecError && error.status === 1) return false;
    throw error;
  }
}

export const safeGit = { local, github, diff, tryRelation } as const;
