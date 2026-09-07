import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import {
  APPROVAL_TTL_MS,
  approveAuthorization,
  createAuthorization,
  rotateAuthorizationChallenge,
  type DeliveryAuthorizationBinding,
} from "../src/deliveryAuthorization.ts";
import { readExactMergeReceipt } from "../src/deliveryMerge.ts";
import type { DeliveryReadinessDeps } from "../src/deliveryReadiness.ts";
import type {
  GithubCheckRun,
  GithubCommitStatus,
  GithubLifecycleApi,
  GithubPullRequestDetail,
} from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import {
  createPrMergeTool,
  createPrStatusTool,
  summarizeCi,
} from "../src/prLifecycle.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

let root: string;
let layout: Layout;
let deps: ToolDeps;
let worktree: string;
let currentCommit: string;
const taskId = "task_pr_lifecycle";
const branch = "grande/pr-lifecycle";
const token = "github_pat_lifecycle_abcdefghijklmnopqrstuvwxyz";
const githubUrl = "https://github.com/fake-owner/fake-repo.git";

function detail(overrides: Partial<GithubPullRequestDetail> = {}): GithubPullRequestDetail {
  return {
    number: 41,
    url: "https://github.com/fake-owner/fake-repo/pull/41",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    headSha: currentCommit,
    headRef: branch,
    baseRef: "main",
    ...overrides,
  };
}

function fakeApi(options: {
  pr?: GithubPullRequestDetail;
  checks?: GithubCheckRun[];
  statuses?: GithubCommitStatus[];
  mergeResult?: { merged: boolean; sha: string; message: string };
} = {}): GithubLifecycleApi & { mergeCalls: Array<{ number: number; sha: string }> } {
  const mergeCalls: Array<{ number: number; sha: string }> = [];
  const pr = options.pr ?? detail();
  return {
    mergeCalls,
    async findPullRequest() {
      return { number: pr.number, url: pr.url };
    },
    async createPullRequest() {
      throw new Error("not used");
    },
    async getPullRequest() {
      return pr;
    },
    async listCheckRuns() {
      return options.checks ?? [];
    },
    async listCommitStatuses() {
      return options.statuses ?? [];
    },
    async mergePullRequest(_owner, _repo, number, sha) {
      mergeCalls.push({ number, sha });
      return options.mergeResult ?? { merged: true, sha: "merge-sha", message: "merged" };
    },
  };
}

