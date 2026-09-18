import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import * as toolsModule from "../src/tools.ts";
import type { ToolDef, ToolDeps } from "../src/tools.ts";

const noop = async () => ({ structuredContent: { ok: true } });

function tool(
  name: string,
  inputSchema: ToolDef["inputSchema"],
  annotations: ToolDef["annotations"],
): ToolDef {
  return { name, description: `${name} description`, inputSchema, annotations, handler: noop };
}

const contractJson = (tools: ToolDef[]): string => JSON.stringify(tools.map((t) => ({
  name: t.name,
  inputSchema: t.inputSchema,
  annotations: t.annotations,
})));

describe("toolset identity", () => {
  it("is deterministic across tool/schema/object order and changes only when the contract changes", () => {
    const identity = (toolsModule as unknown as {
      toolsetIdentity?: (tools: ToolDef[], gatewayBuild?: string) => {
        gatewayBuild: string;
        toolsetEpoch: number;
        toolsCount: number;
        toolsDigest: string;
      };
    }).toolsetIdentity;

    expect(identity, "src/tools.ts should expose the shared toolset identity helper").toBeTypeOf("function");

    const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
    const a = tool("grande_a", {
      type: "object",
      properties: {
        alpha: { type: "string", description: "a" },
        beta: { type: "number", description: "b" },
      },
      required: ["alpha"],
    }, ro);
    const b = tool("grande_b", {
      type: "object",
      properties: { taskId: { type: "string" } },
    }, write);

    const reorderedA = tool("grande_a", {
      required: ["alpha"],
      properties: {
        beta: { description: "b", type: "number" },
        alpha: { description: "a", type: "string" },
      },
      type: "object",
    } as ToolDef["inputSchema"], {
      openWorldHint: false,
      destructiveHint: false,
      readOnlyHint: true,
    });
    const descriptionChangedA = {
      ...a,
      description: "description changed without changing the tool contract",
    };

    const first = identity!([b, a], "build-abc");
    const sameContract = identity!([reorderedA, b], "build-abc");
    const sameContractNewBuild = identity!([a, b], "build-def");
    const sameContractNewDescription = identity!([descriptionChangedA, b], "build-abc");
    const changedContract = identity!([
      b,
      tool("grande_a", {
        type: "object",
        properties: {
          alpha: { type: "string", description: "a" },
          beta: { type: "boolean", description: "b" },
        },
        required: ["alpha"],
      }, ro),
    ], "build-abc");

    expect(first).toMatchObject({ gatewayBuild: "build-abc", toolsCount: 2 });
    expect(first.toolsetEpoch).toBeGreaterThan(0);
    expect(first.toolsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sameContract.toolsDigest).toBe(first.toolsDigest);
    expect(sameContractNewBuild.toolsDigest).toBe(first.toolsDigest);
    expect(sameContractNewDescription.toolsDigest).toBe(first.toolsDigest);
    expect(changedContract.toolsDigest).not.toBe(first.toolsDigest);
  });

  it("normalizes the actual tools/list registration snapshot across tool, object, and required order", () => {
    const stable = (toolsModule as unknown as {
      stableToolDefinitions?: (tools: ToolDef[]) => ToolDef[];
    }).stableToolDefinitions;
    expect(stable, "src/tools.ts should expose stableToolDefinitions for wire registration").toBeTypeOf("function");

    const annotationsA = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    const annotationsB = {
      openWorldHint: false,
      destructiveHint: false,
      readOnlyHint: true,
    } as ToolDef["annotations"];
    const firstA = tool("grande_a", {
      type: "object",
      properties: {
        alpha: { type: "string", description: "a" },
        beta: { type: "number", description: "b" },
      },
      required: ["beta", "alpha"],
    }, annotationsA);
    const reorderedA = tool("grande_a", {
      required: ["alpha", "beta"],
      properties: {
        beta: { description: "b", type: "number" },
        alpha: { description: "a", type: "string" },
      },
      type: "object",
    } as ToolDef["inputSchema"], annotationsB);
    const b = tool("grande_b", {
      type: "object",
      properties: { taskId: { type: "string" } },
    }, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });

    const one = stable!([b, firstA]);
    const two = stable!([reorderedA, b]);

    expect(one.map((t) => t.name)).toEqual(["grande_a", "grande_b"]);
    expect(contractJson(one)).toBe(contractJson(two));
    expect(one[0]?.inputSchema.required).toEqual(["alpha", "beta"]);
    expect(Object.keys(one[0]?.inputSchema.properties ?? {})).toEqual(["alpha", "beta"]);
  });

  it("uses explicit build id when provided, otherwise identifies the running checkout by Git HEAD", () => {
    const buildIdentity = (toolsModule as unknown as {
      gatewayBuildIdentity?: (env?: NodeJS.ProcessEnv, cwd?: string) => string;
    }).gatewayBuildIdentity;
    expect(buildIdentity).toBeTypeOf("function");
    expect(buildIdentity!({ GRANDE_GATEWAY_BUILD: " release-42 " } as NodeJS.ProcessEnv, process.cwd()))
      .toBe("release-42");
    expect(buildIdentity!({} as NodeJS.ProcessEnv, process.cwd())).toMatch(/^git:[0-9a-f]{40}$/);
  });
});

