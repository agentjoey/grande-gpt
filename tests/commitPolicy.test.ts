import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { captureVerificationContext, recordRunVerificationContext } from "../src/attestation.ts";
import { openDb } from "../src/db.ts";
import { createJob, finishJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { loadEffectiveCommitPolicy } from "../src/repoPolicy.ts";
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
  ws = mkdtempSync(join(tmpdir(), "commit-policy-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "commit-policy-ctl-"));
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
  git(canonical, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base");
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  worktree = join(layout.worktreesRoot, "demo", "task_policy_commit");
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", "grande/policy-commit", worktree, "HEAD");
  mkdirSync(join(worktree, ".grande"), { recursive: true });
  writeFileSync(
    join(worktree, ".grande", "policy.yaml"),
    "requireGreenBeforeCommit:\n  - unit-selfhost\n",
    "utf8",
  );

  const db = openDb(layout);
  createTask(db, {
    taskId: "task_policy_commit",
    repoId: "demo",
    branch: "grande/policy-commit",
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

function recordPassed(profile: string): void {
  const context = captureVerificationContext(layout, worktree);
  const jobId = `job_${profile.replaceAll("-", "_")}`;
  createJob(deps.db, { jobId, taskId: "task_policy_commit", profile, argv: ["pnpm", profile], pgid: null });
  recordRunVerificationContext(deps.db, jobId, context);
  finishJob(deps.db, jobId, {
    state: "passed",
    exitCode: 0,
    artifactPath: null,
    summary: { fixture: true },
  });
}

async function commit(): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_commit");
  if (!tool) throw new Error("grande_commit 未注册");
  const result = await tool.handler({ taskId: "task_policy_commit", message: "policy commit" });
  return result.structuredContent as Record<string, any>;
}

describe("requireGreenBeforeCommit", () => {
  it("AC-S2-13：缺少当前工作区对应的必需绿色 profile 时 commit 被拒且零副作用", async () => {
    writeFileSync(join(worktree, "change.txt"), "change\n", "utf8");
    const beforeHead = git(worktree, "rev-parse", "HEAD").trim();

    const result = await commit();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("POLICY_DENIED");
    expect(result.error.message).toContain("unit-selfhost");
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(beforeHead);
    expect(git(worktree, "status", "--porcelain=v1")).toContain("change.txt");
    const row = listAudit(deps.db, "task_policy_commit").find((candidate) => candidate.tool === "grande_commit");
    expect(row?.decision).toBe("DENIED");
    expect(row?.state).toBe("FAILED");
  });

  it("AC-S2-14：必需 profile 在当前工作区状态通过后 commit 成功", async () => {
    writeFileSync(join(worktree, "change.txt"), "change\n", "utf8");
    recordPassed("unit-selfhost");

    const result = await commit();

    expect(result.ok).toBe(true);
    expect(result.data.commit).toBe(git(worktree, "rev-parse", "HEAD").trim());
  });

  it("run 后工作区再变化会让原绿色记录失效", async () => {
    writeFileSync(join(worktree, "change.txt"), "v1\n", "utf8");
    recordPassed("unit-selfhost");
    writeFileSync(join(worktree, "change.txt"), "v2\n", "utf8");

    const result = await commit();

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("POLICY_DENIED");
  });

  it("控制平面与 repo 的 requireGreenBeforeCommit 取并集，repo 不能移除全局约束", () => {
    writeFileSync(
      join(layout.configDir, "deny.yaml"),
      "requireGreenBeforeCommit:\n  - typecheck\n  - unit-selfhost\n",
      "utf8",
    );

    const effective = loadEffectiveCommitPolicy(layout, worktree);

    expect(effective.requireGreenBeforeCommit).toEqual(["typecheck", "unit-selfhost"]);
  });

  it("requireGreenBeforeCommit 非字符串数组时 fail closed", () => {
    writeFileSync(
      join(worktree, ".grande", "policy.yaml"),
      "requireGreenBeforeCommit: unit-selfhost\n",
      "utf8",
    );
    expect(() => loadEffectiveCommitPolicy(layout, worktree)).toThrow(/requireGreenBeforeCommit.*数组/);
  });
});
