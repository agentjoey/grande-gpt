import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let root: string;
let layout: Layout;
let deps: ToolDeps;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cap-wire-"));
  const workspace = join(root, "workspace");
  const control = join(root, "control");
  mkdirSync(join(workspace, "demo"), { recursive: true });
  mkdirSync(control, { recursive: true });
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
  layout = loadLayout();
  ensureLayout(layout);
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
  deps = { db: openDb(layout), layout, defaultRepoId: "demo" };
});

afterEach(() => {
  deps.db.close();
  rmSync(root, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("Phase 4 capability wiring", () => {
  it("native discovery 包含后接入的 S7 deployment 与 S9 onboarding tools，但不递归暴露 capability tools 自己", async () => {
    const list = buildTools(deps).find((tool) => tool.name === "grande_capability_list")!;
    const envelope = (await list.handler({ provider: "native" })).structuredContent as {
      ok: boolean;
      data?: { capabilities?: Array<{ name: string }> };
    };
    const names = envelope.data?.capabilities?.map((item) => item.name) ?? [];
    expect(envelope.ok).toBe(true);
    expect(names).toContain("grande_deploy");
    expect(names).toContain("grande_deploy_verify");
    expect(names).toContain("grande_deploy_rollback");
    expect(names).toContain("grande_repo_add_propose");
    expect(names).toContain("grande_repo_add_apply");
    expect(names).not.toContain("grande_capability_list");
    expect(names).not.toContain("grande_capability_invoke");
  });

  it("selfhost-safe manifest 精确钉住 25 tools / 10 open-world / 5 destructive", () => {
    const tools = buildTools(deps);
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "grande_capability_inspect",
      "grande_capability_invoke",
      "grande_capability_list",
      "grande_commit",
      "grande_deploy",
      "grande_deploy_rollback",
      "grande_deploy_verify",
      "grande_diff",
      "grande_pr_merge",
      "grande_pr_open",
      "grande_pr_status",
      "grande_push",
      "grande_repo_add_apply",
      "grande_repo_add_propose",
      "grande_repo_edit",
      "grande_repo_map",
      "grande_repo_read",
      "grande_repo_search",
      "grande_rollback",
      "grande_run",
      "grande_run_result",
      "grande_sync_base",
      "grande_task_close",
      "grande_task_open",
      "grande_task_status",
    ]);

    expect(tools.filter((tool) => tool.annotations.openWorldHint).map((tool) => tool.name).sort()).toEqual([
      "grande_capability_inspect",
      "grande_capability_invoke",
      "grande_capability_list",
      "grande_deploy",
      "grande_deploy_rollback",
      "grande_deploy_verify",
      "grande_pr_merge",
      "grande_pr_open",
      "grande_pr_status",
      "grande_push",
    ]);
    expect(tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name).sort()).toEqual([
      "grande_capability_invoke",
      "grande_deploy",
      "grande_deploy_rollback",
      "grande_pr_merge",
      "grande_task_close",
    ]);
  });
});
