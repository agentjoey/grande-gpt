import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StateError } from "./errors.ts";
import { GitExecError, safeGit } from "./gitExec.ts";
import type { Layout } from "./layout.ts";
import { GitError } from "./worktree.ts";

export interface HostToolchain {
  node: string;
  pnpm: string;
  lockfileSha256: string;
}

export interface VerificationContext {
  workspaceDigest: string;
  hostToolchain: HostToolchain;
}

export interface AttestationRow {
  attestationId: string;
  taskId: string;
  commit: string;
  profile: string;
  jobId: string;
  exitCode: number;
  startedAt: number;
  endedAt: number;
  hostToolchain: HostToolchain;
}

export interface AttestationCandidate {
  attestationId: string;
  taskId: string;
  profile: string;
  jobId: string;
  exitCode: number;
  startedAt: number;
  endedAt: number;
  hostToolchain: HostToolchain;
  workspaceDigest: string;
}

export type CandidateResult =
  | { issued: true; candidate: AttestationCandidate }
  | { issued: false; reason: string };

function gitDetail(error: unknown): string {
  if (error instanceof GitExecError) return error.message.replace(/^git failed:\s*/u, "");
  return error instanceof Error ? error.message : String(error);
}

/** 所有本模块 git 调用都无条件禁用 hooks，并且只用 argv 数组。 */
function git(cwd: string, args: string[]): string {
  try {
    return safeGit.local(cwd, args);
  } catch (error) {
    throw new GitError("GIT_FAILED", `git ${args[0] ?? "命令"} 失败：${gitDetail(error)}`);
  }
}

function gitDiff(cwd: string, args: string[]): string {
  try {
    return safeGit.diff(cwd, args);
  } catch (error) {
    throw new GitError("GIT_FAILED", `git diff 失败：${gitDetail(error)}`);
  }
}

/**
 * 判据：把当前 `HEAD` SHA、`git diff HEAD`（已跟踪文件的内容/模式/删除）与全部未跟踪、
 * 未忽略文件的路径和真实字节一起做 sha256。run 启动前记录这个摘要；commit/attest 前
 * 重新计算。两者相等，才认为「当前 base commit + 将要提交的工作区内容」与那次本机验证
 * 看到的内容一致。HEAD 必须入摘要，否则所有 clean worktree 都会得到同一个 digest，旧
 * clean HEAD 的验证就可能错误地给后来的 clean HEAD 背书。
 */
