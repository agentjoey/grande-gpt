import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeploymentTools, type DeploymentToolOptions } from "../src/deployment.ts";
import { openDb } from "../src/db.ts";
import type { GithubLifecycleApi, GithubPullRequestDetail } from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createPrMergeTool } from "../src/prLifecycle.ts";
import { wrapPrMergeToolD2 } from "../src/prMergeD2.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask, getTask } from "../src/tasks.ts";
import type { ToolDef, ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

let root: string;
let layout: Layout;
let deps: ToolDeps;
let canonical: string;
let worktree: string;
let baseCommit: string;
let headCommit: string;
const taskId = "task_d2_deploy";
const branch = "grande/d2-deploy";
const token = "github_pat_d2_deploy_abcdefghijklmnopqrstuvwxyz";
const githubUrl = "https://github.com/fake-owner/fake-repo.git";

function stubTool(name: string, handler: ToolDef["handler"]): ToolDef {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler,
  };
}

function writeDeploySpec(): void {
  mkdirSync(join(worktree, ".grande"), { recursive: true });
  writeFileSync(join(worktree, ".grande", "deploy.yaml"), [
    "deploy:",
    "  capability:",
    "    provider: platform",
    "    name: deploy",
    "verify:",
    "  capability:",
    "    provider: platform",
    "    name: verify",
    "",
  ].join("\n"), "utf8");
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
  root = mkdtempSync(join(tmpdir(), "d2-deploy-"));
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

  canonical = join(workspace, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "base");
  baseCommit = git(canonical, "rev-parse", "HEAD");
  saveRegistry(layout, [{ repoId: "demo", path: canonical, registered: true }]);

  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", branch, worktree, baseCommit);
  writeFileSync(join(worktree, "change.txt"), "D2 deploy\n", "utf8");
  git(worktree, "add", "change.txt");
  git(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "D2 deploy change");
  headCommit = git(worktree, "rev-parse", "HEAD");
  git(canonical, "remote", "add", "origin", githubUrl);

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

describe("D2 deployment response-loss and merge cleanup compatibility", () => {
  it("persists an uncertain capability-deploy intent before invocation and never blindly invokes it twice", async () => {
    writeDeploySpec();
    let invokes = 0;
    const capabilityTools: ToolDef[] = [
      stubTool("grande_capability_inspect", async (args) => ({
        structuredContent: {
          ok: true,
          data: { capability: { provider: args.provider, name: args.name, risk: args.name === "verify" ? "read" : "production" } },
        },
      })),
      stubTool("grande_capability_invoke", async () => {
        invokes += 1;
        return { structuredContent: { ok: false, error: { code: "INTERNAL", message: "simulated response loss" } } };
      }),
    ];
    const options: DeploymentToolOptions = { requireMerged: async () => ({ merged: true, mergeSha: "merge1" }) };
    const deploy = createDeploymentTools(deps, capabilityTools, options).find((tool) => tool.name === "grande_deploy")!;

    const first = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(first.ok).toBe(true);
    expect(first.data).toMatchObject({ state: "uncertain", existing: false, retryable: false });
    expect(first.hint).toMatch(/Human|确认|不要.*重试|不可.*重试/i);
    expect(invokes).toBe(1);

    const receipt = deps.db.prepare("SELECT receiptJson FROM deployment_receipt WHERE taskId=?").get(taskId) as { receiptJson: string };
    expect(JSON.parse(receipt.receiptJson)).toMatchObject({ deployUncertain: true, deployComplete: false });

    const second = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(second.ok).toBe(true);
    expect(second.data).toMatchObject({ state: "uncertain", existing: true, retryable: false });
    expect(invokes).toBe(1);
  });

  it("keeps the task worktree after merge when deploy.yaml exists, while still reconciling canonical", async () => {
    writeDeploySpec();
    git(worktree, "add", ".grande/deploy.yaml");
    git(
      worktree,
      "-c", "user.name=GrandeGPT",
      "-c", "user.email=grande@example.com",
      "commit", "-q", "-m", "add deploy spec",
    );
    headCommit = git(worktree, "rev-parse", "HEAD");
    attest(headCommit);
    const pr: GithubPullRequestDetail = {
      number: 61,
      url: "https://github.com/fake-owner/fake-repo/pull/61",
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      headSha: headCommit,
      headRef: branch,
      baseRef: "main",
    };
    const api: GithubLifecycleApi = {
      async findPullRequest() { return { number: pr.number, url: pr.url }; },
      async createPullRequest() { throw new Error("not used"); },
      async getPullRequest() { return pr; },
      async listCheckRuns() { return []; },
      async listCommitStatuses() { return []; },
      async mergePullRequest() { return { merged: true, sha: "merge-sha", message: "merged" }; },
    };
    let refreshCalls = 0;
    const canonicalRefresher = () => {
      refreshCalls += 1;
      return { action: "fast-forward" as const, relation: "remote_ahead" as const, branch: "main", before: baseCommit, after: "merge-sha", remoteHead: "merge-sha" };
    };
    const base = createPrMergeTool(deps, {
      apiFactory: () => api,
      readRemoteUrl: () => githubUrl,
      readLocalHead: () => headCommit,
      canonicalRefresher,
    });
    const tool = wrapPrMergeToolD2(deps, base, { apiFactory: () => api, readRemoteUrl: () => githubUrl, canonicalRefresher });

    const envelope = (await tool.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ merged: true, localState: "deploy-pending", cleanedUp: false });
    expect(refreshCalls).toBe(2);
    expect(existsSync(worktree)).toBe(true);
    expect(getTask(deps.db, taskId)?.state).toBe("READY");
  });
});
