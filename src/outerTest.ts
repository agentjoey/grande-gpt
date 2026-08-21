import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { StateError } from "./errors.ts";
import { GitExecError, safeGit } from "./gitExec.ts";
import {
  hostFilesForLevel,
  LEGACY_HOST_ADAPTERS,
  planHostVerification,
  TRUSTED_HOST_MANIFEST,
  validateHostCoverage,
  type HostVerificationPlan,
} from "./hostVerification.ts";
import type { Layout } from "./layout.ts";
import { getProfile, ProfileError } from "./profiles.ts";
import { getTask, type TaskRow } from "./tasks.ts";

/**
 * Transitional manual host-test planner.
 *
 * The trusted control-plane `unit-selfhost` profile still excludes five legacy files.
 * Those exclusions remain a drift anchor until the Owner changes trusted configuration,
 * but the executable host suite is now selected from the running Gateway manifest rather
 * than directly from candidate/profile argv.
 */

export interface OuterTestPlan {
  /** Trusted host-suite files selected by the running Gateway manifest. */
  files: string[];
  /** Capability reason for every selected host file. */
  reasons: Map<string, string>;
  /** Profile used only to verify the current transition boundary. */
  fromProfile: string;
  /** Legacy exclusions observed in the trusted unit-selfhost profile. */
  unitSelfhostExcluded: string[];
}

export interface TaskHostVerificationPlan extends HostVerificationPlan {
  changedFiles: string[];
  head: string;
}

export function resolveOuterTestCwd(
  db: DatabaseSync,
  layout: Layout,
  repoId: string,
  taskId?: string,
): string {
  if (taskId === undefined) return join(layout.workspaceRoot, repoId);
  const task = getTask(db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  if (task.repoId !== repoId) {
    throw new StateError(
      "INVALID_INPUT",
      `任务 ${taskId} 属于仓库 ${task.repoId}，不能用于验收仓库 ${repoId}。`,
    );
  }
  return task.worktreePath;
}

function gitDetail(error: unknown): string {
  if (error instanceof GitExecError) return error.message.replace(/^git failed:\s*/u, "");
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the trusted changed-file verification plan for one committed task HEAD.
 * The caller may bind an expected PR SHA; any HEAD/base drift fails closed before a
 * verifier can be scheduled or a receipt can be reused.
 */
export function planTaskHostVerification(task: TaskRow, expectedHead?: string): TaskHostVerificationPlan {
  let head: string;
  let changedRaw: string;
  try {
    head = safeGit.local(task.worktreePath, ["rev-parse", "HEAD"]).trim();
    if (expectedHead !== undefined && head !== expectedHead) {
      throw new StateError(
        "STALE_STATE",
        `host verification task HEAD=${head} 与期望 PR head=${expectedHead} 不一致。`,
      );
    }
    changedRaw = safeGit.local(task.worktreePath, [
      "diff", "--name-only", "--diff-filter=ACDMRTUXB", `${task.baseCommit}..${head}`, "--",
    ]);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError(
      "STALE_STATE",
      `无法从 task base/head 计算 host verification plan：${gitDetail(error)}`,
    );
  }
  const changedFiles = changedRaw.split("\n").map((line) => line.trim()).filter(Boolean);
  return { ...planHostVerification(changedFiles), changedFiles, head };
}

function readTestExclusions(layout: Layout, repoId: string, profileName: string): string[] {
  const profile = getProfile(layout, repoId, profileName);
  const files: string[] = [];
  for (let i = 0; i < profile.argv.length - 1; i++) {
    if (profile.argv[i] !== "--exclude") continue;
    const pattern = profile.argv[i + 1]!;
    if (pattern.startsWith("tests/")) files.push(pattern);
  }
  if (files.length === 0) {
    throw new ProfileError(
      "PROFILE_NOT_FOUND",
      `${profileName} profile exclude set 没有 tests/ 排除项；trusted host-suite 迁移状态无法证明，拒绝猜测。`,
    );
  }
  return files;
}

/**
 * Plan the current full manual host suite.
 *
 * Candidate content never chooses the host files. The profile exclusions are checked only
 * to prove the still-deployed manual transition has not silently drifted. Once trusted
 * control-plane configuration is explicitly migrated, this compatibility check can be
 * removed in the activation slice together with its tests.
 */
export function planOuterTest(layout: Layout, repoId: string, profileName = "unit-selfhost"): OuterTestPlan {
  const unitSelfhostExcluded = readTestExclusions(layout, repoId, profileName);
  const expectedLegacy = Object.keys(LEGACY_HOST_ADAPTERS).sort();
  const observed = [...new Set(unitSelfhostExcluded)].sort();
  if (observed.length !== expectedLegacy.length || observed.some((file, index) => file !== expectedLegacy[index])) {
    throw new ProfileError(
      "PROFILE_NOT_FOUND",
      `${profileName} profile exclude set 与已批准的 host-suite transition 不一致；检测到 profile drift，拒绝继续。`,
    );
  }

  validateHostCoverage({
    allProjectTests: TRUSTED_HOST_MANIFEST.map((entry) => entry.file),
    unitSelfhostExcluded,
  });

  const files = hostFilesForLevel("full");
  const reasons = new Map(
    TRUSTED_HOST_MANIFEST
      .filter((entry) => files.includes(entry.file))
      .map((entry) => [entry.file, entry.reason] as const),
  );
  return { files, reasons, fromProfile: profileName, unitSelfhostExcluded };
}
