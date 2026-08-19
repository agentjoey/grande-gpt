import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { loadProfiles } from "../src/profiles.ts";
import { loadRegistry } from "../src/registry.ts";
import { buildTools, TOOLSET_EPOCH, toolsetIdentity, type ToolDef, type ToolDeps } from "../src/tools.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function initRepo(repoId: string, commit = true): string {
  const repo = join(layout.workspaceRoot, repoId);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.33.0",
    scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
  }, null, 2), "utf8");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  if (commit) {
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
  }
  return repo;
}

function fileOrMissing(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "<missing>";
}

function tool(name: string): ToolDef {
  const found = buildTools(deps).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return (await tool(name).handler(args)).structuredContent as Record<string, any>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "onboarding-tools-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  layout = loadLayout();
  ensureLayout(layout);
  deps = { db: openDb(layout), layout };
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("ChatGPT repository onboarding tools", () => {
  it("registers exactly the approved propose/apply schemas and annotations", () => {
    initRepo("fresh");
    const tools = buildTools(deps);
    const propose = tools.find((candidate) => candidate.name === "grande_repo_add_propose")!;
    const apply = tools.find((candidate) => candidate.name === "grande_repo_add_apply")!;

    expect(propose).toBeDefined();
    expect(propose.inputSchema.required).toEqual(["repoId"]);
    expect(Object.keys(propose.inputSchema.properties)).toEqual(["repoId"]);
    expect(propose.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

    expect(apply).toBeDefined();
    expect(apply.inputSchema.required?.slice().sort()).toEqual(["proposalDigest", "repoId"]);
    expect(Object.keys(apply.inputSchema.properties).sort()).toEqual(["proposalDigest", "repoId"]);
    expect(apply.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });

    expect(tools).toHaveLength(25);
    expect(TOOLSET_EPOCH).toBe(2);
    const identity = toolsetIdentity(tools, "test-build");
    expect(identity.toolsCount).toBe(25);
    expect(identity.toolsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(identity.toolsDigest).not.toBe("sha256:55b20104f7a00770cd6ea0f33ec948fcabd602ce397ec534f5a7699e912e287a");
  });

  it("proposal is zero-write and returns deterministic readiness plus proposalDigest", async () => {
    initRepo("fresh");
    const profilesPath = join(layout.configDir, "profiles.yaml");
    const reposBefore = fileOrMissing(layout.reposConfig);
    const profilesBefore = fileOrMissing(profilesPath);

    const first = await call("grande_repo_add_propose", { repoId: "fresh" });
    const second = await call("grande_repo_add_propose", { repoId: "fresh" });

    expect(first.ok).toBe(true);
    expect(first.data.readyToRegister).toBe(true);
    expect(first.data.git.headExists).toBe(true);
    expect(first.data.git.branch).toBe("main");
    expect(first.data.proposalDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.data.proposalDigest).toBe(first.data.proposalDigest);
    expect(fileOrMissing(layout.reposConfig)).toBe(reposBefore);
    expect(fileOrMissing(profilesPath)).toBe(profilesBefore);
  });

  it("matching apply registers the repo, preserves trusted profiles, and unlocks task lifecycle", async () => {
    initRepo("fresh");
    const profilesPath = join(layout.configDir, "profiles.yaml");
    writeFileSync(profilesPath,
      "repos:\n  fresh:\n    test:\n      argv: [custom-test]\n      timeoutSeconds: 42\n",
      "utf8",
    );

    const beforeOpen = await call("grande_task_open", { taskId: "task_before", slug: "before", repoId: "fresh" });
    expect(beforeOpen.ok).toBe(false);

    const proposal = await call("grande_repo_add_propose", { repoId: "fresh" });
    const applied = await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: proposal.data.proposalDigest,
    });

    expect(applied.ok).toBe(true);
    expect(loadRegistry(layout).get("fresh")?.registered).toBe(true);
    expect(loadProfiles(layout, "fresh").get("test")?.argv).toEqual(["custom-test"]);
    expect(loadProfiles(layout, "fresh").get("typecheck")?.argv).toEqual(["pnpm", "run", "typecheck"]);

    const opened = await call("grande_task_open", { taskId: "task_probe", slug: "probe", repoId: "fresh" });
    expect(opened.ok).toBe(true);
    const closed = await call("grande_task_close", { taskId: "task_probe" });
    expect(closed.ok).toBe(true);
  });

  it("fresh second propose/apply is idempotent and preserves pre-existing trusted profile definitions", async () => {
    initRepo("fresh");
    const profilesPath = join(layout.configDir, "profiles.yaml");
    writeFileSync(profilesPath,
      "repos:\n  fresh:\n    test:\n      argv: [custom-test]\n      timeoutSeconds: 42\n",
      "utf8",
    );

    const first = await call("grande_repo_add_propose", { repoId: "fresh" });
    expect((await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: first.data.proposalDigest,
    })).ok).toBe(true);
    const profilesAfterFirst = fileOrMissing(profilesPath);

    const second = await call("grande_repo_add_propose", { repoId: "fresh" });
    expect(second.data.alreadyRegistered).toBe(true);
    expect((await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: second.data.proposalDigest,
    })).ok).toBe(true);

    expect(fileOrMissing(profilesPath)).toBe(profilesAfterFirst);
    expect(loadProfiles(layout, "fresh").get("test")?.argv).toEqual(["custom-test"]);
    expect(loadRegistry(layout).get("fresh")?.registered).toBe(true);
  });

  it("stale control-plane state fails before mutation", async () => {
    initRepo("fresh");
    const proposal = await call("grande_repo_add_propose", { repoId: "fresh" });
    const profilesPath = join(layout.configDir, "profiles.yaml");
    writeFileSync(profilesPath, "repos: {}\n# trusted edit after proposal\n", "utf8");
    const reposBeforeApply = fileOrMissing(layout.reposConfig);
    const profilesBeforeApply = fileOrMissing(profilesPath);

    const applied = await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: proposal.data.proposalDigest,
    });

    expect(applied.ok).toBe(false);
    expect(applied.error?.retryable).toBe(true);
    expect(fileOrMissing(layout.reposConfig)).toBe(reposBeforeApply);
    expect(fileOrMissing(profilesPath)).toBe(profilesBeforeApply);
  });

  it("stale repository HEAD fails before mutation", async () => {
    const repo = initRepo("fresh");
    const proposal = await call("grande_repo_add_propose", { repoId: "fresh" });
    writeFileSync(join(repo, "second.txt"), "second\n", "utf8");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "second");
    const reposBeforeApply = fileOrMissing(layout.reposConfig);

    const applied = await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: proposal.data.proposalDigest,
    });

    expect(applied.ok).toBe(false);
    expect(fileOrMissing(layout.reposConfig)).toBe(reposBeforeApply);
  });

  it("matching proposal for a no-HEAD repository is still blocked with zero writes", async () => {
    initRepo("fresh", false);
    const proposal = await call("grande_repo_add_propose", { repoId: "fresh" });
    expect(proposal.ok).toBe(true);
    expect(proposal.data.readyToRegister).toBe(false);
    expect(proposal.data.git.headExists).toBe(false);
    const reposBeforeApply = fileOrMissing(layout.reposConfig);

    const applied = await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: proposal.data.proposalDigest,
    });

    expect(applied.ok).toBe(false);
    expect(fileOrMissing(layout.reposConfig)).toBe(reposBeforeApply);
  });

  it("detached canonical is reported blocked and matching apply stays zero-write", async () => {
    const repo = initRepo("fresh");
    const sha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", sha);

    const proposal = await call("grande_repo_add_propose", { repoId: "fresh" });
    expect(proposal.ok).toBe(true);
    expect(proposal.data.readyToRegister).toBe(false);
    expect(proposal.data.git.detached).toBe(true);
    const reposBeforeApply = fileOrMissing(layout.reposConfig);

    const applied = await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: proposal.data.proposalDigest,
    });
    expect(applied.ok).toBe(false);
    expect(fileOrMissing(layout.reposConfig)).toBe(reposBeforeApply);
  });

  it("canonical busy marker is reported blocked and matching apply stays zero-write", async () => {
    const repo = initRepo("fresh");
    writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${"0".repeat(40)}\n`, "utf8");

    const proposal = await call("grande_repo_add_propose", { repoId: "fresh" });
    expect(proposal.ok).toBe(true);
    expect(proposal.data.readyToRegister).toBe(false);
    expect(proposal.data.git.busy).toBe(true);
    expect(proposal.data.git.busyReasons).toContain("MERGE_HEAD");
    const reposBeforeApply = fileOrMissing(layout.reposConfig);

    const applied = await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: proposal.data.proposalDigest,
    });
    expect(applied.ok).toBe(false);
    expect(fileOrMissing(layout.reposConfig)).toBe(reposBeforeApply);
  });

  it("symlink candidate reuses S9 path security and never becomes a registrable alias", async () => {
    const real = initRepo("real");
    symlinkSync(real, join(layout.workspaceRoot, "alias"), "dir");
    const reposBefore = fileOrMissing(layout.reposConfig);

    const proposal = await call("grande_repo_add_propose", { repoId: "alias" });
    expect(proposal.ok).toBe(false);
    expect(fileOrMissing(layout.reposConfig)).toBe(reposBefore);
    expect(loadRegistry(layout).has("alias")).toBe(false);
  });
});
