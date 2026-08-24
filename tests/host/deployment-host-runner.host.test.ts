import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  awaitDeploymentHostJobSettled,
  startDeploymentHostJob,
} from "../../src/deploymentHostRunner.ts";
import { openDb } from "../../src/db.ts";
import { getJob } from "../../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../../src/layout.ts";
import { saveRegistry } from "../../src/registry.ts";
import { createTask } from "../../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
let canonicalRepo: string;
const taskId = "task_deployment_host_probe";
const saved = { workspace: process.env.GRANDE_WORKSPACE, control: process.env.GRANDE_CONTROL };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deployment-host-runner-probe-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });

  layout = loadLayout();
  ensureLayout(layout);
  canonicalRepo = join(layout.workspaceRoot, "demo");
  const worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(canonicalRepo, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  saveRegistry(layout, [{ repoId: "demo", path: canonicalRepo, registered: true }]);

  db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "demo",
    branch: "grande/deployment-host-probe",
    baseCommit: "base",
    worktreePath: worktree,
    state: "READY",
  });

  const proofPath = join(canonicalRepo, "host-proof.txt");
  const script = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(proofPath)}, process.cwd() + "\\n" + process.env.GRANDE_CONTROL);`,
  ].join("");
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    `repos:\n  demo:\n    deploy-production:\n      argv: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(script)}]\n      timeoutSeconds: 30\n      execution: deployment-host\n`,
    "utf8",
  );
});

afterEach(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
  if (saved.workspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.workspace;
  if (saved.control === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.control;
});

describe("deployment host runner on trusted host", () => {
  it("executes the fixed control-plane argv from the canonical repo and records a normal job receipt", async () => {
    const started = startDeploymentHostJob(
      { db, layout },
      { taskId, repoId: "demo", profileName: "deploy-production" },
    );
    await awaitDeploymentHostJobSettled(started.jobId);

    const job = getJob(db, started.jobId)!;
    expect(job.state).toBe("passed");
    expect(job.exitCode).toBe(0);
    expect(job.summary?.execution).toBe("deployment-host");
    expect(job.artifactPath).toBeTruthy();

    const proof = readFileSync(join(canonicalRepo, "host-proof.txt"), "utf8").split("\n");
    expect(proof[0]).toBe(canonicalRepo);
    expect(proof[1]).toBe(layout.controlRoot);
  });
});
