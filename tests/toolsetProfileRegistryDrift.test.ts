import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { buildTools, TOOLSET_EPOCH, toolsetIdentity, type ToolDeps } from "../src/tools.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function initRepo(repoId: string): void {
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
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
}

function tool(name: string) {
  const found = buildTools(deps).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return (await tool(name).handler(args)).structuredContent as Record<string, any>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "toolset-profile-drift-"));
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

describe("GG-BL-028 profile registry toolset identity", () => {
  it("keeps the hashed contract stable while top-level profile discovery tracks registry changes", async () => {
    initRepo("fresh");
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      "repos:\n  fresh:\n    test:\n      argv: [custom-test]\n      timeoutSeconds: 42\n",
      "utf8",
    );

    const beforeTools = buildTools(deps);
    const beforeRun = beforeTools.find((candidate) => candidate.name === "grande_run")!;
    const beforeIdentity = toolsetIdentity(beforeTools, "same-build");

    const proposal = await call("grande_repo_add_propose", { repoId: "fresh" });
    expect(proposal.ok).toBe(true);
    const applied = await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: proposal.data.proposalDigest,
    });
    expect(applied.ok).toBe(true);

    const afterTools = buildTools(deps);
    const afterRun = afterTools.find((candidate) => candidate.name === "grande_run")!;
    const afterIdentity = toolsetIdentity(afterTools, "same-build");

    expect(afterIdentity.toolsDigest).toBe(beforeIdentity.toolsDigest);
    expect(beforeIdentity.toolsCount).toBe(25);
    expect(afterIdentity.toolsCount).toBe(25);
    expect(TOOLSET_EPOCH).toBe(2);

    const beforeProfileDescription = (beforeRun.inputSchema.properties.profile as { description?: string }).description;
    const afterProfileDescription = (afterRun.inputSchema.properties.profile as { description?: string }).description;
    expect(beforeProfileDescription).toBe("要执行的 profile 名称");
    expect(afterProfileDescription).toBe("要执行的 profile 名称");

    expect(afterRun.description).not.toBe(beforeRun.description);
    expect(afterRun.description).toContain("fresh");
    expect(afterRun.description).toContain("test");
  });
});