/** Batch 2 deliberately changes only status inputs and the new task/job-bound cancellation tool. */
describe("Batch 2 candidate epoch/digest and public surface", () => {
  const CLOSEOUT_EPOCH = 4;
  const CLOSEOUT_DIGEST = "sha256:59cac26abfb8a571d321e00bc5a7d6c7bd5d4950ef686235a51a70eb635fa387";
  const CLOSEOUT_TOOLS_COUNT = 26;

  let root: string;
  let layout: Layout;
  let deps: ToolDeps;
  let savedWs: string | undefined;
  let savedCtrl: string | undefined;

  beforeEach(() => {
    savedWs = process.env.GRANDE_WORKSPACE;
    savedCtrl = process.env.GRANDE_CONTROL;
    root = mkdtempSync(join(tmpdir(), "toolset-closeout-"));
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
    if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
    if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
    rmSync(root, { recursive: true, force: true });
  });

  it("pins the assembled epoch-4 candidate contract independently of activation", () => {
    const identity = toolsModule.toolsetIdentity(toolsModule.buildTools(deps), "batch2-candidate-build");
    expect(identity).toEqual({
      gatewayBuild: "batch2-candidate-build",
      toolsetEpoch: CLOSEOUT_EPOCH,
      toolsCount: CLOSEOUT_TOOLS_COUNT,
      toolsDigest: CLOSEOUT_DIGEST,
    });
    expect(toolsModule.TOOLSET_EPOCH).toBe(CLOSEOUT_EPOCH);
  });

  it("preserves deliveryTarget and exposes no public argv/approval/nonce tools", () => {
    const tools = toolsModule.buildTools(deps);
    const open = tools.find((t) => t.name === "grande_task_open")!;
    const deliveryTarget = open.inputSchema.properties.deliveryTarget as
      | { type?: string; enum?: string[] }
      | undefined;
    expect(deliveryTarget).toMatchObject({ type: "string", enum: ["local", "pr", "deploy"] });
    expect(open.inputSchema.required ?? []).not.toContain("deliveryTarget");

    const names = tools.map((t) => t.name);
    expect(names).toContain("grande_deploy_verify");
    for (const name of names) {
      expect(name).not.toMatch(/argv|nonce|approv/i);
    }
  });

  it("reconstructs the exact epoch-3 contract by removing only the two approved public deltas", () => {
    const previous = toolsModule.buildTools(deps).filter((tool) => tool.name !== "grande_job_cancel")
      .map((tool) => tool.name === "grande_task_status" ? { ...tool, inputSchema: {
        type: "object" as const, properties: {
          taskId: { type: "string", description: "任务ID。不传则返回已注册仓库 + 活跃任务总览" },
        },
      } } : tool);
    const identity = toolsModule.toolsetIdentity(previous, "historical-contract-fixture");
    expect(identity.toolsCount).toBe(25);
    expect(identity.toolsDigest).toBe("sha256:d5243888a58a440b05147d8e5baeb3713e92833720c5dd403901493ff555b496");
  });
});
