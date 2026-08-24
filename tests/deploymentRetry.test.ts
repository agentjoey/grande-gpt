import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createDeploymentTools, type DeploymentToolOptions } from "../src/deployment.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
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
