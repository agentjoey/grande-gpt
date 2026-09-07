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
import {
  createDeploymentTools,
  loadDeploymentSpec,
  type DeploymentToolOptions,
} from "../src/deployment.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveExplicitDeliveryTarget } from "../src/taskDeliveryTarget.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDef, type ToolDeps } from "../src/tools.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps;
let worktree: string;
const taskId = "task_deploy";
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

function writeSpec(content: string): void {
  mkdirSync(join(worktree, ".grande"), { recursive: true });
  writeFileSync(join(worktree, ".grande", "deploy.yaml"), content, "utf8");
}

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

function setJobState(jobId: string, state: "passed" | "failed"): void {
  deps.db.prepare("UPDATE job SET state=?, exitCode=?, endedAt=? WHERE jobId=?")
    .run(state, state === "passed" ? 0 : 1, Date.now(), jobId);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(worktree, { recursive: true });
  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  createTask(deps.db, {
    taskId,
    repoId: "demo",
    branch: "grande/deploy-test",
    baseCommit: "base",
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("S7 deployment spec", () => {
  it("repo 只能引用已批准 profile/capability；不接受 command/argv，verify 是 DONE 的必备步骤", () => {
    writeSpec(
      "deploy:\n  profile: deploy\nverify:\n  capability:\n    provider: health\n    name: check\n    arguments:\n      url: /health\n",
    );
    expect(loadDeploymentSpec(worktree)).toMatchObject({
      deploy: { kind: "profile", profile: "deploy" },
      verify: { kind: "capability", provider: "health", name: "check" },
    });

    writeSpec("deploy:\n  command: pnpm deploy\nverify:\n  profile: smoke\n");
    expect(() => loadDeploymentSpec(worktree)).toThrow(/command|未知字段|profile|capability/i);

    writeSpec("deploy:\n  profile: deploy\n");
    expect(() => loadDeploymentSpec(worktree)).toThrow(/verify/i);
  });

  it("超过 24 KiB 的 deploy.yaml 即使有效前缀可独立解析也 fail closed，不执行截断配置", () => {
    writeSpec(
      "deploy:\n  profile: deploy\nverify:\n  profile: smoke\n# " + "x".repeat(24 * 1024),
    );

    expect(() => loadDeploymentSpec(worktree)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("生产工具只接受 taskId；deploy/rollback 如实标为 destructive+openWorld", () => {
    const tools = buildTools(deps);
    const deploy = tools.find((tool) => tool.name === "grande_deploy")!;
    const verify = tools.find((tool) => tool.name === "grande_deploy_verify")!;
    const rollback = tools.find((tool) => tool.name === "grande_deploy_rollback")!;
    expect(deploy).toBeDefined();
    expect(verify).toBeDefined();
    expect(rollback).toBeDefined();
    expect(deploy.inputSchema.properties).toEqual({ taskId: expect.any(Object) });
    expect(verify.inputSchema.properties).toEqual({ taskId: expect.any(Object) });
    expect(rollback.inputSchema.properties).toEqual({ taskId: expect.any(Object) });
    expect(deploy.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(verify.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(rollback.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });
});

describe("S7 capability deployment vertical slice", () => {
  function capabilityTools(calls: string[]): ToolDef[] {
    return [
      stubTool("grande_capability_inspect", async (args) => ({
        structuredContent: {
          ok: true,
          data: {
            capability: {
              provider: args.provider,
              name: args.name,
              risk: args.name === "verify" ? "read" : "production",
            },
          },
        },
      })),
      stubTool("grande_capability_invoke", async (args) => {
        calls.push(`${String(args.provider)}/${String(args.name)}`);
        return { structuredContent: { ok: true, data: { result: { ok: true } } } };
      }),
    ];
  }

  it("merged → deploy capability → verify capability → DONE；repo config 不能绕过 production/read 风险角色", async () => {
    writeSpec(
      "deploy:\n  capability:\n    provider: platform\n    name: deploy\n    arguments:\n      environment: production\n" +
      "verify:\n  capability:\n    provider: platform\n    name: verify\n" +
      "rollback:\n  capability:\n    provider: platform\n    name: rollback\n",
    );
    const calls: string[] = [];
    const options: DeploymentToolOptions = { requireMerged: async () => ({ merged: true, mergeSha: "merge1" }) };
    const tools = createDeploymentTools(deps, capabilityTools(calls), options);
    const deploy = tools.find((tool) => tool.name === "grande_deploy")!;
    const verify = tools.find((tool) => tool.name === "grande_deploy_verify")!;

    const deployed = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(deployed.ok).toBe(true);
    expect(deployed.data.state).toBe("deployed");
    expect(calls).toEqual(["platform/deploy"]);

    const verified = (await verify.handler({ taskId })).structuredContent as Record<string, any>;
    expect(verified.ok).toBe(true);
    expect(verified.data.state).toBe("DONE");
    expect(calls).toEqual(["platform/deploy", "platform/verify"]);
  });

  it("merge 前不能 deploy；没有真实 deploy receipt 不能单独 verify", async () => {
    writeSpec("deploy:\n  capability:\n    provider: platform\n    name: deploy\nverify:\n  capability:\n    provider: platform\n    name: verify\n");
    const calls: string[] = [];
    const denied = createDeploymentTools(
      deps,
      capabilityTools(calls),
      { requireMerged: async () => ({ merged: false }) },
    ).find((tool) => tool.name === "grande_deploy")!;
    const envelope = (await denied.handler({ taskId })).structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual([]);

    const verify = createDeploymentTools(
      deps,
      capabilityTools(calls),
      { requireMerged: async () => ({ merged: true, mergeSha: "m" }) },
    ).find((tool) => tool.name === "grande_deploy_verify")!;
    const verifyEnvelope = (await verify.handler({ taskId })).structuredContent as Record<string, any>;
    expect(verifyEnvelope.ok).toBe(false);
    expect(JSON.stringify(verifyEnvelope)).toMatch(/deploy|receipt|部署/i);
  });

  it("部署后 repo deploy spec 发生变化时 verify fail closed，不拿旧部署结果给新配置背书", async () => {
    writeSpec("deploy:\n  capability:\n    provider: platform\n    name: deploy\nverify:\n  capability:\n    provider: platform\n    name: verify\n");
    const calls: string[] = [];
    const options: DeploymentToolOptions = { requireMerged: async () => ({ merged: true, mergeSha: "m" }) };
    const tools = createDeploymentTools(deps, capabilityTools(calls), options);
    await tools.find((tool) => tool.name === "grande_deploy")!.handler({ taskId });

    writeSpec("deploy:\n  capability:\n    provider: platform\n    name: deploy-v2\nverify:\n  capability:\n    provider: platform\n    name: verify\n");
    const envelope = (await tools.find((tool) => tool.name === "grande_deploy_verify")!.handler({ taskId }))
      .structuredContent as Record<string, any>;
    expect(envelope.ok).toBe(false);
    expect(JSON.stringify(envelope)).toMatch(/变化|digest|spec|配置/i);
  });
});

describe("S7 profile deployment + existing rollback", () => {
  it("profile deploy/verify 复用 grande_run 的异步 job；通过后 DONE，rollback 只调用 repo 已声明机制", async () => {
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      "repos:\n  demo:\n    deploy:\n      argv: [\"pnpm\",\"run\",\"deploy\"]\n      timeoutSeconds: 600\n" +
      "    smoke:\n      argv: [\"pnpm\",\"run\",\"smoke\"]\n      timeoutSeconds: 60\n" +
      "    rollback:\n      argv: [\"pnpm\",\"run\",\"rollback\"]\n      timeoutSeconds: 600\n",
      "utf8",
    );
    writeSpec("deploy:\n  profile: deploy\nverify:\n  profile: smoke\nrollback:\n  profile: rollback\n");
    let seq = 0;
    const runCalls: string[] = [];
    const runTool = stubTool("grande_run", async (args) => {
      const jobId = `job_deploy_${++seq}`;
      runCalls.push(String(args.profile));
      insertJob(jobId, String(args.profile), "running");
      return { structuredContent: { ok: true, data: { jobId, state: "running" } } };
    });
    const options: DeploymentToolOptions = { requireMerged: async () => ({ merged: true, mergeSha: "merge1" }) };
    const tools = createDeploymentTools(deps, [runTool], options);

    const deploy = tools.find((tool) => tool.name === "grande_deploy")!;
    const verify = tools.find((tool) => tool.name === "grande_deploy_verify")!;
    const rollback = tools.find((tool) => tool.name === "grande_deploy_rollback")!;

    const started = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(started.data.state).toBe("deploying");
    expect(runCalls).toEqual(["deploy"]);
    setJobState(started.data.jobId, "passed");

    const verifying = (await verify.handler({ taskId })).structuredContent as Record<string, any>;
    expect(verifying.data.state).toBe("verifying");
    expect(runCalls).toEqual(["deploy", "smoke"]);
    setJobState(verifying.data.jobId, "passed");

    const done = (await verify.handler({ taskId })).structuredContent as Record<string, any>;
    expect(done.ok).toBe(true);
    expect(done.data.state).toBe("DONE");

    const rolledBack = (await rollback.handler({ taskId })).structuredContent as Record<string, any>;
    expect(rolledBack.ok).toBe(true);
    expect(rolledBack.data.state).toBe("rolling-back");
    expect(runCalls).toEqual(["deploy", "smoke", "rollback"]);
  });
});

describe("V2 delivery-authorized capability deploy/verify", () => {
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

  function writeV2Spec(): void {
    writeSpec(
      "deploy:\n  capability:\n    provider: platform\n    name: deploy\n" +
      "verify:\n  capability:\n    provider: platform\n    name: verify\n",
    );
  }

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
      deployRef: "capability:platform/deploy",
      verifyRef: "capability:platform/verify",
    };
  }

  function createExecutingAuth(): { authorizationId: string; bindingDigest: string } {
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
    const executing = beginAuthorizedExecution(deps.db, auth.authorizationId, "delivery", auth.bindingDigest);
    return { authorizationId: executing.authorizationId, bindingDigest: executing.bindingDigest };
  }

  function plantMergeReceipt(authorizationId: string): void {
    persistExactMergeReceipt(layout, {
      authorizationId,
      baseSha: BASE,
      headSha: HEAD,
      mergeSha: MERGE,
      mergeTree: TREE,
      releaseSourceRealpath: join(root, "release-source"),
    });
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

  function v2Tools(calls: string[], results: Record<string, unknown>): ToolDef[] {
    return [
      stubTool("grande_capability_inspect", async (args) => ({
        structuredContent: {
          ok: true,
          data: {
            capability: {
              provider: args.provider,
              name: args.name,
              risk: args.name === "verify" ? "read" : "production",
            },
          },
        },
      })),
      stubTool("grande_capability_invoke", async (args) => {
        calls.push(`${String(args.provider)}/${String(args.name)}`);
        return { structuredContent: { ok: true, data: { result: results[String(args.name)] } } };
      }),
    ];
  }

  function makeTools(calls: string[], results: Record<string, unknown>): ToolDef[] {
    return createDeploymentTools(deps, v2Tools(calls, results));
  }

  async function callTool(tools: ToolDef[], name: string): Promise<Record<string, any>> {
    const tool = tools.find((candidate) => candidate.name === name)!;
    return (await tool.handler({ taskId })).structuredContent as Record<string, any>;
  }

  it("没有活跃 EXECUTING authorization 时拒绝 deploy，零 side effect", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const calls: string[] = [];
    const tools = makeTools(calls, { deploy: EVIDENCE, verify: EVIDENCE });

    const envelope = await callTool(tools, "grande_deploy");
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("没有 exact merge receipt 时拒绝 deploy，authorization 保持 EXECUTING", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const { authorizationId } = createExecutingAuth();
    const calls: string[] = [];
    const tools = makeTools(calls, { deploy: EVIDENCE, verify: EVIDENCE });

    const envelope = await callTool(tools, "grande_deploy");
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(authStatus(authorizationId)).toBe("EXECUTING");
  });

  it("execution deadline 已过期时拒绝 deploy", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const { authorizationId } = createExecutingAuth();
    plantMergeReceipt(authorizationId);
    deps.db
      .prepare("UPDATE delivery_authorization SET executionDeadlineAt=? WHERE authorizationId=?")
      .run(Date.now() - 1, authorizationId);
    const calls: string[] = [];
    const tools = makeTools(calls, { deploy: EVIDENCE, verify: EVIDENCE });

    const envelope = await callTool(tools, "grande_deploy");
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(authStatus(authorizationId)).toBe("EXECUTING");
  });

  it("首次 deploy 调用一次；重入观察同一 receipt，绝不重复调用", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const { authorizationId } = createExecutingAuth();
    plantMergeReceipt(authorizationId);
    const calls: string[] = [];
    const tools = makeTools(calls, { deploy: EVIDENCE, verify: EVIDENCE });

    const first = await callTool(tools, "grande_deploy");
    expect(first.ok).toBe(true);
    expect(first.data.state).toBe("deployed");
    expect(first.data.authorizationId).toBe(authorizationId);
    expect(first.data.deployEvidence).toEqual(EVIDENCE);
    expect(calls).toEqual(["platform/deploy"]);

    const again = await callTool(tools, "grande_deploy");
    expect(again.ok).toBe(true);
    expect(again.data.existing).toBe(true);
    expect(calls).toEqual(["platform/deploy"]);

    const receipt = loadStoredReceipt();
    expect(receipt.authorizationId).toBe(authorizationId);
    expect(receipt.merge).toEqual({ baseSha: BASE, headSha: HEAD, mergeSha: MERGE, mergeTree: TREE });
    expect(receipt.deployEvidence).toEqual(EVIDENCE);
    expect(receipt.stages).toEqual({ deploy: "succeeded", verify: "pending" });
    expect(receipt.deployUncertain).toBe(false);
  });

  it("happy path：deploy + verify 证据身份一致 → DONE 且 authorization SUCCEEDED", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const { authorizationId } = createExecutingAuth();
    plantMergeReceipt(authorizationId);
    const calls: string[] = [];
    const tools = makeTools(calls, { deploy: EVIDENCE, verify: EVIDENCE });

    await callTool(tools, "grande_deploy");
    const verified = await callTool(tools, "grande_deploy_verify");
    expect(verified.ok).toBe(true);
    expect(verified.data.state).toBe("DONE");
    expect(calls).toEqual(["platform/deploy", "platform/verify"]);
    expect(authStatus(authorizationId)).toBe("SUCCEEDED");

    const receipt = loadStoredReceipt();
    expect(receipt.verifyComplete).toBe(true);
    expect(receipt.verifyEvidence).toEqual(EVIDENCE);
    expect(receipt.stages).toEqual({ deploy: "succeeded", verify: "succeeded" });

    const again = await callTool(tools, "grande_deploy_verify");
    expect(again.ok).toBe(true);
    expect(again.data.state).toBe("DONE");
    expect(again.data.existing).toBe(true);
    expect(calls).toEqual(["platform/deploy", "platform/verify"]);
  });

  it("deploy 证据身份不匹配 → FAILED 且绝不重试", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const { authorizationId } = createExecutingAuth();
    plantMergeReceipt(authorizationId);
    const calls: string[] = [];
    const bad = { ...EVIDENCE, sourceSha: "b".repeat(40) };
    const tools = makeTools(calls, { deploy: bad, verify: EVIDENCE });

    const envelope = await callTool(tools, "grande_deploy");
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual(["platform/deploy"]);
    expect(authStatus(authorizationId)).toBe("FAILED");

    const again = await callTool(tools, "grande_deploy");
    expect(again.ok).toBe(true);
    expect(again.data.existing).toBe(true);
    expect(again.data.state).toBe("failed");
    expect(calls).toEqual(["platform/deploy"]);
    expect(authStatus(authorizationId)).toBe("FAILED");
  });

  it("deploy 证据缺失/非法 → UNCERTAIN 且绝不重试", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const { authorizationId } = createExecutingAuth();
    plantMergeReceipt(authorizationId);
    const calls: string[] = [];
    const tools = makeTools(calls, { deploy: { ok: true }, verify: EVIDENCE });

    const envelope = await callTool(tools, "grande_deploy");
    expect(envelope.ok).toBe(true);
    expect(envelope.data.state).toBe("uncertain");
    expect(envelope.data.retryable).toBe(false);
    expect(calls).toEqual(["platform/deploy"]);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");

    const again = await callTool(tools, "grande_deploy");
    expect(again.ok).toBe(true);
    expect(again.data.state).toBe("uncertain");
    expect(again.data.existing).toBe(true);
    expect(calls).toEqual(["platform/deploy"]);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");
  });

  it("verify 证据与 deployEvidence 不一致 → FAILED 且绝不重试", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const { authorizationId } = createExecutingAuth();
    plantMergeReceipt(authorizationId);
    const calls: string[] = [];
    const tools = makeTools(calls, {
      deploy: EVIDENCE,
      verify: { ...EVIDENCE, deploymentId: "dep-2" },
    });

    await callTool(tools, "grande_deploy");
    const envelope = await callTool(tools, "grande_deploy_verify");
    expect(envelope.ok).toBe(false);
    expect(calls).toEqual(["platform/deploy", "platform/verify"]);
    expect(authStatus(authorizationId)).toBe("FAILED");

    const again = await callTool(tools, "grande_deploy_verify");
    expect(again.ok).toBe(false);
    expect(calls).toEqual(["platform/deploy", "platform/verify"]);
    expect(authStatus(authorizationId)).toBe("FAILED");
  });

  it("verify 证据缺失/非法 → UNCERTAIN 且绝不重试", async () => {
    writeV2Spec();
    saveExplicitDeliveryTarget(deps.db, taskId, "deploy");
    const { authorizationId } = createExecutingAuth();
    plantMergeReceipt(authorizationId);
    const calls: string[] = [];
    const tools = makeTools(calls, { deploy: EVIDENCE, verify: { unexpected: true } });

    await callTool(tools, "grande_deploy");
    const envelope = await callTool(tools, "grande_deploy_verify");
    expect(envelope.ok).toBe(true);
    expect(envelope.data.state).toBe("uncertain");
    expect(envelope.data.retryable).toBe(false);
    expect(calls).toEqual(["platform/deploy", "platform/verify"]);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");

    const again = await callTool(tools, "grande_deploy_verify");
    expect(again.ok).toBe(false);
    expect(calls).toEqual(["platform/deploy", "platform/verify"]);
    expect(authStatus(authorizationId)).toBe("UNCERTAIN");
  });
});
