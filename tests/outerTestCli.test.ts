import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { openDb } from "../src/db.ts";
import { buildHostVerifierStaticPlan } from "../src/hostVerifier.ts";
import { TRUSTED_HOST_MANIFEST } from "../src/hostVerification.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { getOuterTestReceipt, persistTrustedOuterTestPassV2 } from "../src/outerTestReceipt.ts";
import { createTask } from "../src/tasks.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;
let lines: string[];

async function cli(argv: string[], options: Record<string, unknown> = {}): Promise<number> {
  return await runCli(argv, (line) => lines.push(line), options as any);
}

type TestOuterSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: "inherit"; encoding: "utf8" },
) => { status: number | null; error?: Error };

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

function prepareRunnableTask(taskId: string, changedPath = "src/feature.ts"): { worktreePath: string; base: string; head: string } {
  const layout = loadLayout();
  const worktreePath = join(ws, ".grande-work", "worktrees", "grande-gpt", taskId);
  mkdirSync(worktreePath, { recursive: true });
  git(worktreePath, "init", "-q", "-b", "grande/s18");
  git(
    worktreePath,
    "-c", "user.name=GrandeGPT",
    "-c", "user.email=grande@example.com",
    "commit", "--allow-empty", "-q", "-m", "base",
  );
  const base = git(worktreePath, "rev-parse", "HEAD");
  const absolute = join(worktreePath, changedPath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, "change\n", "utf8");
  git(worktreePath, "add", changedPath);
  git(
    worktreePath,
    "-c", "user.name=GrandeGPT",
    "-c", "user.email=grande@example.com",
    "commit", "-q", "-m", "change",
  );
  const head = git(worktreePath, "rev-parse", "HEAD");

  const db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch: "grande/s18",
    baseCommit: base,
    worktreePath,
    state: "READY",
  });
  db.close();
  return { worktreePath, base, head };
}

function persistManualV2(taskId: string, commit: string, level: "smoke" | "full"): string {
  const db = openDb(loadLayout());
  const plan = buildHostVerifierStaticPlan(level);
  const jobId = `job_cli_${taskId}_${level}`;
  createJob(db, { jobId, taskId, profile: "host-verifier", argv: ["trusted-host-verifier"], pgid: 321 });
  finishJob(db, jobId, {
    state: "passed",
    exitCode: 0,
    artifactPath: null,
    summary: {
      kind: "host-verifier-v2",
      mode: "manual",
      repoId: "grande-gpt",
      commit,
      level,
      files: plan.files,
      policyVersion: plan.policyVersion,
      resourceLimits: plan.resourceLimits,
      loopbackPorts: [49173],
      hostToolchain: { node: "v24.14.0", pnpm: "10.33.0", lockfileSha256: "b".repeat(64) },
    },
  });
  persistTrustedOuterTestPassV2(db, taskId, jobId);
  db.close();
  return jobId;
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "ot-cli-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "ot-cli-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  lines = [];

  const layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(ws, "grande-gpt"), { recursive: true });
  const excludes = [
    "tests/sandbox.test.ts",
    "tests/runner.test.ts",
    "tests/server.test.ts",
    "tests/tools.test.ts",
    "tests/e2e.test.ts",
  ].flatMap((file) => ["--exclude", file]);
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos:\n  grande-gpt:\n" +
      `    unit-selfhost: { argv: ${JSON.stringify(["npx", "vitest", "run", ...excludes])}, timeoutSeconds: 600 }\n`,
    "utf8",
  );
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("grande outer-test --task", () => {
  it("显式 taskId 时把验收目标锁定到 task.worktreePath，而不是 canonical checkout", async () => {
    const { worktreePath } = prepareRunnableTask("task_phase4");
    expect(await cli(["outer-test", "--task", "task_phase4"])).toBe(0);
    expect(lines.join("\n")).toContain(worktreePath);
  });

  it("--task 后没有值时 fail closed，不退化成验收 canonical", async () => {
    expect(await cli(["outer-test", "--task"])).not.toBe(0);
    expect(lines.join("\n")).toContain("--task");
  });

  it("auto-safe --run uses the restricted verifier path and never calls legacy host spawn", async () => {
    const { head } = prepareRunnableTask("task_host_plan");
    let restrictedCalls = 0;
    let legacyCalls = 0;
    const code = await cli(
      ["outer-test", "--task", "task_host_plan", "--run"],
      {
        restrictedOuterTestRun: async (input: any) => {
          restrictedCalls += 1;
          expect(input).toMatchObject({ taskId: "task_host_plan", commit: head, level: "smoke" });
          const jobId = persistManualV2("task_host_plan", head, "smoke");
          return { jobId };
        },
        outerTestSpawn: (() => { legacyCalls += 1; return { status: 0 }; }) as TestOuterSpawn,
      },
    );
    expect(code).toBe(0);
    expect(restrictedCalls).toBe(1);
    expect(legacyCalls).toBe(0);
    const db = openDb(loadLayout());
    expect(getOuterTestReceipt(db, "task_host_plan")).toMatchObject({ version: 2, mode: "manual", commit: head });
    db.close();
  });

  it("manual-only --run uses the fixed trusted legacy host suite and does not start restricted auto verifier", async () => {
    prepareRunnableTask("task_manual_only", "src/hostVerifierRuntime.ts");
    let restrictedCalls = 0;
    let seenArgs: readonly string[] = [];
    const code = await cli(
      ["outer-test", "--task", "task_manual_only", "--run"],
      {
        restrictedOuterTestRun: async () => { restrictedCalls += 1; return { jobId: "nope" }; },
        outerTestSpawn: ((_command: string, args: readonly string[]) => { seenArgs = args; return { status: 0 }; }) as TestOuterSpawn,
      },
    );
    expect(code).toBe(0);
    expect(restrictedCalls).toBe(0);
    expect(seenArgs).toEqual([
      "vitest", "run", "--config", "vitest.host.config.ts",
      ...TRUSTED_HOST_MANIFEST.map((entry) => entry.file),
    ]);
  });

  it("restricted --run requires a persisted exact-SHA V2 manual receipt", async () => {
    const { head } = prepareRunnableTask("task_restricted_receipt");
    const code = await cli(
      ["outer-test", "--task", "task_restricted_receipt", "--run"],
      {
        restrictedOuterTestRun: async () => ({ jobId: "job-without-receipt" }),
        outerTestSpawn: (() => { throw new Error("legacy spawn must not run"); }) as TestOuterSpawn,
      },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/receipt|验证记录|不要合并/i);

    const db = openDb(loadLayout());
    expect(getOuterTestReceipt(db, "task_restricted_receipt")).toBeNull();
    db.close();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("manual-only legacy run still rejects HEAD drift before issuing transitional receipt", async () => {
    const { worktreePath } = prepareRunnableTask("task_manual_drift", "src/hostVerifierRuntime.ts");
    const code = await cli(
      ["outer-test", "--task", "task_manual_drift", "--run"],
      {
        outerTestSpawn: (() => {
          git(
            worktreePath,
            "-c", "user.name=Other",
            "-c", "user.email=other@example.com",
            "commit", "--allow-empty", "-q", "-m", "concurrent change",
          );
          return { status: 0 };
        }) as TestOuterSpawn,
      },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/receipt.*失败|HEAD.*变化|不要合并/i);
  });
});
