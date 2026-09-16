import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getLatestActivationReceipt,
  recordActivationReceipt,
  type ActivationEvidence,
} from "../src/activationReceipt.ts";
import { getAttestations } from "../src/attestation.ts";
import { openDb } from "../src/db.ts";
import {
  approveAuthorization,
  beginAuthorizedExecution,
  rotateAuthorizationChallenge,
} from "../src/deliveryAuthorization.ts";
import {
  computeExpectedMergeTree,
  ensurePinnedReleaseSource,
  persistExactMergeReceipt,
  readExactMergeReceipt,
  verifyMergedCommit,
} from "../src/deliveryMerge.ts";
import {
  prepareDeliveryAuthorization,
  type DeliveryReadinessDeps,
} from "../src/deliveryReadiness.ts";
import { projectDeliveryTargetProgress } from "../src/deliveryTarget.ts";
import { buildHostVerifierStaticPlan } from "../src/hostVerifier.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { persistTrustedOuterTestPassV2 } from "../src/outerTestReceipt.ts";
import { readDeliveryHostVerification } from "../src/prHostVerification.ts";
import { trustedDeploymentProfileEvidence } from "../src/profiles.ts";
import { saveRegistry } from "../src/registry.ts";
import { getExplicitDeliveryTarget, saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { projectTaskProgress, type TaskProgress } from "../src/taskProgress.ts";
import { createTask, getTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

/**
 * Task 7 RED 切片 1A：minimal V2 delivery 单链路 e2e。
 *
 * task_open(deliveryTarget=deploy) → profile-only verification evidence →
 * READY_FOR_DELIVERY_APPROVAL → Console 同域 approval helper → exact merge
 * （真实 local Git）→ reentrant deploy → verify readback → DELIVERY_DONE。
 *
 * 本切片的 RED 点：repoId=grande-gpt（Gateway 自身）的交付在 DONE 之前必须
 * 存在 durable activation receipt/readback；该 wiring 尚未存在，当前实现会
 * 在没有任何 activation receipt 的情况下照样 DONE——测试必须在
 * 「无 activation receipt 不能 DONE」处失败，而不是因为 fixture 编译/装配错误。
 */

const REPO = "grande-gpt";
const TASK = "task_minimal_v2_e2e";
const BRANCH = "grande/minimal-v2-e2e";
const DEPLOY_PROFILE = "deploy-prod";
const VERIFY_PROFILE = "verify-prod";
const DEPLOY_TARGET = `deployment-host:${REPO}/${DEPLOY_PROFILE}`;
const RUNTIME_BUILD = `git:${"e".repeat(40)}`;
const TOOLS_DIGEST = `sha256:${"c".repeat(64)}`;
const TOOLCHAIN = JSON.stringify({ node: "v24.14.0", pnpm: "10.33.0", lockfileSha256: "c".repeat(64) });

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", "-c", "user.name=GrandeGPT Test", "-c", "user.email=grande-test@example.com", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

let root: string;
let layout: Layout;
let db: DatabaseSync;
let toolDeps: ToolDeps;
let canonical: string;
let worktree: string;
let baseSha: string;
let headSha: string;

const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

function commitWorktree(dir: string, name: string, content: string, message: string): string {
  writeFileSync(join(dir, name), content, "utf8");
  git(dir, "add", name);
  git(dir, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "minimal-v2-e2e-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
  toolDeps = { db, layout, defaultRepoId: REPO };

  // 真实 local Git canonical（grande-gpt）+ registry。
  canonical = join(layout.workspaceRoot, REPO);
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  baseSha = commitWorktree(canonical, "base.txt", "base\n", "base");
  saveRegistry(layout, [{ repoId: REPO, path: canonical, registered: true }]);

  // 任务 worktree：head commit 的改动与 deliveryReadiness.test.ts 的可信 receipt 配方
  // 保持一致（src/feature.ts → host plan level=smoke）。.grande/deploy.yaml 不进入
  // head commit——它会改变 trusted host plan 的 classify 结果；deploy spec 只在
  // readiness 之后被 deployment 工具从 worktree 读取（见测试体）。
  mkdirSync(join(layout.worktreesRoot, REPO), { recursive: true });
  worktree = join(layout.worktreesRoot, REPO, TASK);
  git(canonical, "worktree", "add", "-q", "-b", BRANCH, worktree, baseSha);
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "feature.ts"), "export const x = 1;\n", "utf8");
  git(worktree, "add", "src/feature.ts");
  git(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "feature");
  headSha = git(worktree, "rev-parse", "HEAD");

  // profile-only 可信执行注册：deploy/verify 都只引用 deployment-host profile。
  writeFileSync(join(layout.configDir, "profiles.yaml"), [
    "repos:",
    `  ${REPO}:`,
    `    ${DEPLOY_PROFILE}:`,
    '      argv: ["/usr/bin/true"]',
    "      timeoutSeconds: 60",
    "      execution: deployment-host",
    `    ${VERIFY_PROFILE}:`,
    '      argv: ["/usr/bin/true"]',
    "      timeoutSeconds: 60",
    "      execution: deployment-host",
    "",
  ].join("\n"), "utf8");
});

