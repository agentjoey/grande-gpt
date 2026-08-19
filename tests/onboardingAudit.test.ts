import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "onboarding-audit-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  layout = loadLayout();
  ensureLayout(layout);
  deps = { db: openDb(layout), layout };

  const repo = join(layout.workspaceRoot, "fresh");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.33.0",
    scripts: { test: "vitest run" },
  }), "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = saved.ctrl;
});

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === name)!;
  return (await tool.handler(args)).structuredContent as Record<string, any>;
}

describe("grande_repo_add_apply audit", () => {
  it("successful trusted control-plane write is recorded as ALLOWED/SUCCEEDED with taskId=null", async () => {
    const proposal = await call("grande_repo_add_propose", { repoId: "fresh" });
    expect(proposal.ok).toBe(true);

    const applied = await call("grande_repo_add_apply", {
      repoId: "fresh",
      proposalDigest: proposal.data.proposalDigest,
    });
    expect(applied.ok).toBe(true);

    const row = listAudit(deps.db).find((candidate) => candidate.tool === "grande_repo_add_apply");
    expect(row).toBeDefined();
    expect(row?.taskId).toBeNull();
    expect(row?.decision).toBe("ALLOWED");
    expect(row?.state).toBe("SUCCEEDED");
    expect(row?.pathsTouched).toContain(layout.reposConfig);
    expect(row?.pathsTouched).toContain(join(layout.configDir, "profiles.yaml"));
  });
});
