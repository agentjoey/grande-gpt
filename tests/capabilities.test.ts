import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  McpCapabilityProvider,
  loadCapabilityProviderConfigs,
  type McpConnection,
} from "../src/capabilities.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
let deps: ToolDeps;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "README.md"), "demo\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

function tool(name: string) {
  const found = buildTools(deps).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "cap-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "cap-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  initRepo(join(layout.workspaceRoot, "demo"));
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
  deps = { db: openDb(layout), layout };
});

afterEach(() => {
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("S5 capability layer", () => {
  it("只新增 list / inspect / invoke 三个薄工具，风险注解如实反映外部调用", () => {
    const tools = buildTools(deps);
    const list = tools.find((candidate) => candidate.name === "grande_capability_list")!;
    const inspect = tools.find((candidate) => candidate.name === "grande_capability_inspect")!;
    const invoke = tools.find((candidate) => candidate.name === "grande_capability_invoke")!;
    expect(list).toBeDefined();
    expect(inspect).toBeDefined();
    expect(invoke).toBeDefined();
    expect(list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(inspect.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(invoke.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("native provider 直接复用现有 ToolDef：可 list / inspect / invoke，不复制一套实现", async () => {
    const listEnvelope = (await tool("grande_capability_list").handler({ provider: "native" })).structuredContent as {
      ok: boolean;
      data?: { capabilities?: Array<{ provider: string; name: string }> };
    };
    expect(listEnvelope.ok).toBe(true);
    expect(listEnvelope.data?.capabilities).toContainEqual(
      expect.objectContaining({ provider: "native", name: "grande_task_status" }),
    );

    const inspectEnvelope = (await tool("grande_capability_inspect").handler({
      provider: "native",
      name: "grande_task_status",
    })).structuredContent as { ok: boolean; data?: { capability?: { inputSchema?: unknown } } };
    expect(inspectEnvelope.ok).toBe(true);
    expect(inspectEnvelope.data?.capability?.inputSchema).toBeDefined();

    const invokeEnvelope = (await tool("grande_capability_invoke").handler({
      provider: "native",
      name: "grande_task_status",
      arguments: {},
    })).structuredContent as { ok: boolean; data?: { result?: { ok?: boolean } } };
    expect(invokeEnvelope.ok).toBe(true);
    expect(invokeEnvelope.data?.result?.ok).toBe(true);
  });

  it("capabilities.yaml 是薄 provider 注册表；未知字段、非 https/loopback MCP URL 都 fail closed", () => {
    writeFileSync(
      join(layout.configDir, "capabilities.yaml"),
      "providers:\n  docs:\n    type: skill\n    file: deploy.md\n    risk: read\n",
      "utf8",
    );
    expect(loadCapabilityProviderConfigs(layout)).toEqual([
      expect.objectContaining({ id: "docs", type: "skill", file: "deploy.md", risk: "read" }),
    ]);

    writeFileSync(
      join(layout.configDir, "capabilities.yaml"),
      "providers:\n  bad:\n    type: mcp\n    url: http://example.com/mcp\n    risk: read\n",
      "utf8",
    );
    expect(() => loadCapabilityProviderConfigs(layout)).toThrow(/https|loopback|127\.0\.0\.1|localhost/i);

    writeFileSync(
      join(layout.configDir, "capabilities.yaml"),
      "providers:\n  bad:\n    type: skill\n    file: deploy.md\n    risk: read\n    marketplace: true\n",
      "utf8",
    );
    expect(() => loadCapabilityProviderConfigs(layout)).toThrow(/marketplace|未知字段/);
  });

  it("skill invoke 返回结构化 instructions；production 未由控制平面显式放行时拒绝", async () => {
    mkdirSync(join(layout.controlRoot, "skills"), { recursive: true });
    writeFileSync(join(layout.controlRoot, "skills", "deploy.md"), "# Deploy\nUse the existing deployment tool.\n", "utf8");
    writeFileSync(
      join(layout.configDir, "capabilities.yaml"),
      "providers:\n  deploy-skill:\n    type: skill\n    file: deploy.md\n    risk: production\n",
      "utf8",
    );

    const denied = (await tool("grande_capability_invoke").handler({
      provider: "deploy-skill",
      name: "deploy-skill",
      taskId: "task_missing",
      arguments: {},
    })).structuredContent as { ok: boolean; error?: { code?: string; message?: string } };
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("POLICY_DENIED");
    expect(denied.error?.message).toMatch(/production|allowProduction/i);

    writeFileSync(
      join(layout.configDir, "capabilities.yaml"),
      "providers:\n  deploy-skill:\n    type: skill\n    file: deploy.md\n    risk: production\n    allowProduction: true\n",
      "utf8",
    );
    const opened = (await tool("grande_task_open").handler({
      taskId: "task_capdeploy01",
      slug: "cap-deploy",
      repoId: "demo",
    })).structuredContent as { ok: boolean };
    expect(opened.ok).toBe(true);

    const allowed = (await tool("grande_capability_invoke").handler({
      provider: "deploy-skill",
      name: "deploy-skill",
      taskId: "task_capdeploy01",
      arguments: { environment: "preview" },
    })).structuredContent as { ok: boolean; data?: { result?: { mode?: string; instructions?: string } } };
    expect(allowed.ok).toBe(true);
    expect(allowed.data?.result?.mode).toBe("instructions");
    expect(allowed.data?.result?.instructions).toContain("existing deployment tool");
  });

  it("MCP adapter 分页 discover、inspect schema、callTool structured result，并按远端 annotation 提升风险", async () => {
    const calls: string[] = [];
    const fakeConnect = async (): Promise<McpConnection> => ({
      async listTools(cursor) {
        if (!cursor) {
          return {
            tools: [{
              name: "read-doc",
              description: "read",
              inputSchema: { type: "object", properties: { id: { type: "string" } } },
              annotations: { readOnlyHint: true, destructiveHint: false },
            }],
            nextCursor: "p2",
          };
        }
        return {
          tools: [{
            name: "delete-doc",
            description: "delete",
            inputSchema: { type: "object", properties: { id: { type: "string" } } },
            annotations: { readOnlyHint: false, destructiveHint: true },
          }],
        };
      },
      async callTool(name, args) {
        calls.push(`${name}:${String(args.id)}`);
        return { isError: false, structuredContent: { deleted: args.id } };
      },
      async close() {},
    });

    const provider = new McpCapabilityProvider(
      { id: "remote", type: "mcp", url: "https://example.com/mcp", risk: "read", allowDestructive: true },
      fakeConnect,
    );
    const listed = await provider.list();
    expect(listed.map((item) => [item.name, item.risk])).toEqual([
      ["read-doc", "read"],
      ["delete-doc", "destructive"],
    ]);
    expect((await provider.inspect("read-doc")).inputSchema).toMatchObject({ type: "object" });
    expect(await provider.invoke("delete-doc", { id: "42" })).toMatchObject({ structuredContent: { deleted: "42" } });
    expect(calls).toEqual(["delete-doc:42"]);
  });
});
