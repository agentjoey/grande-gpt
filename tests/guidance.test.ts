import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const TASK_ID = "task_guidance_test";

let workspaceRoot: string;
let controlRoot: string;
let layout: Layout;
let deps: ToolDeps;
let previousWorkspace: string | undefined;
let previousControl: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function openTask(): Promise<Record<string, any>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_task_open");
  if (!tool) throw new Error("grande_task_open 未注册");
  const result = await tool.handler({ taskId: TASK_ID, slug: "guidance", repoId: "demo" });
  return result.structuredContent as Record<string, any>;
}

beforeEach(() => {
  previousWorkspace = process.env.GRANDE_WORKSPACE;
  previousControl = process.env.GRANDE_CONTROL;
  workspaceRoot = mkdtempSync(join(tmpdir(), "grande-guidance-ws-"));
  controlRoot = mkdtempSync(join(tmpdir(), "grande-guidance-ctl-"));
  process.env.GRANDE_WORKSPACE = workspaceRoot;
  process.env.GRANDE_CONTROL = controlRoot;

  layout = loadLayout();
  ensureLayout(layout);
  const repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "guidance@example.com");
  git(repo, "config", "user.name", "Guidance Test");
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(
    layout.reposConfig,
    `repos:\n  - repoId: demo\n    path: ${repo}\n    registered: true\n`,
    "utf8",
  );
  deps = { db: openDb(layout), layout };
});

afterEach(() => {
  deps.db.close();
  if (previousWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = previousWorkspace;
  if (previousControl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = previousControl;
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(controlRoot, { recursive: true, force: true });
});

describe("grande_task_open guidance", () => {
  it("AC-S15-7：配置了 repo guidance 时，成功响应逐字返回纯文本", async () => {
    const guidance = "先写失败测试。\n用 grande_run 执行 unit-selfhost。\n$(不要执行这段文本)";
    writeFileSync(
      join(layout.configDir, "guidance.yaml"),
      `repos:\n  demo: ${JSON.stringify(guidance)}\n`,
      "utf8",
    );

    const result = await openTask();

    expect(result.ok).toBe(true);
    expect(result.data.guidance).toBe(guidance);
    expect(result.data.taskId).toBe(TASK_ID);
  });

  it("guidance.yaml 存在但当前 repo 没配置时，不带 guidance 且正常建任务", async () => {
    writeFileSync(
      join(layout.configDir, "guidance.yaml"),
      'repos:\n  other: "只属于另一个仓库"\n',
      "utf8",
    );

    const result = await openTask();

    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty("guidance");
  });

  it("guidance.yaml 不存在时不报错、不带 guidance，也没有新增工具", async () => {
    expect(buildTools(deps)).toHaveLength(11);

    const result = await openTask();

    expect(result.ok).toBe(true);
    expect(result.data).not.toHaveProperty("guidance");
  });
});