export function workspaceDigest(worktreePath: string): string {
  const hash = createHash("sha256");
  const head = git(worktreePath, ["rev-parse", "HEAD"]).trim();
  hash.update("head\0", "utf8");
  hash.update(head, "utf8");
  hash.update("\0", "utf8");

  const tracked = gitDiff(worktreePath, ["diff", "--binary", "HEAD", "--"]);
  hash.update("tracked\0", "utf8");
  hash.update(tracked, "utf8");

  const untracked = git(worktreePath, ["ls-files", "-z", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const relative of untracked) {
    const absolute = join(worktreePath, relative);
    const stat = lstatSync(absolute);
    hash.update("untracked\0", "utf8");
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0", "utf8");
      hash.update(readlinkSync(absolute), "utf8");
    } else {
      hash.update("file\0", "utf8");
      hash.update(readFileSync(absolute));
    }
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function hostToolchain(worktreePath: string): HostToolchain {
  const lockfile = readFileSync(join(worktreePath, "pnpm-lock.yaml"));
  const pnpm = execFileSync("pnpm", ["--version"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!process.version || !pnpm) {
    throw new StateError("INVALID_INPUT", "无法记录本机验证工具链：node 或 pnpm 版本为空。 ");
  }
  return {
    node: process.version,
    pnpm,
    lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
  };
}

export function captureVerificationContext(layout: Layout, worktreePath: string): VerificationContext {
  void layout;
  return {
    workspaceDigest: workspaceDigest(worktreePath),
    hostToolchain: hostToolchain(worktreePath),
  };
}

export function recordRunVerificationContext(
  db: DatabaseSync,
  jobId: string,
  context: VerificationContext,
): void {
  const result = db.prepare(
    "UPDATE job SET workspaceDigest=?, hostToolchain=? WHERE jobId=?",
  ).run(context.workspaceDigest, JSON.stringify(context.hostToolchain), jobId);
  if (result.changes === 0) throw new StateError("JOB_NOT_FOUND", `job ${jobId} 不存在。`);
}

function parseToolchain(value: unknown): HostToolchain {
  if (typeof value !== "string" || value.length === 0) {
    throw new StateError("INVALID_INPUT", "本机验证记录缺少 hostToolchain，不能签发 attestation。 ");
  }
  const parsed = JSON.parse(value) as Partial<HostToolchain>;
  if (!parsed.node || !parsed.pnpm || !parsed.lockfileSha256 ||
      parsed.node === "unknown" || parsed.pnpm === "unknown" || parsed.lockfileSha256 === "unknown") {
    throw new StateError("INVALID_INPUT", "本机验证记录的 hostToolchain 不完整，不能签发 attestation。 ");
  }
  return parsed as HostToolchain;
}

export function prepareAttestationCandidate(
  db: DatabaseSync,
  taskId: string,
  currentWorkspaceDigest: string,
): CandidateResult {
  const matching = db.prepare(
    `SELECT jobId,taskId,profile,exitCode,startedAt,endedAt,hostToolchain,workspaceDigest
       FROM job
      WHERE taskId=? AND state='passed' AND exitCode=0 AND workspaceDigest=?
      ORDER BY startedAt DESC, rowid DESC LIMIT 1`,
  ).get(taskId, currentWorkspaceDigest) as Record<string, unknown> | undefined;

  if (!matching) {
    const latestPassed = db.prepare(
      `SELECT workspaceDigest FROM job
        WHERE taskId=? AND state='passed' AND exitCode=0 AND workspaceDigest IS NOT NULL
        ORDER BY startedAt DESC, rowid DESC LIMIT 1`,
    ).get(taskId) as { workspaceDigest?: string } | undefined;
    return {
      issued: false,
      reason: latestPassed
        ? "run 与 commit 之间工作区发生变化：当前工作区摘要与最近通过的本机验证记录不一致，因此不签发 attestation。"
        : "当前工作区状态没有对应的通过验证记录，因此不签发 attestation。",
    };
  }

  const endedAt = matching.endedAt as number | null;
  if (endedAt === null) {
    return { issued: false, reason: "验证 job 尚未结束，不能签发 attestation。" };
  }
  return {
    issued: true,
    candidate: {
      attestationId: `att_${randomUUID()}`,
      taskId,
      profile: matching.profile as string,
      jobId: matching.jobId as string,
      exitCode: matching.exitCode as number,
      startedAt: matching.startedAt as number,
      endedAt,
      hostToolchain: parseToolchain(matching.hostToolchain),
      workspaceDigest: matching.workspaceDigest as string,
    },
  };
}

export function issueAttestation(
  db: DatabaseSync,
  candidate: AttestationCandidate,
  commit: string,
): AttestationRow {
  db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    candidate.attestationId,
    candidate.taskId,
    commit,
    candidate.profile,
    candidate.jobId,
    candidate.exitCode,
    candidate.startedAt,
    candidate.endedAt,
    JSON.stringify(candidate.hostToolchain),
  );
  return {
    attestationId: candidate.attestationId,
    taskId: candidate.taskId,
    commit,
    profile: candidate.profile,
    jobId: candidate.jobId,
    exitCode: candidate.exitCode,
    startedAt: candidate.startedAt,
    endedAt: candidate.endedAt,
    hostToolchain: candidate.hostToolchain,
  };
}

export function getAttestations(db: DatabaseSync, taskId?: string): AttestationRow[] {
  const rows = taskId
    ? db.prepare("SELECT * FROM attestation WHERE taskId=? ORDER BY endedAt DESC, rowid DESC").all(taskId)
    : db.prepare("SELECT * FROM attestation ORDER BY endedAt DESC, rowid DESC").all();
  return rows.map((row) => {
    const value = row as Record<string, unknown>;
    return {
      attestationId: value.attestationId as string,
      taskId: value.taskId as string,
      commit: value.commit as string,
      profile: value.profile as string,
      jobId: value.jobId as string,
      exitCode: value.exitCode as number,
      startedAt: value.startedAt as number,
      endedAt: value.endedAt as number,
      hostToolchain: parseToolchain(value.hostToolchain),
    };
  });
}
