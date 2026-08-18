import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadCapabilityProviderConfigs,
  McpCapabilityProvider,
  type CapabilityProviderConfig,
  type CapabilityRisk,
} from "./capabilities.ts";
import { inspectCanonicalGitState, type CanonicalGitState } from "./canonicalGit.ts";
import { loadDeploymentSpec, type DeploymentAction } from "./deployment.ts";
import { createGithubApi } from "./githubApi.ts";
import { loadGithubToken } from "./githubAuth.ts";
import type { Layout } from "./layout.ts";
import { resolveRepoPath } from "./paths.ts";
import { parseGithubRemote } from "./prOpen.ts";
import { getProfile, loadProfiles } from "./profiles.ts";
import { loadRegistry } from "./registry.ts";

export interface ReadinessCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReadinessGroup {
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface ProjectReadiness {
  repoId: string;
  development: ReadinessGroup;
  prCi: ReadinessGroup;
  deploy: ReadinessGroup;
  gateway: ReadinessCheck;
}

export interface ProjectReadinessOptions {
  sandboxAvailable?: () => boolean;
  readRemote?: (repoPath: string) => string | null;
  readHead?: (repoPath: string) => string;
  githubProbe?: (owner: string, repo: string, head: string, token: string) => Promise<string>;
  gatewayProbe?: () => Promise<string>;
  capabilityProbe?: (action: Extract<DeploymentAction, { kind: "capability" }>, role: DeploymentRole) => Promise<string>;
}

type DeploymentRole = "deploy" | "verify" | "rollback";

function group(checks: ReadinessCheck[]): ReadinessGroup {
  return { ready: checks.every((check) => check.ok), checks };
}

function localGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function defaultReadRemote(repoPath: string): string | null {
  try {
    return localGit(repoPath, ["remote", "get-url", "origin"]) || null;
  } catch {
    return null;
  }
}

function defaultReadHead(repoPath: string): string {
  return localGit(repoPath, ["rev-parse", "HEAD"]);
}

async function defaultGithubProbe(owner: string, repo: string, head: string, token: string): Promise<string> {
  const api = createGithubApi(token);
  const [checks, statuses] = await Promise.all([
    api.listCheckRuns(owner, repo, head),
    api.listCommitStatuses(owner, repo, head),
  ]);
  return `Checks/Actions + Statuses access OK (${checks.length} checks, ${statuses.length} statuses)`;
}

function expectedRisk(role: DeploymentRole, risk: CapabilityRisk): boolean {
  if (role === "deploy") return risk === "production";
  if (role === "verify") return risk === "read";
  return risk === "production" || risk === "destructive";
}

function configuredRiskAllowed(config: CapabilityProviderConfig, risk: CapabilityRisk): boolean {
  if (risk === "destructive" && config.allowDestructive !== true) return false;
  if (risk === "production" && config.allowProduction !== true) return false;
  return true;
}

function safeSkillFile(layout: Layout, config: Extract<CapabilityProviderConfig, { type: "skill" }>): boolean {
  const root = resolve(layout.controlRoot, "skills");
  const candidate = resolve(root, config.file);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(candidate)) return false;
  try {
    const actual = realpathSync(candidate);
    const actualRel = relative(root, actual);
    return actualRel !== ".." && !actualRel.startsWith(`..${sep}`) && !isAbsolute(actualRel);
  } catch {
    return false;
  }
}

async function defaultCapabilityProbe(
  layout: Layout,
  action: Extract<DeploymentAction, { kind: "capability" }>,
  role: DeploymentRole,
): Promise<string> {
  const config = loadCapabilityProviderConfigs(layout).find((candidate) => candidate.id === action.provider);
  if (!config) throw new Error(`provider ${action.provider} 未在可信控制平面注册`);

  if (config.type === "skill") {
    if (action.name !== config.id) throw new Error(`skill provider ${config.id} 的 capability 名必须是 ${config.id}`);
    if (!safeSkillFile(layout, config)) throw new Error(`skill provider ${config.id} 的受信文件不存在或越界`);
    if (!expectedRisk(role, config.risk)) throw new Error(`${role} capability risk=${config.risk} 不符合角色要求`);
    if (!configuredRiskAllowed(config, config.risk)) throw new Error(`${config.id} 未显式放行 ${config.risk} 风险`);
    return `skill ${config.id} configured`;
  }

  const provider = new McpCapabilityProvider(config, undefined, layout);
  const detail = await provider.inspect(action.name);
  provider.assertAllowed(detail);
  if (!expectedRisk(role, detail.risk)) throw new Error(`${role} capability risk=${detail.risk} 不符合角色要求`);
  return `${detail.kind} ${action.provider}/${action.name} inspect OK (risk=${detail.risk})`;
}

