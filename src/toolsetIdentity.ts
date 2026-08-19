import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ToolDef } from "./toolsCore.ts";

/**
 * ChatGPT-side tool snapshot compatibility epoch.
 *
 * Bump this value ONLY when the externally visible MCP tool contract changes
 * (tool name, input schema, or annotations). Ordinary implementation/build
 * patches keep the same epoch.
 */
export const TOOLSET_EPOCH = 1;

export interface ToolsetIdentity {
  gatewayBuild: string;
  toolsetEpoch: number;
  toolsCount: number;
  toolsDigest: string;
}

type ToolContract = Pick<ToolDef, "name" | "inputSchema" | "annotations">;

/**
 * JSON object key order is not contract meaning, and JSON Schema `required`
 * is a set. Normalize those two dimensions so implementation/registration
 * order cannot create a meaningless ChatGPT tool snapshot diff.
 *
 * Other arrays (oneOf, items, examples, etc.) retain their order because
 * reordering them can carry author intent or validation semantics.
 */
function canonicalize(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => canonicalize(item));
    if (parentKey === "required" && normalized.every((item) => typeof item === "string")) {
      return [...normalized].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return normalized;
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key], key);
    return out;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Normalize the ToolDefs that feed MCP registerTool/tools/list. Handler and
 * description are preserved; only externally visible contract ordering is
 * canonicalized. The returned array is a clone, so assembly-time wiring is
 * not mutated after it has captured its dependencies.
 */
export function stableToolDefinitions(tools: ToolDef[]): ToolDef[] {
  return tools
    .map((tool) => ({
      ...tool,
      inputSchema: canonicalize(tool.inputSchema) as ToolDef["inputSchema"],
      annotations: canonicalize(tool.annotations) as ToolDef["annotations"],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

let cachedGitBuild: { cwd: string; value: string } | undefined;

/**
 * Gateway build identity is intentionally independent from TOOLSET_EPOCH.
 *
 * A release system may set GRANDE_GATEWAY_BUILD explicitly. Otherwise the
 * running checkout's exact Git HEAD is used, which makes a normal production
 * Gateway restart pick up the actual code identity without requiring a new
 * LaunchAgent field. The process-wide lookup is cached after the first success;
 * changing files under a running process does not silently change its identity.
 */
export function gatewayBuildIdentity(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured = env.GRANDE_GATEWAY_BUILD?.trim();
  if (configured) return configured;

  if (env === process.env && cachedGitBuild?.cwd === cwd) return cachedGitBuild.value;
  try {
    const head = execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", "HEAD"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (/^[0-9a-f]{40}$/i.test(head)) {
      const value = `git:${head.toLowerCase()}`;
      if (env === process.env) cachedGitBuild = { cwd, value };
      return value;
    }
  } catch {
    // A source archive/container without .git is valid; explicit fallback below.
  }
  return "dev";
}

/**
 * Deterministic identity of the externally relevant tool contract.
 * Tool descriptions and handlers are deliberately excluded: the compatibility
 * contract requested here is exactly name + input schema + annotations.
 */
export function toolsetIdentity(
  tools: ToolContract[],
  gatewayBuild = gatewayBuildIdentity(),
): ToolsetIdentity {
  const contracts = tools
    .map((tool) => ({
      name: tool.name,
      inputSchema: canonicalize(tool.inputSchema),
      annotations: canonicalize(tool.annotations),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const hex = createHash("sha256").update(stableJson(contracts), "utf8").digest("hex");
  return {
    gatewayBuild,
    toolsetEpoch: TOOLSET_EPOCH,
    toolsCount: contracts.length,
    toolsDigest: `sha256:${hex}`,
  };
}
