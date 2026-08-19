import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beginAudit, type AuditHandle } from "./audit.ts";
import { ok, err } from "./envelope.ts";
import { redact, StateError, toToolError } from "./errors.ts";
import { applyRepoOnboarding, inspectRepoOnboarding, type RepoOnboardingProposal } from "./onboarding.ts";
import type { ToolDef, ToolDeps } from "./toolsCore.ts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

function fileFingerprint(path: string): string {
  if (!existsSync(path)) return "missing";
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function proposalDigest(deps: ToolDeps, proposal: RepoOnboardingProposal): string {
  const payload = canonicalize({
    proposal,
    controlPlane: {
      reposConfigSha256: fileFingerprint(deps.layout.reposConfig),
      profilesConfigSha256: fileFingerprint(join(deps.layout.configDir, "profiles.yaml")),
    },
  });
  const hex = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  return `sha256:${hex}`;
}

function inspectWithDigest(deps: ToolDeps, repoId: string): { proposal: RepoOnboardingProposal; proposalDigest: string } {
  const proposal = inspectRepoOnboarding(deps.layout, repoId);
  return { proposal, proposalDigest: proposalDigest(deps, proposal) };
}

function failed(deps: ToolDeps, error: unknown): { structuredContent: unknown } {
  const toolError = toToolError(error);
  toolError.message = redact(toolError.message, [deps.layout.workspaceRoot, deps.layout.controlRoot]);
  return { structuredContent: err({ ...toolError, taskId: null }) };
}

function wrap(deps: ToolDeps, fn: () => { data: Record<string, unknown>; hint: string }): { structuredContent: unknown } {
  try {
    const result = fn();
    return { structuredContent: ok({ taskId: null, data: result.data, hint: result.hint }) };
  } catch (error) {
    return failed(deps, error);
  }
}

export function addOnboardingTools(deps: ToolDeps, tools: ToolDef[]): ToolDef[] {
  const propose: ToolDef = {
    name: "grande_repo_add_propose",
    description: "只读检查一个 workspace direct-child Git repo 是否可以安全注册到 GrandeGPT，并返回 readiness 与 proposalDigest；不写控制平面。",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "候选仓库 ID；路径固定从 GRANDE_WORKSPACE/<repoId> 推导，不接受任意绝对路径" },
      },
      required: ["repoId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args) => wrap(deps, () => {
      const { proposal, proposalDigest: digest } = inspectWithDigest(deps, args.repoId as string);
      return {
        data: { ...proposal, proposalDigest: digest },
        hint: proposal.readyToRegister
          ? `仓库 ${proposal.repoId} readiness 已通过；请由 Human Owner 明确确认后再调用 grande_repo_add_apply。`
          : `仓库 ${proposal.repoId} 尚未满足注册 readiness；先处理 blocker 后重新 propose。`,
      };
    }),
  };

  const apply: ToolDef = {
    name: "grande_repo_add_apply",
    description: "在 Human Owner 已明确确认后注册仓库。执行前重新检查 proposal/readiness 与可信控制平面 pre-state；stale 或 blocked 时 fail closed。",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "要注册的仓库 ID；必须与已确认 proposal 一致" },
        proposalDigest: { type: "string", description: "最近一次 grande_repo_add_propose 返回并由 Human Owner 确认的 proposalDigest" },
      },
      required: ["repoId", "proposalDigest"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    handler: async (args) => {
      const repoId = args.repoId as string;
      const expectedDigest = args.proposalDigest as string;
      let audit: AuditHandle | undefined;
      try {
        const current = inspectWithDigest(deps, repoId);
        if (current.proposalDigest !== expectedDigest) {
          throw new StateError("STALE_STATE", "Repository onboarding proposal is stale; run grande_repo_add_propose again.");
        }
        if (!current.proposal.readyToRegister) {
          throw new StateError(
            "INVALID_INPUT",
            `Repository is not ready for GrandeGPT development lifecycle: ${current.proposal.blockingReasons.join(" ")}`,
          );
        }

        audit = beginAudit(deps.db, {
          taskId: null,
          tool: "grande_repo_add_apply",
          input: { repoId, proposalDigest: expectedDigest },
        });
        audit.allowed();
        if (!audit.executing()) {
          throw new StateError("STALE_STATE", `仓库 ${repoId} 的注册审计句柄无法推进到 EXECUTING。`);
        }

        applyRepoOnboarding(deps.layout, current.proposal);
        const touched = [deps.layout.reposConfig];
        if (current.proposal.profiles.length > 0 || current.proposal.cloneNodeModules) {
          touched.push(join(deps.layout.configDir, "profiles.yaml"));
        }
        audit.succeeded(touched);
        return {
          structuredContent: ok({
            taskId: null,
            data: { repoId, registered: true },
            hint: `仓库 ${repoId} 已注册；可用 grande_task_status / grande_task_open 验证并进入现有 Golden Path。`,
          }),
        };
      } catch (error) {
        audit?.failed(error instanceof Error ? error.message : String(error));
        return failed(deps, error);
      }
    },
  };

  return [...tools, propose, apply];
}
