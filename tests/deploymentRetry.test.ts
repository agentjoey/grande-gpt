import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import {
  APPROVAL_TTL_MS,
  approveAuthorization,
  beginAuthorizedExecution,
  createAuthorization,
  rotateAuthorizationChallenge,
  type DeliveryAuthorizationBinding,
} from "../src/deliveryAuthorization.ts";
import { persistExactMergeReceipt } from "../src/deliveryMerge.ts";
import type { DeploymentEvidence } from "../src/deliveryEvidence.ts";
import { createDeploymentTools, type DeploymentToolOptions } from "../src/deployment.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { createTask } from "../src/tasks.ts";
import type { ToolDef, ToolDeps } from "../src/tools.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps;
let worktree: string;
const taskId = "task_deploy_retry";
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

function stubTool(name: string, handler: ToolDef["handler"]): ToolDef {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler,
  };
}

function insertJob(jobId: string, profile: string, state: "running" | "passed" | "failed"): void {
  const now = Date.now();
  deps.db.prepare(
    `INSERT INTO job (jobId,taskId,profile,argv,state,exitCode,startedAt,endedAt)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    jobId,
    taskId,
    profile,
    "[]",
    state,
    state === "running" ? null : state === "passed" ? 0 : 1,
    now,
    state === "running" ? null : now,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-retry-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(join(worktree, ".grande"), { recursive: true });
  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  createTask(deps.db, {
    taskId,
    repoId: "demo",
    branch: "grande/deploy-retry-test",
    baseCommit: "base",
    worktreePath: worktree,
    state: "READY",
  });
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos:\n  demo:\n    deploy:\n      argv: [\"pnpm\",\"run\",\"deploy\"]\n      timeoutSeconds: 600\n    smoke:\n      argv: [\"pnpm\",\"run\",\"smoke\"]\n      timeoutSeconds: 60\n",
    "utf8",
  );
  writeFileSync(
    join(worktree, ".grande", "deploy.yaml"),
    "deploy:\n  profile: deploy\nverify:\n  profile: smoke\n",
    "utf8",
  );
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("failed profile deploy retry", () => {
  function makeDeploy(runCalls: string[]) {
    let seq = 0;
    const runTool = stubTool("grande_run", async (args) => {
      const jobId = `job_retry_${++seq}`;
      runCalls.push(String(args.profile));
      insertJob(jobId, String(args.profile), "running");
      return { structuredContent: { ok: true, data: { jobId, state: "running" } } };
    });
    const options: DeploymentToolOptions = {
      requireMerged: async () => ({ merged: true, mergeSha: "merge1" }),
    };
    return createDeploymentTools(deps, [runTool], options)
      .find((tool) => tool.name === "grande_deploy")!;
  }

  it("restarts a same-spec profile deploy after the recorded deploy job is definitively failed", async () => {
    const runCalls: string[] = [];
    const deploy = makeDeploy(runCalls);

    const first = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(first.ok).toBe(true);
    expect(first.data.state).toBe("deploying");
    const firstJobId = String(first.data.jobId);
    deps.db.prepare("UPDATE job SET state='failed', exitCode=1, endedAt=? WHERE jobId=?")
      .run(Date.now(), firstJobId);

    const retried = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(retried.ok).toBe(true);
    expect(retried.data.state).toBe("deploying");
    expect(retried.data.existing).not.toBe(true);
    expect(retried.data.jobId).not.toBe(firstJobId);
    expect(runCalls).toEqual(["deploy", "deploy"]);
  });

  it("keeps running and passed same-spec profile receipts idempotent instead of duplicating deployment", async () => {
    const runCalls: string[] = [];
    const deploy = makeDeploy(runCalls);

    const first = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    const jobId = String(first.data.jobId);

    const whileRunning = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(whileRunning.data).toMatchObject({ state: "deploying", jobId, existing: true });
    expect(runCalls).toEqual(["deploy"]);

    deps.db.prepare("UPDATE job SET state='passed', exitCode=0, endedAt=? WHERE jobId=?")
      .run(Date.now(), jobId);
    const afterPassed = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(afterPassed.data).toMatchObject({ jobId, existing: true });
    expect(runCalls).toEqual(["deploy"]);
  });
});

describe("V2 profile deploy via deployment-host runner", () => {
  const BASE = "1".repeat(40);
  const HEAD = "2".repeat(40);
  const MERGE = "a".repeat(40);
  const TREE = "3".repeat(40);
  const DIGEST = `sha256:${"c".repeat(64)}`;

  const EVIDENCE: DeploymentEvidence = {
    target: "production",
    deploymentId: "dep-1",
    sourceSha: MERGE,
    artifactDigest: DIGEST,
  };

  function v2Binding(): DeliveryAuthorizationBinding {
    const createdAt = Date.now();
    return {
      authorizationKind: "delivery",
      taskId,
      repoId: "demo",
      worktreeRealpath: worktree,
      deliveryTarget: "deploy",
      deployTarget: "production",
      deploySpecDigest: `sha256:${"0".repeat(64)}`,
      policyDigest: `sha256:${"0".repeat(64)}`,
      runtimeBuild: "test",
      toolsetEpoch: 1,
      toolsDigest: `sha256:${"0".repeat(64)}`,
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS,
      prNumber: 1,
      baseRef: "main",
      baseSha: BASE,
      headSha: HEAD,
      mergeMethod: "merge",
      expectedMergeTree: TREE,
      deployRef: "profile:deploy",
      verifyRef: "profile:smoke",
    };
  }

  function createExecutingAuth(): string {
    const auth = createAuthorization(deps.db, {
      kind: "delivery",
      taskId,
      binding: v2Binding(),
      stages: {},
    });
    const { approvalNonce } = rotateAuthorizationChallenge(deps.db, auth.authorizationId, auth.bindingDigest);
    approveAuthorization(deps.db, {
      authorizationId: auth.authorizationId,
      bindingDigest: auth.bindingDigest,
      approvalNonce,
      identity: { sub: "owner", email: "owner@example.com" },
    });
    return beginAuthorizedExecution(deps.db, auth.authorizationId, "delivery", auth.bindingDigest).authorizationId;
  }

  function authStatus(authorizationId: string): string {
    const row = deps.db
      .prepare("SELECT status FROM delivery_authorization WHERE authorizationId=?")
      .get(authorizationId) as { status: string };
    return row.status;
  }

  function loadStoredReceipt(): Record<string, any> {
    const row = deps.db
      .prepare("SELECT receiptJson FROM deployment_receipt WHERE taskId=?")
      .get(taskId) as { receiptJson: string } | undefined;
    if (!row) throw new Error("no stored deployment receipt");
    return JSON.parse(row.receiptJson);
  }

  function finishJobWithSummary(jobId: string, state: "passed" | "failed", summary?: unknown): void {
    deps.db.prepare("UPDATE job SET state=?, exitCode=?, endedAt=?, summary=? WHERE jobId=?")
      .run(state, state === "passed" ? 0 : 1, Date.now(), summary === undefined ? null : JSON.stringify(summary), jobId);
  }

  function setup(): { authorizationId: string; calls: string[]; tools: ToolDef[] } {
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      "repos:\n  demo:\n    deploy:\n      argv: [\"pnpm\",\"run\",\"deploy\"]\n      timeoutSeconds: 600\n      execution: deployment-host\n" +
      "    smoke:\n      argv: [\"pnpm\",\"run\",\"smoke\"]\n      timeoutSeconds: 60\n      execution: deployment-host\n",
      "utf8",
    );
    writeFileSync(
      join(worktree, ".grande", "deploy.yaml"),
      "deploy:\n  profile: deploy\nverify:\n  profile: smoke\n",
      "utf8",
    );
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const authorizationId = createExecutingAuth();
    persistExactMergeReceipt(layout, {
      authorizationId,
      baseSha: BASE,
      headSha: HEAD,
      mergeSha: MERGE,
      mergeTree: TREE,
      releaseSourceRealpath: join(root, "release-source"),
    });
    const calls: string[] = [];
    let seq = 0;
    const options: DeploymentToolOptions = {
      startHostProfile: (args) => {
        const jobId = `job_v2host_${++seq}`;
        calls.push(args.profileName);
        insertJob(jobId, args.profileName, "running");
        return { jobId, state: "running", pollAfterSeconds: 3 };
      },
    };
    return { authorizationId, calls, tools: createDeploymentTools(deps, [], options) };
  }

  async function callTool(tools: ToolDef[], name: string): Promise<Record<string, any>> {
    const tool = tools.find((candidate) => candidate.name === name)!;
    return (await tool.handler({ taskId })).structuredContent as Record<string, any>;
  }

  it("恰好启动一个 V2 profile deploy job；重入只观察同一 job", async () => {
    const { authorizationId, calls, tools } = setup();

    const first = await callTool(tools, "grande_deploy");
    expect(first.ok).toBe(true);
    expect(first.data.state).toBe("deploying");
    expect(first.data.authorizationId).toBe(authorizationId);
    const jobId = String(first.data.jobId);
    expect(calls).toEqual(["deploy"]);

    const again = await callTool(tools, "grande_deploy");
    expect(again.ok).toBe(true);
    expect(again.data.existing).toBe(true);
    expect(again.data.jobId).toBe(jobId);
    expect(calls).toEqual(["deploy"]);

    const receipt = loadStoredReceipt();
    expect(receipt.authorizationId).toBe(authorizationId);
    expect(receipt.deployJobId).toBe(jobId);
    expect(receipt.merge).toEqual({ baseSha: BASE, headSha: HEAD, mergeSha: MERGE, mergeTree: TREE });
    expect(receipt.stages).toEqual({ deploy: "running", verify: "pending" });
  });

  it("失败的 deploy job 由 verify 观察后置 FAILED，绝不自动重启", async () => {
    const { authorizationId, calls, tools } = setup();
    const first = await callTool(tools, "grande_deploy");
    const jobId = String(first.data.jobId);
    finishJobWithSummary(jobId, "failed");

    const observed = await callTool(tools, "grande_deploy_verify");
    expect(observed.ok).toBe(false);
    expect(authStatus(authorizationId)).toBe("FAILED");
    expect(calls).toEqual(["deploy"]);

    const deployAgain = await callTool(tools, "grande_deploy");
    expect(deployAgain.data.jobId).toBe(jobId);
    const verifyAgain = await callTool(tools, "grande_deploy_verify");
    expect(verifyAgain.ok).toBe(false);
    expect(calls).toEqual(["deploy"]);
    expect(authStatus(authorizationId)).toBe("FAILED");
  });

  it("passed job 的 summary.evidence 通过身份校验后 deploy succeeded；verify job 证据复用同一身份 → DONE", async () => {
    const { authorizationId, calls, tools } = setup();
    const first = await callTool(tools, "grande_deploy");
    finishJobWithSummary(String(first.data.jobId), "passed", { execution: "deployment-host", evidence: EVIDENCE });

    const verifying = await callTool(tools, "grande_deploy_verify");
    expect(verifying.ok).toBe(true);
    expect(verifying.data.state).toBe("verifying");
    expect(calls).toEqual(["deploy", "smoke"]);
    const verifyJobId = String(verifying.data.jobId);

    const receipt = loadStoredReceipt();
    expect(receipt.deployComplete).toBe(true);
    expect(receipt.deployEvidence).toEqual(EVIDENCE);
    expect(receipt.verifyJobId).toBe(verifyJobId);

    // verify job 运行中重入：只观察，不启动第二个 job。
    const stillRunning = await callTool(tools, "grande_deploy_verify");
    expect(stillRunning.data).toMatchObject({ state: "verifying", jobId: verifyJobId });
    expect(calls).toEqual(["deploy", "smoke"]);

    finishJobWithSummary(verifyJobId, "passed", { execution: "deployment-host", evidence: EVIDENCE });
    const done = await callTool(tools, "grande_deploy_verify");
    expect(done.ok).toBe(true);
    expect(done.data.state).toBe("DONE");
    expect(authStatus(authorizationId)).toBe("SUCCEEDED");
    expect(loadStoredReceipt().verifyEvidence).toEqual(EVIDENCE);

    const again = await callTool(tools, "grande_deploy_verify");
    expect(again.data).toMatchObject({ state: "DONE", existing: true });
    expect(calls).toEqual(["deploy", "smoke"]);
  });

  it("passed job 缺证据（summary.evidenceError）→ UNCERTAIN 且绝不重试", async () => {
    const { authorizationId, calls, tools } = setup();
    const first = await callTool(tools, "grande_deploy");
    finishJobWithSummary(String(first.data.jobId), "passed", {
      execution: "deployment-host",
      evidenceError: { code: "EVIDENCE_MISSING", message: "no evidence file" },
    });

    const observed = await callTool(tools, "grande_deploy_verify");
    expect(observed.ok).toBe(true);
    expect(observed.data.state).toBe("uncertain");
    expect(observed.data.retryable).toBe(false);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");
    expect(loadStoredReceipt().stages.deploy).toBe("uncertain");

    const again = await callTool(tools, "grande_deploy_verify");
    expect(again.ok).toBe(false);
    expect(calls).toEqual(["deploy"]);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");
  });

  it("passed job 证据身份不匹配 → FAILED 且绝不重试", async () => {
    const { authorizationId, calls, tools } = setup();
    const first = await callTool(tools, "grande_deploy");
    finishJobWithSummary(String(first.data.jobId), "passed", {
      execution: "deployment-host",
      evidence: { ...EVIDENCE, sourceSha: "b".repeat(40) },
    });

    const observed = await callTool(tools, "grande_deploy_verify");
    expect(observed.ok).toBe(false);
    expect(authStatus(authorizationId)).toBe("FAILED");
    expect(loadStoredReceipt().stages.deploy).toBe("failed");

    const again = await callTool(tools, "grande_deploy_verify");
    expect(again.ok).toBe(false);
    expect(calls).toEqual(["deploy"]);
    expect(authStatus(authorizationId)).toBe("FAILED");
  });

  it("verify job 证据与 deployEvidence 不一致 → FAILED 且绝不重试", async () => {
    const { authorizationId, calls, tools } = setup();
    const first = await callTool(tools, "grande_deploy");
    finishJobWithSummary(String(first.data.jobId), "passed", { execution: "deployment-host", evidence: EVIDENCE });
    const verifying = await callTool(tools, "grande_deploy_verify");
    expect(verifying.data.state).toBe("verifying");

    finishJobWithSummary(String(verifying.data.jobId), "passed", {
      execution: "deployment-host",
      evidence: { ...EVIDENCE, deploymentId: "dep-2" },
    });
    const observed = await callTool(tools, "grande_deploy_verify");
    expect(observed.ok).toBe(false);
    expect(authStatus(authorizationId)).toBe("FAILED");
    expect(loadStoredReceipt().stages.verify).toBe("failed");

    const again = await callTool(tools, "grande_deploy_verify");
    expect(again.ok).toBe(false);
    expect(calls).toEqual(["deploy", "smoke"]);
    expect(authStatus(authorizationId)).toBe("FAILED");
  });
});
