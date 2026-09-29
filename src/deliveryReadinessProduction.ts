import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getLatestActivationReceipt } from "./activationReceipt.ts";
import { getAttestations } from "./attestation.ts";
import { loadDeploymentSpec } from "./deployment.ts";
import { canonicalRepoPath, computeExpectedMergeTree } from "./deliveryMerge.ts";
import type { DeliveryReadinessDeps } from "./deliveryReadiness.ts";
import { StateError } from "./errors.ts";
import { createGithubApi } from "./githubApi.ts";
import { loadGithubToken } from "./githubAuth.ts";
import { safeGit } from "./gitExec.ts";
import type { Layout } from "./layout.ts";
import { readDeliveryHostVerification } from "./prHostVerification.ts";
import { parseGithubRemote, readGithubRemoteUrl } from "./prOpen.ts";
import { trustedDeploymentProfileEvidence } from "./profiles.ts";
import { summarizeCi } from "./prLifecycle.ts";
import { getTask, type TaskRow } from "./tasks.ts";
import { gatewayBuildIdentity } from "./toolsetIdentity.ts";

interface ProductionDeliveryReadinessContext {
  db: DatabaseSync;
  layout: Layout;
}

function taskOrThrow(db: DatabaseSync, taskId: string): TaskRow {
  const task = getTask(db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  return task;
}

function localGit(worktreePath: string, args: string[]): string {
  try {
    return safeGit.local(worktreePath, args).trim();
  } catch (error) {
    throw new StateError(
      "GIT_FAILED",
      `git ${args[0] ?? "命令"} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function githubContext(
  deps: ProductionDeliveryReadinessContext,
  taskId: string,
) {
  const task = taskOrThrow(deps.db, taskId);
  const token = loadGithubToken(deps.layout).token;
  const remote = readGithubRemoteUrl(task.worktreePath, token);
  const { owner, repo } = parseGithubRemote(remote);
  const api = createGithubApi(token);
  return { task, api, owner, repo };
}

/**
 * Production wiring for Minimal V2 delivery readiness.
 *
 * Every reader is anchored in trusted Gateway state (SQLite/control plane/local Git/GitHub
 * readback). Repo content may select an already-approved deploy/verify profile, but cannot
 * provide argv, runtime identity, policy identity, or arbitrary target labels.
 */
export function createProductionDeliveryReadiness(
  deps: ProductionDeliveryReadinessContext,
): DeliveryReadinessDeps {
  return {
    readPullRequest: async (taskId) => {
      const { task, api, owner, repo } = await githubContext(deps, taskId);
      const found = await api.findPullRequest(owner, repo, task.branch, "all");
      if (!found) {
        throw new StateError(
          "INVALID_INPUT",
          `任务 ${taskId} 的分支 ${task.branch} 没有对应 GitHub PR；无法建立 delivery binding。`,
        );
      }
      const pr = await api.getPullRequest(owner, repo, found.number);
      if (pr.headRef !== task.branch) {
        throw new StateError(
          "STALE_STATE",
          `PR #${pr.number} head branch=${pr.headRef} 与 task.branch=${task.branch} 不一致。`,
        );
      }
      if (!pr.baseSha) {
        throw new StateError("INVALID_INPUT", `PR #${pr.number} 缺少 exact base SHA；fail closed。`);
      }
      return {
        number: pr.number,
        baseRef: pr.baseRef,
        baseSha: pr.baseSha,
        headSha: pr.headSha,
        state: pr.state,
      };
    },

    readRequiredCi: async (taskId, headSha) => {
      const { api, owner, repo } = await githubContext(deps, taskId);
      const [checks, statuses] = await Promise.all([
        api.listCheckRuns(owner, repo, headSha),
        api.listCommitStatuses(owner, repo, headSha),
      ]);
      const state = summarizeCi(checks, statuses).state;
      if (state === "failed") return "failed";
      if (state === "pending") return "pending";
      // Preserve the existing merge contract: CI=none remains allowed when the exact
      // attestation and Host verification gates are satisfied.
      return "success";
    },

    readAttestation: (taskId, headSha) => {
      const row = getAttestations(deps.db, taskId)
        .find((candidate) => candidate.commit === headSha && candidate.exitCode === 0);
      return row ? { commit: row.commit, jobId: row.jobId } : null;
    },

    readHostVerification: (taskId, headSha) =>
      readDeliveryHostVerification(deps.db, taskOrThrow(deps.db, taskId), headSha),

    computeExpectedMergeTree: (repoId, baseSha, headSha) =>
      computeExpectedMergeTree(canonicalRepoPath(deps.layout, repoId), baseSha, headSha),

    resolveDeployAction: (taskId) => {
      const task = taskOrThrow(deps.db, taskId);
      const spec = loadDeploymentSpec(task.worktreePath);
      if (spec.deploy.kind !== "profile" || spec.verify.kind !== "profile") {
        throw new StateError(
          "POLICY_DENIED",
          "production delivery readiness 尚未接入 capability 的 exact trusted policy digest；fail closed。",
        );
      }

      const evidence = trustedDeploymentProfileEvidence(deps.layout, task.repoId, [
        { role: "deploy", profile: spec.deploy.profile },
        { role: "verify", profile: spec.verify.profile },
      ]);
      for (const record of evidence.records) {
        if (record.profile.execution !== "deployment-host") {
          throw new StateError(
            "POLICY_DENIED",
            `V2 ${record.role} profile ${task.repoId}/${record.profile.name} 必须 execution: deployment-host。`,
          );
        }
      }

      return {
        deployTarget: `deployment-host:${task.repoId}/${spec.deploy.profile}`,
        deployRef: `profile:${spec.deploy.profile}`,
        verifyRef: `profile:${spec.verify.profile}`,
        deploySpecDigest: evidence.digest,
        policyDigest: evidence.digest,
      };
    },

    readWorktreeState: (taskId) => {
      const task = taskOrThrow(deps.db, taskId);
      return {
        headSha: localGit(task.worktreePath, ["rev-parse", "HEAD"]),
        clean: localGit(task.worktreePath, ["status", "--porcelain"]) === "",
        realpath: realpathSync(task.worktreePath),
      };
    },

    readRuntimeIdentity: () => {
      const receipt = getLatestActivationReceipt(deps.db);
      const currentBuild = gatewayBuildIdentity();
      if (!receipt) {
        throw new StateError(
          "POLICY_DENIED",
          "Gateway 缺少 production activation receipt；无法给 delivery authorization 绑定可信 runtime identity。",
        );
      }
      if (receipt.runtimeBuild !== currentBuild) {
        throw new StateError(
          "STALE_STATE",
          `Gateway activation receipt runtimeBuild=${receipt.runtimeBuild} 与当前 build=${currentBuild} 不一致。`,
        );
      }
      return {
        runtimeBuild: receipt.runtimeBuild,
        toolsetEpoch: receipt.toolsetEpoch,
        toolsDigest: receipt.toolsDigest,
      };
    },
  };
}
