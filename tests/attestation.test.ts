import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureVerificationContext,
  getAttestations,
  recordRunVerificationContext,
} from "../src/attestation.ts";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";
import { finishJob, createJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let ws: string;
let ctrl: string;
let layout: Layout;
let canonical: string;
let worktree: string;
let deps: ToolDeps;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "attest-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "attest-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  writeFileSync(
    join(layout.configDir, "identity.yaml"),
    "commit:\n  name: GrandeGPT\n  email: grande@ymmn\n",
    "utf8",
  );

  canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  writeFileSync(join(canonical, "base.txt"), "base\n", "utf8");
  writeFileSync(join(canonical, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  git(canonical, "add", ".");
  git(canonical, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "-q", "-m", "init");
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  worktree = join(layout.worktreesRoot, "demo", "task_attest");
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/attest-test", worktree, "HEAD");
  const db = openDb(layout);
  createTask(db, {
    taskId: "task_attest",
    repoId: "demo",
    branch: "grande/attest-test",
    baseCommit: git(canonical, "rev-parse", "HEAD").trim(),
    worktreePath: worktree,
    state: "READY",
  });
  deps = { db, layout, defaultRepoId: "demo" };
});

afterEach(() => {
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

function passedJob(profile = "unit-selfhost"): string {
  const context = captureVerificationContext(layout, worktree);
  const jobId = `job_${profile.replaceAll("-", "_")}`;
  createJob(deps.db, { jobId, taskId: "task_attest", profile, argv: ["pnpm", "test"], pgid: null });
  recordRunVerificationContext(deps.db, jobId, context);
  finishJob(deps.db, jobId, {
    state: "passed",
    exitCode: 0,
    artifactPath: null,
    summary: { fixture: true },
  });
  return jobId;
}

async function commit(): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_commit");
  if (!tool) throw new Error("grande_commit 未注册");
  const response = await tool.handler({ taskId: "task_attest", message: "attested commit" });
  return response.structuredContent as Record<string, any>;
}

describe("Verification Attestation", () => {
  it("AC-S2-6：通过的本机验证记录在 commit 后绑定新 sha", async () => {
    writeFileSync(join(worktree, "verified.txt"), "verified\n", "utf8");
    const jobId = passedJob();

    const result = await commit();

    expect(result.ok).toBe(true);
    expect(result.data.attestation.issued).toBe(true);
    const rows = getAttestations(deps.db, "task_attest");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commit).toBe(result.data.commit);
    expect(rows[0]!.jobId).toBe(jobId);
    expect(git(worktree, "log", "-1", "--format=%B")).toContain(`Grande-Attestation: ${rows[0]!.attestationId}`);
  });

  it("AC-S2-7：run 后工作区再变化则不签发，并明确说明原因", async () => {
    writeFileSync(join(worktree, "verified.txt"), "v1\n", "utf8");
    passedJob();
    writeFileSync(join(worktree, "verified.txt"), "v2\n", "utf8");

    const result = await commit();

    expect(result.ok).toBe(true);
    expect(result.data.attestation.issued).toBe(false);
    expect(result.data.attestation.reason).toMatch(/run.*commit|工作区.*变化|不一致/i);
    expect(getAttestations(deps.db, "task_attest")).toEqual([]);
    expect(git(worktree, "log", "-1", "--format=%B")).toContain("Grande-Attestation: none");
  });

  it("AC-S2-8：hostToolchain 的 node、pnpm、lockfileSha256 都是真实非空值", async () => {
    writeFileSync(join(worktree, "toolchain.txt"), "x\n", "utf8");
    passedJob("typecheck");
    const result = await commit();
    expect(result.ok).toBe(true);

    const toolchain = getAttestations(deps.db, "task_attest")[0]!.hostToolchain;
    for (const value of [toolchain.node, toolchain.pnpm, toolchain.lockfileSha256]) {
      expect(value).toBeTruthy();
      expect(value).not.toBe("unknown");
    }
    expect(toolchain.node).toBe(process.version);
    expect(toolchain.lockfileSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("schema 版本门禁：旧版本的库被响亮拒绝，不静默当作可用", () => {
    const disk = new DatabaseSync(layout.stateDb);
    expect((disk.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    disk.close();

    deps.db.close();
    rmSync(layout.stateDb, { force: true });
    rmSync(`${layout.stateDb}-wal`, { force: true });
    rmSync(`${layout.stateDb}-shm`, { force: true });
    const old = new DatabaseSync(layout.stateDb);
    old.exec(`CREATE TABLE task (taskId TEXT PRIMARY KEY); PRAGMA user_version = ${SCHEMA_VERSION - 1};`);
    old.close();
    expect(() => openDb(layout)).toThrow(
      new RegExp(`期望 user_version=${SCHEMA_VERSION}.*user_version=${SCHEMA_VERSION - 1}`),
    );
    deps = { ...deps, db: new DatabaseSync(":memory:") };
  });
});
