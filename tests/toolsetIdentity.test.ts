import { describe, expect, it } from "vitest";
import * as toolsModule from "../src/tools.ts";
import type { ToolDef } from "../src/tools.ts";

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

    const first = identity!([b, a], "build-abc");
    const sameContract = identity!([reorderedA, b], "build-abc");
    const sameContractNewBuild = identity!([a, b], "build-def");
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
