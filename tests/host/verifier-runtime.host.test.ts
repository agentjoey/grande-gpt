import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/db.ts";
import { buildHostVerifierStaticPlan, type HostVerifierRequest, type HostVerifierStaticPlan } from "../../src/hostVerifier.ts";
import { createDefaultHostVerifierRuntimeAdapter, createHostVerifierLauncher } from "../../src/hostVerifierRuntime.ts";
import { getJob } from "../../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../../src/layout.ts";
import { getOuterTestReceipt } from "../../src/outerTestReceipt.ts";
import { saveRegistry } from "../../src/registry.ts";
import { createTask } from "../../src/tasks.ts";

interface Fixture {
  root: string;
  layout: Layout;
  db: ReturnType<typeof openDb>;
  canonical: string;
  taskWorktree: string;
  taskId: string;
  commit: string;
}

const fixtures: Fixture[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function configureFixture(root: string, canonical: string, taskId: string, commit: string): Fixture {
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  const layout = loadLayout();
  ensureLayout(layout);
  saveRegistry(layout, [{ repoId: "grande-gpt", path: canonical, registered: true }]);
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos: {}\ndepDirs:\n  grande-gpt:\n    - node_modules\n",
    "utf8",
  );
  const taskWorktree = join(layout.worktreesRoot, "grande-gpt", taskId);
  mkdirSync(join(layout.worktreesRoot, "grande-gpt"), { recursive: true });
  git(canonical, "worktree", "add", "-q", "-b", `grande/${taskId}`, taskWorktree, commit);
  const db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "grande-gpt",
    branch: `grande/${taskId}`,
    baseCommit: commit,
    worktreePath: taskWorktree,
    state: "READY",
  });
  const fixture = { root, layout, db, canonical, taskWorktree, taskId, commit };
  fixtures.push(fixture);
  return fixture;
}

function fullProjectFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "host-verifier-runtime-pass-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const canonical = join(workspace, "grande-gpt");
  const current = process.cwd();
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", current, canonical], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commit = git(canonical, "rev-parse", "HEAD");
  const currentDeps = join(current, "node_modules");
  if (!existsSync(currentDeps)) throw new Error("real-host verifier probe requires current node_modules");
  execFileSync("/bin/cp", ["-Rc", currentDeps, join(canonical, "node_modules")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return configureFixture(root, canonical, "task-runtime-pass", commit);
}

function resourceFixture(kind: "timeout" | "rss"): Fixture {
  const root = mkdtempSync(join(tmpdir(), `host-verifier-runtime-${kind}-`));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const canonical = join(workspace, "grande-gpt");
  mkdirSync(join(canonical, "tests", "host"), { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "config", "user.name", "Verifier Runtime Probe");
  git(canonical, "config", "user.email", "verifier@example.invalid");
  writeFileSync(join(canonical, "package.json"), '{"type":"module"}\n', "utf8");
  writeFileSync(join(canonical, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(
    join(canonical, "tests", "host", "server-auto.host.test.ts"),
    [
      'import { spawn } from "node:child_process";',
      'import { it } from "vitest";',
      'it("holds a child in the verifier process group", async () => {',
      '  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      '  await new Promise(() => {});',
      '});',
      '',
    ].join("\n"),
    "utf8",
  );
  git(canonical, "add", ".");
  git(canonical, "commit", "-q", "-m", "resource probe");
  const commit = git(canonical, "rev-parse", "HEAD");
  const currentDeps = join(process.cwd(), "node_modules");
  execFileSync("/bin/cp", ["-Rc", currentDeps, join(canonical, "node_modules")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return configureFixture(root, canonical, `task-runtime-${kind}`, commit);
}

function request(fixture: Fixture): HostVerifierRequest {
  return { taskId: fixture.taskId, repoId: "grande-gpt", commit: fixture.commit, level: "full" };
}

function smokePlan(overrides: Partial<HostVerifierStaticPlan["resourceLimits"]>): HostVerifierStaticPlan {
  const base = buildHostVerifierStaticPlan("smoke");
  return { ...base, resourceLimits: { ...base.resourceLimits, ...overrides } };
}

async function waitForGroupGone(pgid: number): Promise<boolean> {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try { fixture.db.close(); } catch { /* already closed */ }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("restricted one-shot host verifier runtime", () => {
  it("runs the real auto-safe full suite at exact SHA and issues V2 after cleanup", async () => {
    const fixture = fullProjectFixture();
    const adapter = createDefaultHostVerifierRuntimeAdapter(
      { db: fixture.db, layout: fixture.layout },
      { readPrHead: async () => fixture.commit },
    );
    const launch = createHostVerifierLauncher({ db: fixture.db, layout: fixture.layout }, adapter);
    const started = launch(request(fixture), buildHostVerifierStaticPlan("full"));
    expect(getJob(fixture.db, started.jobId)?.state).toBe("running");
    await started.settled;

    const job = getJob(fixture.db, started.jobId)!;
    expect(job.state).toBe("passed");
    expect(job.exitCode).toBe(0);
    expect(job.pgid).toBeGreaterThan(0);
    expect(job.artifactPath).toBeTruthy();
    expect(getOuterTestReceipt(fixture.db, fixture.taskId)).toMatchObject({
      version: 2,
      commit: fixture.commit,
      jobId: started.jobId,
      level: "full",
    });
    expect(existsSync(fixture.taskWorktree)).toBe(true);
  }, 60_000);

  it("wall timeout terminates the entire detached verifier process group", async () => {
    const fixture = resourceFixture("timeout");
    const adapter = createDefaultHostVerifierRuntimeAdapter(
      { db: fixture.db, layout: fixture.layout },
      { readPrHead: async () => fixture.commit },
    );
    const launch = createHostVerifierLauncher({ db: fixture.db, layout: fixture.layout }, adapter);
    const started = launch(
      { ...request(fixture), level: "smoke" },
      smokePlan({ wallTimeoutMs: 500, maxRssMb: 1536 }),
    );
    await started.settled;
    const job = getJob(fixture.db, started.jobId)!;
    expect(job.state).toBe("timeout");
    expect(job.pgid).toBeGreaterThan(0);
    expect(await waitForGroupGone(job.pgid!)).toBe(true);
    expect(getOuterTestReceipt(fixture.db, fixture.taskId)).toBeNull();
  });

  it("RSS limit terminates the entire detached verifier process group", async () => {
    const fixture = resourceFixture("rss");
    const adapter = createDefaultHostVerifierRuntimeAdapter(
      { db: fixture.db, layout: fixture.layout },
      { readPrHead: async () => fixture.commit },
    );
    const launch = createHostVerifierLauncher({ db: fixture.db, layout: fixture.layout }, adapter);
    const started = launch(
      { ...request(fixture), level: "smoke" },
      smokePlan({ wallTimeoutMs: 10_000, maxRssMb: 1 }),
    );
    await started.settled;
    const job = getJob(fixture.db, started.jobId)!;
    expect(job.state).toBe("killed");
    expect(job.summary).toMatchObject({ killedBy: "rss" });
    expect(job.pgid).toBeGreaterThan(0);
    expect(await waitForGroupGone(job.pgid!)).toBe(true);
    expect(getOuterTestReceipt(fixture.db, fixture.taskId)).toBeNull();
  }, 15_000);
});
