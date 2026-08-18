import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import {
  createDeploymentTools,
  loadDeploymentSpec,
  type DeploymentToolOptions,
} from "../src/deployment.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
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
