import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Layout } from "./layout.ts";
import { assertValidId } from "./paths.ts";
import { parseGithubRemote } from "./prOpen.ts";
import { loadRegistry, saveRegistry } from "./registry.ts";

export interface OnboardingProfileProposal {
  name: "test" | "typecheck" | "lint" | "build";
  argv: string[];
  timeoutSeconds: number;
}

export interface RepoOnboardingProposal {
  repoId: string;
  repoPath: string;
  alreadyRegistered: boolean;
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  profiles: OnboardingProfileProposal[];
  remoteConfigured: boolean;
  githubRepo: string | null;
  ciConfigured: boolean;
  deployConfigured: boolean;
  cloneNodeModules: boolean;
}

export interface OnboardingInspectOptions {
  readRemote?: (repoPath: string) => string | null;
}

function defaultReadRemote(repoPath: string): string | null {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function packageJson(repoPath: string): Record<string, unknown> | null {
  const path = join(repoPath, "package.json");
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 顶层必须是 object`);
  }
  return value as Record<string, unknown>;
}

function detectPackageManager(repoPath: string, pkg: Record<string, unknown> | null): RepoOnboardingProposal["packageManager"] {
  if (typeof pkg?.packageManager === "string") {
    const name = pkg.packageManager.split("@", 1)[0];
    if (name === "pnpm" || name === "npm" || name === "yarn" || name === "bun") return name;
  }
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "package-lock.json"))) return "npm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return "bun";
  return null;
}

function detectProfiles(
  pkg: Record<string, unknown> | null,
  packageManager: RepoOnboardingProposal["packageManager"],
): OnboardingProfileProposal[] {
  if (!packageManager || !pkg || !pkg.scripts || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts)) return [];
  const scripts = pkg.scripts as Record<string, unknown>;
  const names = ["test", "typecheck", "lint", "build"] as const;
  return names
    .filter((name) => typeof scripts[name] === "string" && (scripts[name] as string).trim().length > 0)
    .map((name) => ({
      name,
      argv: [packageManager, "run", name],
      timeoutSeconds: name === "build" ? 900 : 600,
    }));
}

function hasWorkflow(repoPath: string): boolean {
  const dir = join(repoPath, ".github", "workflows");
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name));
  } catch {
    return false;
  }
}

/**
 * 只做候选发现，不产生授权。repo 内容只能告诉 Human「这个项目看起来怎样」，不能
 * 自己扩大 GrandeGPT 可以执行什么；真正授权发生在 applyRepoOnboarding 的显式调用。
 */
export function inspectRepoOnboarding(
  layout: Layout,
  repoId: string,
  options: OnboardingInspectOptions = {},
): RepoOnboardingProposal {
  assertValidId(repoId, "repoId");
  const repoPath = join(layout.workspaceRoot, repoId);
  if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) {
    throw new Error(`工作区候选 ${repoId} 不存在或不是 git repo：${repoPath}`);
  }

  const pkg = packageJson(repoPath);
  const packageManager = detectPackageManager(repoPath, pkg);
  const remote = (options.readRemote ?? defaultReadRemote)(repoPath);
  let githubRepo: string | null = null;
  if (remote) {
    try {
      const parsed = parseGithubRemote(remote);
      githubRepo = `${parsed.owner}/${parsed.repo}`;
    } catch {
      // onboarding 只报告 readiness；不把带凭据/SSH/非 GitHub remote 原文回显给模型或日志。
    }
  }

  return {
    repoId,
    repoPath,
    alreadyRegistered: loadRegistry(layout).get(repoId)?.registered === true,
    packageManager,
    profiles: detectProfiles(pkg, packageManager),
    remoteConfigured: remote !== null,
    githubRepo,
    ciConfigured: hasWorkflow(repoPath),
    deployConfigured: existsSync(join(repoPath, ".grande", "deploy.yaml")),
    cloneNodeModules: existsSync(join(repoPath, "node_modules")),
  };
}

function profilesDocument(layout: Layout): Record<string, unknown> {
  const path = join(layout.configDir, "profiles.yaml");
  if (!existsSync(path)) return {};
  const parsed = parse(readFileSync(path, "utf8")) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} 顶层必须是 object`);
  return parsed as Record<string, unknown>;
}

/** Human Owner 已明确 apply 后才调用；所有写入都只落在 control plane。 */
export function applyRepoOnboarding(layout: Layout, proposal: RepoOnboardingProposal): void {
  const registry = loadRegistry(layout);
  registry.set(proposal.repoId, {
    repoId: proposal.repoId,
    path: proposal.repoPath,
    registered: true,
  });
  saveRegistry(layout, registry.values());

  if (proposal.profiles.length === 0 && !proposal.cloneNodeModules) return;
  const path = join(layout.configDir, "profiles.yaml");
  const doc = profilesDocument(layout);

  const reposRaw = doc.repos ?? {};
  if (typeof reposRaw !== "object" || reposRaw === null || Array.isArray(reposRaw)) {
    throw new Error(`${path} 的 repos 必须是映射`);
  }
  const repos = reposRaw as Record<string, unknown>;
  const existingRepo = repos[proposal.repoId] ?? {};
  if (typeof existingRepo !== "object" || existingRepo === null || Array.isArray(existingRepo)) {
    throw new Error(`${path} 中 repos.${proposal.repoId} 必须是映射`);
  }
  const repoProfiles = existingRepo as Record<string, unknown>;
  for (const profile of proposal.profiles) {
    if (repoProfiles[profile.name] === undefined) {
      repoProfiles[profile.name] = { argv: profile.argv, timeoutSeconds: profile.timeoutSeconds };
    }
  }
  repos[proposal.repoId] = repoProfiles;
  doc.repos = repos;

  if (proposal.cloneNodeModules) {
    const depDirsRaw = doc.depDirs ?? {};
    if (typeof depDirsRaw !== "object" || depDirsRaw === null || Array.isArray(depDirsRaw)) {
      throw new Error(`${path} 的 depDirs 必须是映射`);
    }
    const depDirs = depDirsRaw as Record<string, unknown>;
    if (depDirs[proposal.repoId] === undefined) depDirs[proposal.repoId] = ["node_modules"];
    doc.depDirs = depDirs;
  }

  const header = [
    "# GrandeGPT run profiles（可信控制平面；repo 内容不能自行扩大执行权限）",
    "# `grande repo add <repoId> --apply` 只会补齐不存在的常见 profile，不覆盖已有条目。",
    "",
  ].join("\n");
  writeFileSync(path, header + stringify(doc), "utf8");
}
