import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Layout } from "./layout.ts";

export interface RepoEntry {
  repoId: string;
  /** 仅供人阅读；权威路径由 resolveRepoPath 从 repoId 推导，不采信此字段 */
  path: string;
  registered: boolean;
}

/** 派生数据目录，不是仓库 */
const DERIVED_DIR = ".grande-work";

/**
 * 扫描工作区下的 git 仓库，返回**候选** repoId。
 *
 * 注意这只是发现，不是授权：规格 §4.2 要求「自动发现为候选，但必须显式注册后
 * ChatGPT 才可见」。把新项目放进工作区不等于自动授权。
 */
export function discoverRepos(layout: Layout): string[] {
  return readdirSync(layout.workspaceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith(".") && name !== DERIVED_DIR)
    .filter((name) => existsSync(join(layout.workspaceRoot, name, ".git")))
    .sort();
}

interface RegistryFile {
  repos?: Array<{ repoId?: unknown; path?: unknown; registered?: unknown }>;
}

export function loadRegistry(layout: Layout): Map<string, RepoEntry> {
  const out = new Map<string, RepoEntry>();
  if (!existsSync(layout.reposConfig)) return out;

  let doc: RegistryFile;
  try {
    doc = (parse(readFileSync(layout.reposConfig, "utf8")) ?? {}) as RegistryFile;
  } catch (e) {
    // 静默当成空注册表会让「配置写坏了」表现为「所有仓库都消失了」——
    // 那是最难排查的一类故障。宁可响亮地失败。
    throw new Error(
      `无法解析 ${layout.reposConfig}：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  for (const raw of doc.repos ?? []) {
    const repoId = raw.repoId;
    if (typeof repoId !== "string" || repoId.length === 0) {
      throw new Error(`${layout.reposConfig} 中存在缺少 repoId 的条目`);
    }
    if (repoId.includes("/") || repoId.includes("\\")) {
      throw new Error(
        `${layout.reposConfig} 中的 repoId 不能包含路径分隔符：${repoId}。` +
          `repoId 必须是工作区下的目录名。`,
      );
    }
    out.set(repoId, {
      repoId,
      path: typeof raw.path === "string" ? raw.path : join(layout.workspaceRoot, repoId),
      registered: raw.registered === true,
    });
  }
  return out;
}

export function saveRegistry(layout: Layout, entries: Iterable<RepoEntry>): void {
  const body = stringify({ repos: [...entries] });
  const header = [
    "# GrandeGPT 仓库注册表（可信配置，人手编辑）",
    "#",
    "# repoId 即 GPT_Workspace 下的目录名。工作区里的 git 仓库会被自动发现为候选，",
    "# 但只有 registered: true 的才对 ChatGPT 可见——放个新项目进工作区不等于授权。",
    "#",
    "# path 仅供阅读；权威路径由 repoId 推导，程序不采信这里写的值。",
    "",
  ].join("\n");
  writeFileSync(layout.reposConfig, header + body, "utf8");
}

export function registeredIds(layout: Layout): Set<string> {
  const out = new Set<string>();
  for (const [id, e] of loadRegistry(layout)) if (e.registered) out.add(id);
  return out;
}