function attest(commit: string): void {
  const jobId = `job_${commit.slice(0, 8)}`;
  const now = Date.now();
  const toolchain = JSON.stringify({ node: "v24.0.0", pnpm: "10.0.0", lockfileSha256: "lock" });
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(jobId, taskId, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", toolchain);
  deps.db.prepare(
    `INSERT INTO attestation
       (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`att_${commit.slice(0, 8)}`, taskId, commit, "unit-selfhost", jobId, 0, now - 10, now, toolchain);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pr-lifecycle-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(join(layout.controlRoot, "secrets", "github-token"), `${token}\n`, { mode: 0o600 });

  // S16 后 merge 会 preflight canonical。旧 S6 夹具原本只建 task worktree，没有
  // canonical repo；补一个无 remote 的本地 canonical，让这些测试仍只关注 PR/CI 门禁。
  // 真正 fetch+ff 行为由 prMergeCanonicalRefresh.test.ts 的 bare-origin 夹具承重。
  const canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "canonical base");
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(worktree, { recursive: true });
  git(worktree, "init", "-q", "-b", branch);
  git(worktree, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "base");
  const baseCommit = git(worktree, "rev-parse", "HEAD").trim();
  writeFileSync(join(worktree, "change.txt"), "phase 4\n", "utf8");
  git(worktree, "add", "change.txt");
  git(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "change");
  currentCommit = git(worktree, "rev-parse", "HEAD").trim();
  git(worktree, "remote", "add", "origin", githubUrl);

  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  createTask(deps.db, {
    taskId,
    repoId: "demo",
    branch,
    baseCommit,
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("summarizeCi", () => {
  it("没有远端 CI 时明确返回 none，而不是伪装 passed", () => {
    expect(summarizeCi([], [])).toMatchObject({ state: "none", failed: [] });
  });

  it("pending 优先于 success；失败 check 输出被收敛成可诊断 logExcerpt", () => {
    const pending = summarizeCi(
      [{ id: 1, name: "unit", status: "in_progress", conclusion: null, detailsUrl: null, output: null }],
      [{ context: "lint", state: "success", description: null, targetUrl: null }],
    );
    expect(pending.state).toBe("pending");

    const failed = summarizeCi(
      [{
        id: 2,
        name: "unit",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://github.com/fake/run/2",
        output: { title: "Tests failed", summary: "2 failed", text: "expected true, received false" },
      }],
      [],
    );
    expect(failed.state).toBe("failed");
    expect(failed.failed[0]).toMatchObject({ name: "unit", conclusion: "failure" });
    expect(failed.failed[0]?.logExcerpt).toContain("expected true");
  });
});

describe("S6 PR lifecycle", () => {
  it("只新增 task-bound pr_status / pr_merge；不接受 repo/prNumber 作为调用参数", () => {
    const tools = buildTools(deps);
    const status = tools.find((tool) => tool.name === "grande_pr_status")!;
    const merge = tools.find((tool) => tool.name === "grande_pr_merge")!;
    expect(status).toBeDefined();
    expect(merge).toBeDefined();
    expect(status.inputSchema.properties).toEqual({ taskId: expect.any(Object) });
    expect(merge.inputSchema.properties).toEqual({ taskId: expect.any(Object) });
    expect(status.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(merge.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("pr_status 绑定 task.branch 与当前 head SHA，返回失败 CI 诊断", async () => {
    const api = fakeApi({
      checks: [{
        id: 9,
        name: "unit",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://github.com/fake/run/9",
        output: { title: "unit", summary: "failed", text: "stack tail" },
      }],
    });
    const tool = createPrStatusTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => currentCommit,
    });
    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.pr).toMatchObject({ number: 41, headRef: branch, headSha: currentCommit });
    expect(envelope.data.headMatchesTask).toBe(true);
    expect(envelope.data.ci.state).toBe("failed");
    expect(envelope.data.ci.failed[0].logExcerpt).toContain("stack tail");
  });

  it("pr_status 在 worktree 分支漂移时于任何 GitHub API 调用前拒绝", async () => {
    git(worktree, "switch", "-q", "-c", "grande/wrong-lifecycle-branch");
    let apiCreated = false;
    const tool = createPrStatusTool(deps, {
      apiFactory: () => {
        apiCreated = true;
        return fakeApi();
      },
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => currentCommit,
    });

    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;

    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toMatch(/grande\/pr-lifecycle|分支|branch/);
    expect(apiCreated).toBe(false);
  });

  it("CI failed/pending 或 PR head 已不是本地当前 HEAD 时 merge 必须拒绝，且不发 merge 请求", async () => {
    attest(currentCommit);
    for (const api of [
      fakeApi({ checks: [{ id: 1, name: "unit", status: "completed", conclusion: "failure", detailsUrl: null, output: null }] }),
      fakeApi({ checks: [{ id: 2, name: "unit", status: "in_progress", conclusion: null, detailsUrl: null, output: null }] }),
      fakeApi({ pr: detail({ headSha: "deadbeef" }), checks: [{ id: 3, name: "unit", status: "completed", conclusion: "success", detailsUrl: null, output: null }] }),
    ]) {
      const tool = createPrMergeTool(deps, {
        apiFactory: () => api,
        readRemoteUrl: () => githubUrl,
        readLocalHead: () => currentCommit,
      });
      const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
      expect(envelope.ok).toBe(false);
      expect(api.mergeCalls).toEqual([]);
    }
  });

  it("CI green 也必须有当前 SHA 的本机 attestation；旧 SHA 的验证不能替新 SHA 背书", async () => {
    attest("1111111111111111111111111111111111111111");
    const api = fakeApi({
      checks: [{ id: 1, name: "unit", status: "completed", conclusion: "success", detailsUrl: null, output: null }],
    });
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => currentCommit,
    });
    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/attestation|验证/i);
    expect(api.mergeCalls).toEqual([]);
  });

  it("CI green + 当前 SHA attestation 时用 expected sha 合并；none CI 也可在 attestation 门禁下合并", async () => {
    attest(currentCommit);
    for (const api of [
      fakeApi({ checks: [{ id: 1, name: "unit", status: "completed", conclusion: "success", detailsUrl: null, output: null }] }),
      fakeApi(),
    ]) {
      const tool = createPrMergeTool(deps, {
        apiFactory: () => api,
        readRemoteUrl: () => githubUrl,
        readLocalHead: () => currentCommit,
      });
      const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toMatchObject({ merged: true, prNumber: 41, headSha: currentCommit });
      expect(api.mergeCalls).toEqual([{ number: 41, sha: currentCommit }]);
      const audit = listAudit(deps.db, taskId).filter((row) => row.tool === "grande_pr_merge").at(-1);
      expect(audit?.decision).toBe("ALLOWED");
      expect(audit?.state).toBe("SUCCEEDED");
    }
  });

  it("draft / mergeable=false / mergeable=null 均不越过 GitHub 合并门槛", async () => {
    attest(currentCommit);
    for (const pr of [
      detail({ draft: true }),
      detail({ mergeable: false }),
      detail({ mergeable: null }),
    ]) {
      const api = fakeApi({ pr });
      const tool = createPrMergeTool(deps, {
        apiFactory: () => api,
        readRemoteUrl: () => githubUrl,
        readLocalHead: () => currentCommit,
      });
      const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
      expect(envelope.ok).toBe(false);
      expect(api.mergeCalls).toEqual([]);
    }
  });
});

/**
 * Minimal V2 Task 5：explicit deploy 任务的 authorization-gated exact merge。
 * 规格 §10.1/§10.2/§14.3：
 * - 没有 APPROVED authorization（或 binding 漂移）→ 零 GitHub 调用；
 * - APPROVED → EXECUTING 的 CAS 必须发生在 merge API 调用之前；
 * - merge 成功后必须验证 parents/tree，并钉住 pinned release source；
 * - 任何 exact 证据检查失败 → authorization 进 UNCERTAIN，无 receipt，不能 deploy。
 */
describe("minimal V2 authorized merge (Task 5)", () => {
  const deployTaskId = "task_pr_deploy";
  const deployBranch = "grande/pr-deploy";
  const SPEC_DIGEST = `sha256:${"a".repeat(64)}`;
  const POLICY_DIGEST = `sha256:${"b".repeat(64)}`;
  const TOOLS_DIGEST = `sha256:${"c".repeat(64)}`;
  const RUNTIME_BUILD = `git:${"e".repeat(40)}`;

  let canonical: string;
  let deployWorktree: string;
  let baseSha: string;
  let headSha: string;
  let expectedTree: string;
  let createdMergeSha: string | null;

  function attestFor(task: string, commit: string): void {
    const jobId = `job_${task}_${commit.slice(0, 8)}`;
    const now = Date.now();
    const toolchain = JSON.stringify({ node: "v24.0.0", pnpm: "10.0.0", lockfileSha256: "lock" });
    deps.db.prepare(
      `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt,workspaceDigest,hostToolchain)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(jobId, task, "unit-selfhost", "[]", "passed", 0, now - 10, now, "digest", toolchain);
    deps.db.prepare(
      `INSERT INTO attestation
         (attestationId,taskId,"commit",profile,jobId,exitCode,startedAt,endedAt,hostToolchain)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(`att_${task}_${commit.slice(0, 8)}`, task, commit, "unit-selfhost", jobId, 0, now - 10, now, toolchain);
  }

  function deployReadinessDeps(overrides: Partial<DeliveryReadinessDeps> = {}): DeliveryReadinessDeps {
    return {
      readPullRequest: async () => ({ number: 41, baseRef: "main", baseSha, headSha, state: "open" }),
      readRequiredCi: async () => "success",
      readAttestation: () => ({ commit: headSha, jobId: "job_att" }),
      readHostVerification: () => ({ commit: headSha, jobId: "job_host", planDigest: `sha256:${"d".repeat(64)}` }),
      computeExpectedMergeTree: () => expectedTree,
      resolveDeployAction: () => ({
        deployTarget: "deployment-host:demo/deploy-prod",
        deployRef: "profile:deploy-prod",
        verifyRef: "profile:verify-prod",
        deploySpecDigest: SPEC_DIGEST,
        policyDigest: POLICY_DIGEST,
      }),
      readWorktreeState: () => ({ headSha, clean: true, realpath: realpathSync(deployWorktree) }),
      readRuntimeIdentity: () => ({ runtimeBuild: RUNTIME_BUILD, toolsetEpoch: 2, toolsDigest: TOOLS_DIGEST }),
      ...overrides,
    };
  }

  function approveDeployAuthorization(): { authorizationId: string; bindingDigest: string } {
    const createdAt = Date.now();
    const binding: DeliveryAuthorizationBinding = {
      authorizationKind: "delivery",
      taskId: deployTaskId,
      repoId: "demo",
      worktreeRealpath: realpathSync(deployWorktree),
      deliveryTarget: "deploy",
      deployTarget: "deployment-host:demo/deploy-prod",
      deploySpecDigest: SPEC_DIGEST,
      policyDigest: POLICY_DIGEST,
      runtimeBuild: RUNTIME_BUILD,
      toolsetEpoch: 2,
      toolsDigest: TOOLS_DIGEST,
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS,
      prNumber: 41,
      baseRef: "main",
      baseSha,
      headSha,
      mergeMethod: "merge",
      expectedMergeTree: expectedTree,
      deployRef: "profile:deploy-prod",
      verifyRef: "profile:verify-prod",
    };
    const row = createAuthorization(deps.db, {
      kind: "delivery",
      taskId: deployTaskId,
      binding,
      stages: { merge: { state: "pending" }, deploy: { state: "pending" }, verify: { state: "pending" } },
    });
    const { approvalNonce } = rotateAuthorizationChallenge(deps.db, row.authorizationId, row.bindingDigest);
    approveAuthorization(deps.db, {
      authorizationId: row.authorizationId,
      bindingDigest: row.bindingDigest,
      approvalNonce,
      identity: { sub: "owner-sub", email: "owner@example.com" },
    });
    return { authorizationId: row.authorizationId, bindingDigest: row.bindingDigest };
  }

  function authStatus(authorizationId: string): string {
    const row = deps.db
      .prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
      .get(authorizationId) as { status: string } | undefined;
    return row?.status ?? "MISSING";
  }

  interface DeployApi extends GithubLifecycleApi {
    mergeCalls: Array<{ number: number; sha: string }>;
    /** merge 调用发生瞬间的 authorization status——CAS-before-call 的承重断言。 */
    statusAtMergeCall: string[];
  }

  function deployApi(options: {
    pr?: GithubPullRequestDetail;
    /** "real"：在 canonical 里真实创建 merge commit；"single-parent"：返回 headSha 冒充 merge；"wrong-tree"：amend 改 tree。 */
    mergeBehavior?: "real" | "single-parent" | "wrong-tree";
  } = {}): DeployApi {
    const mergeCalls: Array<{ number: number; sha: string }> = [];
    const statusAtMergeCall: string[] = [];
    const pr = options.pr ?? detail({ headSha, baseSha, headRef: deployBranch });
    return {
      mergeCalls,
      statusAtMergeCall,
      async findPullRequest() {
        return { number: pr.number, url: pr.url };
      },
      async createPullRequest() {
        throw new Error("not used");
      },
      async getPullRequest() {
        return pr;
      },
      async listCheckRuns() {
        return [{ id: 1, name: "unit", status: "completed", conclusion: "success", detailsUrl: null, output: null }];
      },
      async listCommitStatuses() {
        return [];
      },
      async mergePullRequest(_owner, _repo, number, sha) {
        mergeCalls.push({ number, sha });
        const active = deps.db
          .prepare("SELECT status FROM delivery_authorization WHERE taskId=? ORDER BY createdAt DESC LIMIT 1")
          .get(deployTaskId) as { status: string } | undefined;
        statusAtMergeCall.push(active?.status ?? "MISSING");
        const behavior = options.mergeBehavior ?? "real";
        if (behavior === "single-parent") {
          createdMergeSha = headSha;
          return { merged: true, sha: headSha, message: "merged" };
        }
        git(canonical, "merge", "--no-ff", "-q", "-m", "merge deploy pr", headSha);
        if (behavior === "wrong-tree") {
          writeFileSync(join(canonical, "evil.txt"), "tampered\n", "utf8");
          git(canonical, "add", "evil.txt");
          git(canonical, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "--amend", "-q", "--no-edit");
        }
        createdMergeSha = git(canonical, "rev-parse", "HEAD").trim();
        return { merged: true, sha: createdMergeSha, message: "merged" };
      },
    };
  }

  function deployRefresher(afterOverride?: string) {
    return () => createdMergeSha
      ? {
          action: "fast-forward" as const,
          relation: "remote_ahead" as const,
          branch: "main",
          before: baseSha,
          after: afterOverride ?? createdMergeSha,
          remoteHead: afterOverride ?? createdMergeSha,
        }
      : {
          action: "none" as const,
          relation: "no_remote" as const,
          branch: "main",
          before: baseSha,
          after: baseSha,
          remoteHead: null,
        };
  }

  beforeEach(() => {
    canonical = join(layout.workspaceRoot, "demo");
    baseSha = git(canonical, "rev-parse", "HEAD").trim();
    deployWorktree = join(layout.worktreesRoot, "demo", deployTaskId);
    git(canonical, "worktree", "add", "-q", "-b", deployBranch, deployWorktree, baseSha);
    writeFileSync(join(deployWorktree, "feature.txt"), "deploy me\n", "utf8");
    git(deployWorktree, "add", "feature.txt");
    git(deployWorktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "feature");
    headSha = git(deployWorktree, "rev-parse", "HEAD").trim();
    expectedTree = git(canonical, "merge-tree", "--write-tree", baseSha, headSha).trim();
    createdMergeSha = null;
    createTask(deps.db, {
      taskId: deployTaskId,
      repoId: "demo",
      branch: deployBranch,
      baseCommit: baseSha,
      worktreePath: deployWorktree,
      state: "READY",
    });
    saveExplicitDeliveryTarget(deps.db, deployTaskId, "deploy");
    attestFor(deployTaskId, headSha);
  });

  it("没有 APPROVED authorization → 零 GitHub 调用，直接拒绝", async () => {
    let apiCreated = false;
    const tool = createPrMergeTool(deps, {
      apiFactory: () => {
        apiCreated = true;
        return deployApi();
      },
      readRemoteUrl: () => githubUrl,
      deliveryReadinessDeps: deployReadinessDeps(),
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/authorization|授权/i);
    expect(apiCreated).toBe(false);
  });

  it("未接入可信 readiness reader 时 fail closed，零 GitHub 调用", async () => {
    approveDeployAuthorization();
    let apiCreated = false;
    const tool = createPrMergeTool(deps, {
      apiFactory: () => {
        apiCreated = true;
        return deployApi();
      },
      readRemoteUrl: () => githubUrl,
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(apiCreated).toBe(false);
  });

  it("head 漂移 → revalidate 置 STALE，零 GitHub 调用，零执行", async () => {
    const { authorizationId } = approveDeployAuthorization();
    let apiCreated = false;
    const drifted = deployReadinessDeps({
      readPullRequest: async () => ({ number: 41, baseRef: "main", baseSha, headSha: "1".repeat(40), state: "open" }),
    });
    const tool = createPrMergeTool(deps, {
      apiFactory: () => {
        apiCreated = true;
        return deployApi();
      },
      readRemoteUrl: () => githubUrl,
      deliveryReadinessDeps: drifted,
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(apiCreated).toBe(false);
    expect(authStatus(authorizationId)).toBe("STALE");
  });

  it("base 漂移 → 同样置 STALE，零 GitHub 调用", async () => {
    const { authorizationId } = approveDeployAuthorization();
    let apiCreated = false;
    const drifted = deployReadinessDeps({
      readPullRequest: async () => ({ number: 41, baseRef: "main", baseSha: "2".repeat(40), headSha, state: "open" }),
    });
    const tool = createPrMergeTool(deps, {
      apiFactory: () => {
        apiCreated = true;
        return deployApi();
      },
      readRemoteUrl: () => githubUrl,
      deliveryReadinessDeps: drifted,
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(apiCreated).toBe(false);
    expect(authStatus(authorizationId)).toBe("STALE");
  });

  it("happy path：CAS 在 merge 调用之前；sha=headSha；parents/tree 验证后持久化 receipt 并钉住 release source", async () => {
    const { authorizationId } = approveDeployAuthorization();
    const api = deployApi();
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      canonicalRefresher: deployRefresher(),
      deliveryReadinessDeps: deployReadinessDeps(),
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.merged).toBe(true);
    expect(createdMergeSha).not.toBeNull();
    expect(api.mergeCalls).toEqual([{ number: 41, sha: headSha }]);
    // CAS-before-call：merge API 被调用时 authorization 必须已经是 EXECUTING。
    expect(api.statusAtMergeCall).toEqual(["EXECUTING"]);

    const receipt = envelope.data.mergeReceipt;
    expect(receipt).toMatchObject({
      authorizationId,
      baseSha,
      headSha,
      mergeSha: createdMergeSha,
      mergeTree: expectedTree,
    });
    expect(typeof receipt.releaseSourceRealpath).toBe("string");
    // durable receipt 落盘，pinned source 的 HEAD 钉在 mergeSha。
    expect(readExactMergeReceipt(layout, authorizationId)).toEqual(receipt);
    expect(git(receipt.releaseSourceRealpath, "rev-parse", "HEAD").trim()).toBe(createdMergeSha);
    // merge stage 证据齐全但 deploy 未启动：authorization 仍是 EXECUTING。
    expect(authStatus(authorizationId)).toBe("EXECUTING");
  });

  it("非 merge commit（unexpected parents）→ UNCERTAIN，无 receipt，不能 deploy", async () => {
    const { authorizationId } = approveDeployAuthorization();
    const api = deployApi({ mergeBehavior: "single-parent" });
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      canonicalRefresher: deployRefresher(),
      deliveryReadinessDeps: deployReadinessDeps(),
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/parent|merge/i);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");
    expect(readExactMergeReceipt(layout, authorizationId)).toBeNull();
  });

  it("tree 与 expectedMergeTree 不符 → UNCERTAIN，无 receipt", async () => {
    const { authorizationId } = approveDeployAuthorization();
    const api = deployApi({ mergeBehavior: "wrong-tree" });
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      canonicalRefresher: deployRefresher(),
      deliveryReadinessDeps: deployReadinessDeps(),
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/tree/i);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");
    expect(readExactMergeReceipt(layout, authorizationId)).toBeNull();
  });

  it("canonical refresh 后 HEAD 不等于 returned merge SHA → 拒绝并置 UNCERTAIN", async () => {
    const { authorizationId } = approveDeployAuthorization();
    const api = deployApi();
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      canonicalRefresher: deployRefresher("f".repeat(40)),
      deliveryReadinessDeps: deployReadinessDeps(),
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/canonical|CANONICAL/i);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");
    expect(readExactMergeReceipt(layout, authorizationId)).toBeNull();
  });

  it("PR 已在授权执行链之外被 merged → fail closed，不发第二个 merge", async () => {
    approveDeployAuthorization();
    const api = deployApi({ pr: detail({ headSha, baseSha, headRef: deployBranch, merged: true, state: "closed" }) });
    const tool = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      canonicalRefresher: deployRefresher(),
      deliveryReadinessDeps: deployReadinessDeps(),
    });
    const envelope = (await tool.handler({ taskId: deployTaskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(api.mergeCalls).toEqual([]);
  });
});
