import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hono/node-server", () => ({
  serve: () => ({
    close: (callback: (error?: Error) => void) => callback(),
  }),
}));

import { openDb } from "../src/db.ts";
import { createJob, getJob, setRunningJobSummary } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { startGateway, type AppConfig } from "../src/server.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
let oldPort: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-verifier-startup-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  const worktree = join(root, "task-worktree");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  oldPort = process.env.PORT;
  process.env.PORT = "0";
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  db = openDb(layout);
  createTask(db, {
    taskId: "task_startup_recovery",
    repoId: "grande-gpt",
    branch: "grande/startup-recovery",
    baseCommit: "0".repeat(40),
    worktreePath: worktree,
    state: "READY",
  });
});

afterEach(() => {
  db.close();
  if (oldPort === undefined) delete process.env.PORT;
  else process.env.PORT = oldPort;
  rmSync(root, { recursive: true, force: true });
});

describe("D1 Gateway startup host-verifier reconciliation", () => {
  it("finishes an interrupted verifier with the trusted restart reason before serving", async () => {
    const jobId = "job_startup_verifier";
    createJob(db, {
      jobId,
      taskId: "task_startup_recovery",
      profile: "host-verifier",
      argv: ["trusted-host-verifier", "smoke", "a".repeat(40)],
      pgid: null,
    });
    const absentDisposableRoot = join(tmpdir(), "grande-host-verifier-startup-absent");
    rmSync(absentDisposableRoot, { recursive: true, force: true });
    setRunningJobSummary(db, jobId, {
      kind: "host-verifier-running",
      repoId: "grande-gpt",
      commit: "a".repeat(40),
      level: "smoke",
      disposableRoot: absentDisposableRoot,
    });

    const cfg: AppConfig = {
      issuer: "https://grande.example.test",
      layout,
      db,
      accessConfig: { teamDomain: "https://team.example.test", aud: "a".repeat(64) },
    };
    const gateway = await startGateway(cfg);
    try {
      expect(getJob(db, jobId)).toMatchObject({
        state: "killed",
        summary: {
          kind: "host-verifier-failure",
          infrastructureFailure: true,
          reason: "interrupted_by_gateway_restart",
          cleaned: true,
        },
      });
    } finally {
      await gateway.close();
    }
  });
});
