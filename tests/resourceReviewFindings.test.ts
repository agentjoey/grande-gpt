import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { awaitDeploymentHostJobSettled, startDeploymentHostJob } from "../src/deploymentHostRunner.ts";
import { registerJobCancellation } from "../src/jobCancellation.ts";
import { getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { repoMap } from "../src/repoMap.ts";
import { reserveManagedJob } from "../src/resourceAdmission.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask } from "../src/tasks.ts";

vi.mock("../src/accessGate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/accessGate.ts")>();
  return {
    ...actual,
    createAccessGate: () => async () => ({ email: "owner@example.test", sub: "owner" }),
  };
});

import { mountConsoleRoutes } from "../src/consoleRoutes.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
const TASK = "task_review_finding";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "b2-review-findings-"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  mkdirSync(process.env.GRANDE_WORKSPACE!, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL!, { recursive: true });
  layout = loadLayout();
  ensureLayout(layout);
  writeFileSync(join(layout.configDir, "resource-policy.json"),
    JSON.stringify({ globalJobs: 1, perTaskJobs: 1, minFreeBytes: 1 }));
  db = openDb(layout);
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function createReadyTask(repoId = "demo"): void {
  const repo = join(layout.workspaceRoot, repoId);
  const worktree = join(layout.worktreesRoot, repoId, TASK);
  mkdirSync(repo, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  saveRegistry(layout, [{ repoId, path: repo, registered: true }]);
  createTask(db, {
    taskId: TASK,
    repoId,
    branch: "grande/review-finding",
    baseCommit: "1".repeat(40),
    worktreePath: worktree,
    state: "READY",
  });
}

describe("review blocker: Console cancellation", () => {
  it("delegates to the live supervisor and does not terminalize the job before settlement", async () => {
    createReadyTask();
    reserveManagedJob(db, layout, {
      jobId: "job_console_owned", taskId: TASK, profile: "test", argv: [], kind: "sandbox",
    });
    const control = registerJobCancellation(db, "job_console_owned");
    const app = new Hono();
    mountConsoleRoutes(app, {
      db,
      consoleAccess: { teamDomain: "https://team.example.test", aud: "c".repeat(64) },
      consoleOrigin: "https://console.example.test",
    });
    const response = await app.request("/console/jobs/job_console_owned/kill", {
      method: "POST",
      headers: {
        Origin: "https://console.example.test",
        "Cf-Access-Jwt-Assertion": "fixture",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(control.signal.aborted).toBe(true);
    expect(getJob(db, "job_console_owned")?.state).toBe("running");
    control.dispose();
  });
});

describe("review blocker: deployment-host admission", () => {
  it("reserves capacity before artifact allocation or host spawn", async () => {
    createReadyTask();
    reserveManagedJob(db, layout, {
      jobId: "job_capacity_owner", taskId: TASK, profile: "unit", argv: [], kind: "sandbox",
    });
    const marker = join(layout.workspaceRoot, "demo", "should-not-run.txt");
    writeFileSync(join(layout.configDir, "profiles.yaml"),
      `repos:\n  demo:\n    deploy-production:\n      argv: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`)}]\n      timeoutSeconds: 30\n      execution: deployment-host\n`);
    let started: ReturnType<typeof startDeploymentHostJob> | undefined;
    let failure: unknown;
    try {
      started = startDeploymentHostJob(
        { db, layout },
        { taskId: TASK, repoId: "demo", profileName: "deploy-production" },
      );
    } catch (error) {
      failure = error;
    }
    if (started) await awaitDeploymentHostJobSettled(started.jobId);
    expect(failure).toBeDefined();
    expect(String((failure as Error | undefined)?.message)).toMatch(/capacity|占位|运行|resource/i);
    expect(existsSync(marker)).toBe(false);
    expect(getJob(db, "job_capacity_owner")?.state).toBe("running");
  });
});

describe("review blocker: repo_map bounded cursor", () => {
  it("can resume a valid static tree whose pending frontier would exceed the old cursor budget", () => {
    const tree = join(root, "tree");
    mkdirSync(tree);
    const expected: string[] = [];
    for (let i = 0; i < 70; i++) {
      const dir = `a${"!".repeat(i)}`;
      mkdirSync(join(tree, dir));
      writeFileSync(join(tree, dir, "z"), "x");
      expected.push(dir, `${dir}/z`);
    }
    const actual: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = repoMap(tree, { maxEntries: 47, cursor });
      actual.push(...page.entries.map((entry) => entry.path));
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(20);
    } while (cursor);
    expect(actual).toEqual(expected.sort());
    expect(new Set(actual).size).toBe(expected.length);
  });
});
