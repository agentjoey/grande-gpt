import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface CanonicalGitState {
  repository: boolean;
  headExists: boolean;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  busy: boolean;
  busyReasons: string[];
  inspectionError: string | null;
  ready: boolean;
}

interface GitProbe {
  ok: boolean;
  value: string;
  status: number | null;
  detail: string;
}

function probeGit(repoRoot: string, args: string[]): GitProbe {
  try {
    return {
      ok: true,
      value: execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
      status: 0,
      detail: "",
    };
  } catch (error) {
    const err = error as { status?: unknown; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      value: "",
      status: typeof err.status === "number" ? err.status : null,
      detail: err.stderr ? String(err.stderr).trim() : (err.message ?? `git ${args[0]} failed`),
    };
  }
}

/**
 * Canonical checkout 能否作为 GrandeGPT task/worktree 的基线。
 *
 * 这是只读 projection：不 fetch、不 checkout、不创建 branch/worktree。onboarding、doctor
 * 与 openWorktree 共用这一份事实来源，避免 repo add 报 READY 后 task_open 立刻因为
 * detached/rebase/index.lock 等同一状态报 CANONICAL_BUSY。
 */
export function inspectCanonicalGitState(repoRoot: string): CanonicalGitState {
  const inside = probeGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.value !== "true") {
    return {
      repository: false,
      headExists: false,
      headSha: null,
      branch: null,
      detached: false,
      busy: false,
      busyReasons: [],
      inspectionError: null,
      ready: false,
    };
  }

  const head = probeGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  const headSha = head.ok && head.value.length > 0 ? head.value : null;
  const branchProbe = probeGit(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const branch = branchProbe.ok && branchProbe.value.length > 0 ? branchProbe.value : null;
  const detached = headSha !== null && !branchProbe.ok && branchProbe.status === 1;
  let inspectionError = !branchProbe.ok && branchProbe.status !== 1
    ? `git symbolic-ref 失败：${branchProbe.detail}`
    : null;

  const gitDirProbe = probeGit(repoRoot, ["rev-parse", "--git-dir"]);
  if (!gitDirProbe.ok && inspectionError === null) {
    inspectionError = `git rev-parse --git-dir 失败：${gitDirProbe.detail}`;
  }
  const gitDir = gitDirProbe.ok
    ? (isAbsolute(gitDirProbe.value) ? gitDirProbe.value : resolve(repoRoot, gitDirProbe.value))
    : join(repoRoot, ".git");
  const busyReasons = [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer",
    "index.lock",
  ]
    .filter((marker) => existsSync(join(gitDir, marker)));
  const busy = busyReasons.length > 0;

  return {
    repository: true,
    headExists: headSha !== null,
    headSha,
    branch,
    detached,
    busy,
    busyReasons,
    inspectionError,
    ready: headSha !== null && !detached && !busy && inspectionError === null,
  };
}