afterEach(() => {
  db.close();
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = saved.ctrl;
  rmSync(root, { recursive: true, force: true });
});

/** 绑定 headSha 的本机 attestation（profile-only 验证证据之一）。 */
function attest(commit: string): void {
  const jobId = `job_att_${commit.slice(0, 8)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, TASK, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", TOOLCHAIN);
  db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`att_${commit.slice(0, 8)}`, TASK, commit, "unit-selfhost", jobId, 0, now - 10, now, TOOLCHAIN);
}

/** 与 deliveryReadiness.test.ts 相同的可信 V2 host verification receipt 配方。 */
function writeTrustedHostReceipt(): void {
  const plan = buildHostVerifierStaticPlan("smoke");
  const jobId = "job_host_receipt";
  createJob(db, { jobId, taskId: TASK, profile: "host-verifier", argv: ["trusted-host-verifier"], pgid: 9876 });
  finishJob(db, jobId, {
    state: "passed",
    exitCode: 0,
    artifactPath: null,
    summary: {
      kind: "host-verifier-v2",
      mode: "auto",
      repoId: REPO,
      commit: headSha,
      level: "smoke",
      files: plan.files,
      policyVersion: plan.policyVersion,
      resourceLimits: plan.resourceLimits,
      loopbackPorts: [49173],
      hostToolchain: { node: "v24.14.0", pnpm: "10.33.0", lockfileSha256: "c".repeat(64) },
    },
  });
  persistTrustedOuterTestPassV2(db, TASK, jobId);
}

/** readiness deps：能接真实 reader 的接真实 reader（git/SQLite/profiles），网络面（PR/CI）与 d2Deployment.test.ts 一样打桩。 */
function readinessDeps(): DeliveryReadinessDeps {
  return {
    readPullRequest: async () => ({ number: 7, baseRef: "main", baseSha, headSha, state: "open" }),
    readRequiredCi: async () => "success",
    readAttestation: (taskId, head) => {
      const row = getAttestations(db, taskId).find((att) => att.commit === head && att.exitCode === 0);
      return row ? { commit: row.commit, jobId: row.jobId } : null;
    },
    readHostVerification: (taskId, head) => readDeliveryHostVerification(db, getTask(db, taskId)!, head),
    computeExpectedMergeTree: (_repoId, base, head) => computeExpectedMergeTree(canonical, base, head),
    resolveDeployAction: () => {
      const evidence = trustedDeploymentProfileEvidence(layout, REPO, [
        { role: "deploy", profile: DEPLOY_PROFILE },
        { role: "verify", profile: VERIFY_PROFILE },
      ]);
      return {
        deployTarget: DEPLOY_TARGET,
        deployRef: `profile:${DEPLOY_PROFILE}`,
        verifyRef: `profile:${VERIFY_PROFILE}`,
        deploySpecDigest: evidence.digest,
        policyDigest: evidence.digest,
      };
    },
    readWorktreeState: () => ({
      headSha: git(worktree, "rev-parse", "HEAD"),
      clean: git(worktree, "status", "--porcelain") === "",
      realpath: realpathSync(worktree),
    }),
    readRuntimeIdentity: () => ({ runtimeBuild: RUNTIME_BUILD, toolsetEpoch: 2, toolsDigest: TOOLS_DIGEST }),
  };
}

function authStatus(authorizationId: string): string {
  const row = db
    .prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
    .get(authorizationId) as { status: string } | undefined;
  return row?.status ?? "MISSING";
}

function project(): TaskProgress {
  return projectDeliveryTargetProgress(
    projectTaskProgress(db, getTask(db, TASK)!, {
      readHead: () => headSha,
      filesChanged: () => 1,
      workingTreeDirty: () => false,
      worktreeExists: () => true,
      deployConfigured: () => true,
    }),
    "deploy",
    TASK,
  );
}

function activationEvidence(): ActivationEvidence {
  const toolset = { toolsetEpoch: 2, toolsCount: 42, toolsDigest: TOOLS_DIGEST };
  return {
    targetBuild: RUNTIME_BUILD,
    runtimeBuild: RUNTIME_BUILD,
    expectedToolset: toolset,
    runtimeToolset: toolset,
    restart: { launchAgentRunning: true, endpointReady: true },
    readProbe: { ok: true, httpStatus: 200 },
  };
}

describe("minimal V2 delivery e2e（Task 7 RED 切片 1A）", () => {
  it("task_open(deploy) → profile-only evidence → READY → approval → exact merge → reentrant deploy/verify → DELIVERY_DONE；grande-gpt 无 activation receipt 不得 DONE", async () => {
    /* 1. task_open(deliveryTarget=deploy)：显式不可变 target 落库。 */
    createTask(db, {
      taskId: TASK,
      repoId: REPO,
      branch: BRANCH,
      baseCommit: baseSha,
      worktreePath: worktree,
      state: "READY",
    });
    saveExplicitDeliveryTarget(db, TASK, "deploy");
    expect(getExplicitDeliveryTarget(db, TASK)).toBe("deploy");

    /* 2. profile-only verification evidence：attestation + 可信 host receipt 都精确绑定 headSha。 */
    attest(headSha);
    writeTrustedHostReceipt();

    /* 3. exact readiness → READY_FOR_DELIVERY_APPROVAL 投影。 */
    const expectedTree = computeExpectedMergeTree(canonical, baseSha, headSha);
    const prepared = await prepareDeliveryAuthorization(db, TASK, readinessDeps());
    expect(prepared.state).toBe("READY");
    expect(project().deliveryAuthorization).toMatchObject({
      state: "READY_FOR_DELIVERY_APPROVAL",
      authorizationId: prepared.authorizationId,
      bindingDigest: prepared.bindingDigest,
    });

    /* 4. 与 Console 同域的 approval helper：challenge → approve → begin execution。 */
    const { approvalNonce } = rotateAuthorizationChallenge(db, prepared.authorizationId, prepared.bindingDigest);
    approveAuthorization(db, {
      authorizationId: prepared.authorizationId,
      bindingDigest: prepared.bindingDigest,
      approvalNonce,
      identity: { sub: "owner-sub", email: "owner@example.com" },
    });
    const executing = beginAuthorizedExecution(db, prepared.authorizationId, "delivery", prepared.bindingDigest);
    const authorizationId = executing.authorizationId;
    expect(authStatus(authorizationId)).toBe("EXECUTING");

    // profile-only deploy spec：readiness 之后写入 worktree（不进入 head commit，
    // 避免改变 trusted host plan 的 classify）；deployment 工具从 worktree 读取它。
    mkdirSync(join(worktree, ".grande"), { recursive: true });
    writeFileSync(join(worktree, ".grande", "deploy.yaml"), [
      "deploy:",
      `  profile: ${DEPLOY_PROFILE}`,
      "verify:",
      `  profile: ${VERIFY_PROFILE}`,
      "",
    ].join("\n"), "utf8");

    /* 5. exact merge（真实 local Git）：side effect 恰好 1 次，receipt/pinned source 全部精确。 */
    let mergeCalls = 0;
    const mergeStep = (): void => {
      if (readExactMergeReceipt(layout, authorizationId)) return; // 重入只观察 durable receipt
      mergeCalls += 1;
      git(canonical, "merge", "--no-ff", "-q", "-m", "merge minimal v2 e2e", headSha);
      const mergeSha = git(canonical, "rev-parse", "HEAD");
      const receipt = verifyMergedCommit({
        repoPath: canonical,
        authorizationId,
        baseSha,
        headSha,
        mergeSha,
        expectedMergeTree: expectedTree,
      });
      const pinned = ensurePinnedReleaseSource({ layout, repoId: REPO, authorizationId, mergeSha, expectedTree });
      persistExactMergeReceipt(layout, { ...receipt, releaseSourceRealpath: pinned.realpath });
    };
    mergeStep();
    mergeStep(); // 重入：绝不第二个 merge
    expect(mergeCalls).toBe(1);

    const mergeReceipt = readExactMergeReceipt(layout, authorizationId)!;
    const mergeSha = git(canonical, "rev-parse", "HEAD");
    expect(mergeReceipt).toMatchObject({ authorizationId, baseSha, headSha, mergeSha, mergeTree: expectedTree });
    // exact source SHA：pinned release source 钉在 mergeSha。
    expect(git(mergeReceipt.releaseSourceRealpath!, "rev-parse", "HEAD")).toBe(mergeSha);

    /* 6. reentrant deploy：side effect 恰好 1 次。 */
    const EVIDENCE = {
      target: DEPLOY_TARGET,
      deploymentId: "dep-minimal-v2",
      sourceSha: mergeSha,
      artifactDigest: `sha256:${"5".repeat(64)}`,
    };
    const hostStarts: string[] = [];
    // 经真实 buildTools 组装（Task 7 的 activation 门禁在组装层）；只透传既有
    // startHostProfile 测试 seam，public schema/digest 不受 options 影响。
    const tools = buildTools(toolDeps, {
      deployment: {
        startHostProfile: ({ profileName }) => {
          hostStarts.push(profileName);
          const jobId = `job_${profileName}_${hostStarts.length}`;
          createJob(db, { jobId, taskId: TASK, profile: profileName, argv: [], pgid: null });
          return { jobId, state: "running" as const, pollAfterSeconds: 3 };
        },
      },
    });
    const call = async (name: string) =>
      (await tools.find((tool) => tool.name === name)!.handler({ taskId: TASK }))
        .structuredContent as Record<string, any>;

    const deploying = await call("grande_deploy");
    expect(deploying.ok).toBe(true);
    expect(deploying.data).toMatchObject({ state: "deploying", authorizationId });
    const deployAgain = await call("grande_deploy");
    expect(deployAgain.data.existing).toBe(true);
    expect(hostStarts).toEqual([DEPLOY_PROFILE]); // deploy side effect 1 次

    /* 7. verify readback：观察 durable job 证据，身份四字段精确匹配。 */
    finishJob(db, deploying.data.jobId, {
      state: "passed",
      exitCode: 0,
      artifactPath: null,
      summary: { execution: "deployment-host", evidence: EVIDENCE },
    });
    const verifying = await call("grande_deploy_verify");
    expect(verifying.ok).toBe(true);
    expect(verifying.data.state).toBe("verifying");
    expect(hostStarts).toEqual([DEPLOY_PROFILE, VERIFY_PROFILE]);
    finishJob(db, verifying.data.jobId, {
      state: "passed",
      exitCode: 0,
      artifactPath: null,
      summary: { execution: "deployment-host", evidence: EVIDENCE },
    });

    /* 8. RED 点：repoId=grande-gpt 的 DONE 必须要求 durable activation receipt/readback。
       当前没有任何 activation receipt——正确实现必须 fail closed（不 DONE、authorization
       保持 EXECUTING、verify 证据不落账）；wiring 缺失时此处即本切片要观察的 RED。 */
    expect(getLatestActivationReceipt(db)).toBeNull();
    const doneWithoutActivation = await call("grande_deploy_verify");
    expect(doneWithoutActivation.ok).toBe(false);
    expect(authStatus(authorizationId)).toBe("EXECUTING");

    /* 9. 补齐 activation receipt/readback 后，同一条 authorization 走到 DONE。 */
    recordActivationReceipt(db, activationEvidence());
    const done = await call("grande_deploy_verify");
    expect(done.ok).toBe(true);
    expect(done.data.state).toBe("DONE");
    expect(authStatus(authorizationId)).toBe("SUCCEEDED");
    expect(hostStarts).toEqual([DEPLOY_PROFILE, VERIFY_PROFILE]); // 全程 deploy/verify side effect 各 1 次

    /* 10. receipt recovery 稳定：重入只观察 durable receipt，零新 side effect。 */
    const doneAgain = await call("grande_deploy_verify");
    expect(doneAgain.ok).toBe(true);
    expect(doneAgain.data).toMatchObject({ state: "DONE", existing: true });
    expect(hostStarts).toEqual([DEPLOY_PROFILE, VERIFY_PROFILE]);

    /* 11. DELIVERY_DONE 投影携带 exact source SHA 与部署身份。 */
    expect(project().deliveryAuthorization).toEqual({
      state: "DELIVERY_DONE",
      authorizationId,
      sourceSha: mergeSha,
      target: DEPLOY_TARGET,
      deploymentId: "dep-minimal-v2",
    });
  });
});
