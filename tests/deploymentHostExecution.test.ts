import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeploymentTools, type DeploymentToolOptions } from "../src/deployment.ts";
import { openDb } from "../src/db.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import type { ToolDeps } from "../src/tools.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps;
let worktree: string;
const taskId = "task_deployment_host";
const saved = { workspace: process.env.GRANDE_WORKSPACE, control: process.env.GRANDE_CONTROL };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deployment-host-execution-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  layout = loadLayout();
  ensureLayout(layout);
  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(join(worktree, ".grande"), { recursive: true });
  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
  createTask(deps.db, {
    taskId,
    repoId: "demo",
    branch: "grande/deployment-host-test",
    baseCommit: "base",
    worktreePath: worktree,
    state: "READY",
  });
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    'repos:\n' +
      '  demo:\n' +
      '    deploy-production: { argv: ["pnpm", "deploy"], timeoutSeconds: 300, execution: "deployment-host" }\n' +
      '    verify-production: { argv: ["pnpm", "verify"], timeoutSeconds: 60, execution: "deployment-host" }\n' +
      '    rollback-production: { argv: ["pnpm", "rollback"], timeoutSeconds: 300, execution: "deployment-host" }\n',
    "utf8",
  );
  writeFileSync(
    join(worktree, ".grande", "deploy.yaml"),
    "deploy:\n  profile: deploy-production\n" +
      "verify:\n  profile: verify-production\n" +
      "rollback:\n  profile: rollback-production\n",
    "utf8",
  );
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
  if (saved.workspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.workspace;
  if (saved.control === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.control;
});

describe("deployment-host profile routing", () => {
  it("routes only deploy/verify through the trusted host seam, never grande_run, and rejects rollback", async () => {
    const calls: string[] = [];
    let sequence = 0;
    const options: DeploymentToolOptions = {
      requireMerged: async () => ({ merged: true, mergeSha: "merge-host" }),
      startHostProfile: ({ taskId: receivedTaskId, profileName }) => {
        expect(receivedTaskId).toBe(taskId);
        const jobId = `job_host_${++sequence}`;
        calls.push(profileName);
        createJob(deps.db, { jobId, taskId, profile: profileName, argv: [profileName], pgid: null });
        return { jobId, state: "running", pollAfterSeconds: 3 };
      },
    };

    // Deliberately pass no grande_run tool. A regression back to the ordinary sandbox route
    // therefore fails immediately instead of merely producing the same external state.
    const tools = createDeploymentTools(deps, [], options);
    const deploy = tools.find((tool) => tool.name === "grande_deploy")!;
    const verify = tools.find((tool) => tool.name === "grande_deploy_verify")!;
    const rollback = tools.find((tool) => tool.name === "grande_deploy_rollback")!;

    const deploying = (await deploy.handler({ taskId })).structuredContent as Record<string, any>;
    expect(deploying.ok).toBe(true);
    expect(deploying.data.state).toBe("deploying");
    expect(calls).toEqual(["deploy-production"]);
    finishJob(deps.db, deploying.data.jobId, {
      state: "passed",
      exitCode: 0,
      artifactPath: null,
      summary: { execution: "deployment-host" },
    });

    const verifying = (await verify.handler({ taskId })).structuredContent as Record<string, any>;
    expect(verifying.ok).toBe(true);
    expect(verifying.data.state).toBe("verifying");
    expect(calls).toEqual(["deploy-production", "verify-production"]);
    finishJob(deps.db, verifying.data.jobId, {
      state: "passed",
      exitCode: 0,
      artifactPath: null,
      summary: { execution: "deployment-host" },
    });

    const done = (await verify.handler({ taskId })).structuredContent as Record<string, any>;
    expect(done.ok).toBe(true);
    expect(done.data.state).toBe("DONE");

    const deniedRollback = (await rollback.handler({ taskId })).structuredContent as Record<string, any>;
    expect(deniedRollback.ok).toBe(false);
    expect(deniedRollback.error.code).toBe("POLICY_DENIED");
    expect(calls).toEqual(["deploy-production", "verify-production"]);
  });
});