async function deploymentChecks(
  layout: Layout,
  repoPath: string,
  repoId: string,
  options: ProjectReadinessOptions,
): Promise<ReadinessGroup> {
  const path = join(repoPath, ".grande", "deploy.yaml");
  if (!existsSync(path)) {
    return group([{ label: "deploy spec", ok: false, detail: ".grande/deploy.yaml 未配置" }]);
  }

  let spec: ReturnType<typeof loadDeploymentSpec>;
  try {
    spec = loadDeploymentSpec(repoPath);
  } catch (error) {
    return group([{ label: "deploy spec", ok: false, detail: error instanceof Error ? error.message : String(error) }]);
  }

  const checks: ReadinessCheck[] = [{ label: "deploy spec", ok: true, detail: ".grande/deploy.yaml 可解析" }];
  const capabilityProbe = options.capabilityProbe ?? ((action, role) => defaultCapabilityProbe(layout, action, role));
  const roles: Array<[DeploymentRole, DeploymentAction | undefined]> = [
    ["deploy", spec.deploy],
    ["verify", spec.verify],
    ["rollback", spec.rollback],
  ];

  for (const [role, action] of roles) {
    if (!action) continue;
    if (action.kind === "profile") {
      try {
        getProfile(layout, repoId, action.profile);
        if (role === "deploy" && !/^deploy(?:-|$)/.test(action.profile)) {
          throw new Error(`deploy.profile=${action.profile} 不是 deploy/deploy-*`);
        }
        if (role === "rollback" && !/^rollback(?:-|$)/.test(action.profile)) {
          throw new Error(`rollback.profile=${action.profile} 不是 rollback/rollback-*`);
        }
        checks.push({ label: `${role} profile`, ok: true, detail: action.profile });
      } catch (error) {
        checks.push({
          label: `${role} profile`,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    try {
      const detail = await capabilityProbe(action, role);
      checks.push({ label: `${role} capability`, ok: true, detail });
    } catch (error) {
      checks.push({
        label: `${role} capability`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return group(checks);
}

function canonicalDetail(state: CanonicalGitState | null, fallback: string): string {
  if (!state) return fallback;
  if (!state.repository) return "不是有效 Git repository";
  if (state.inspectionError !== null) return `canonical Git probe 失败：${state.inspectionError}`;
  if (!state.headExists) return "no baseline commit（HEAD 不存在）";
  if (state.detached) return `detached HEAD @ ${state.headSha?.slice(0, 8) ?? "unknown"}`;
  if (state.busyReasons.length > 0) return `canonical busy: ${state.busyReasons.join(", ")}`;
  return `HEAD ${state.headSha!.slice(0, 8)} on ${state.branch ?? "unknown branch"}；可派生 worktree`;
}

/**
 * 只做 readiness projection：不新增状态机、不写 repo/control plane，也不运行项目命令。
 * GitHub 与 capability 默认做真实只读 probe，避免把“配置文件存在”误报成 Golden Path ready。
 */
export async function inspectProjectReadiness(
  layout: Layout,
  repoId: string,
  options: ProjectReadinessOptions = {},
): Promise<ProjectReadiness> {
  const registry = loadRegistry(layout);
  const entry = registry.get(repoId);
  const registered = entry?.registered === true;
  const sandboxAvailable = (options.sandboxAvailable ?? (() => existsSync("/usr/bin/sandbox-exec")))();

  let repoPath = join(layout.workspaceRoot, repoId);
  let canonical: CanonicalGitState | null = null;
  let repoError = "repo 目录不存在或路径不安全";
  try {
    // Doctor 是只读检查，不借此授权；ephemeral set 仅复用 resolveRepoPath 的既有 path security。
    repoPath = resolveRepoPath(layout, repoId, new Set([repoId]));
    canonical = inspectCanonicalGitState(repoPath);
  } catch (error) {
    repoError = error instanceof Error ? error.message : String(error);
  }
  const repoExists = canonical?.repository === true;

  let profilesDetail = "未读取";
  let profilesOk = false;
  try {
    const profiles = loadProfiles(layout, repoId);
    profilesOk = profiles.size > 0;
    profilesDetail = profilesOk
      ? `${profiles.size} 个可信 profile：${[...profiles.keys()].sort().join(", ")}`
      : "没有可信 run profile";
  } catch (error) {
    profilesDetail = error instanceof Error ? error.message : String(error);
  }

  const development = group([
    { label: "registered", ok: registered, detail: registered ? "Human Owner 已注册" : "尚未注册" },
    { label: "repo", ok: repoExists, detail: repoExists ? repoPath : canonicalDetail(canonical, repoError) },
    {
      label: "Git/worktree lifecycle",
      ok: canonical?.ready === true,
      detail: canonicalDetail(canonical, repoError),
    },
    { label: "sandbox/runtime", ok: sandboxAvailable, detail: sandboxAvailable ? "sandbox-exec 可用" : "sandbox-exec 不可用" },
    { label: "profiles", ok: profilesOk, detail: profilesDetail },
  ]);

  const prChecks: ReadinessCheck[] = [];
  let ownerRepo: { owner: string; repo: string } | null = null;
  if (!repoExists) {
    prChecks.push({ label: "Git remote", ok: false, detail: "repo 不可用" });
  } else {
    try {
      const remote = (options.readRemote ?? defaultReadRemote)(repoPath);
      if (!remote) throw new Error("origin 未配置");
      ownerRepo = parseGithubRemote(remote);
      prChecks.push({ label: "Git remote", ok: true, detail: `github.com/${ownerRepo.owner}/${ownerRepo.repo}` });
    } catch (error) {
      prChecks.push({ label: "Git remote", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const ciConfigured = repoExists && existsSync(join(repoPath, ".github", "workflows"));
  prChecks.push({
    label: "CI config",
    ok: true,
    detail: ciConfigured ? ".github/workflows 已配置" : "未检测到 workflow；轻量 repo 允许 CI=none，但 merge 仍需当前 SHA attestation",
  });

  if (!ownerRepo || !repoExists) {
    prChecks.push({ label: "GitHub credential/access", ok: false, detail: "需要有效 GitHub HTTPS origin 才能 probe" });
  } else {
    try {
      const token = loadGithubToken(layout).token;
      const head = (options.readHead ?? defaultReadHead)(repoPath);
      const detail = await (options.githubProbe ?? defaultGithubProbe)(ownerRepo.owner, ownerRepo.repo, head, token);
      prChecks.push({ label: "GitHub credential/access", ok: true, detail });
    } catch (error) {
      prChecks.push({
        label: "GitHub credential/access",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const prCi = group(prChecks);

  const deploy = repoExists
    ? await deploymentChecks(layout, repoPath, repoId, options)
    : group([{ label: "deploy spec", ok: false, detail: "repo 不可用" }]);

  let gateway: ReadinessCheck;
  if (!options.gatewayProbe) {
    gateway = { label: "Gateway", ok: false, detail: "未提供 live Gateway probe" };
  } else {
    try {
      gateway = { label: "Gateway", ok: true, detail: await options.gatewayProbe() };
    } catch (error) {
      gateway = { label: "Gateway", ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  return { repoId, development, prCi, deploy, gateway };
}

export function renderProjectReadiness(result: ProjectReadiness): string[] {
  const lines: string[] = [`Golden Path readiness: ${result.repoId}`];
  const render = (name: string, value: ReadinessGroup): void => {
    lines.push(`${value.ready ? "✓" : "✗"} ${name}`);
    for (const check of value.checks) lines.push(`  ${check.ok ? "✓" : "✗"} ${check.label} — ${check.detail}`);
  };
  render("Development", result.development);
  render("PR/CI", result.prCi);
  render("Deploy", result.deploy);
  lines.push(`${result.gateway.ok ? "✓" : "✗"} Gateway — ${result.gateway.detail}`);
  return lines;
}
