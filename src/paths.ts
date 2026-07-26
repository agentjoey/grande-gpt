import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Layout } from "./layout.ts";

export class PathSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    // code 同时前缀进 message：`.code` 供程序按码分支，但测试与日志通常只看
    // `.message`（例如 vitest 的 `toThrow(/PATH_ESCAPE/)` 匹配的是 message
    // 而非这个字段）——两处都要能定位到具体是哪一类拒绝。
    super(`${code}: ${message}`);
    this.name = "PathSecurityError";
    this.code = code;
  }
}

/** 判断 child 是否真的在 parent 之下（而不是只有字符串前缀相同，如 /a/bc vs /a/b） */
function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * 对一个可能尚不存在的路径求 canonical 形式：向上找到最近的存在祖先做 `realpathSync`，
 * 再把剩余部分拼回去。直接对不存在的路径 `realpathSync` 会抛 ENOENT，
 * 但创建新文件时目标本就不存在——不能因此拒绝。
 */
function realpathAllowingMissing(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return p; // 到根了仍不存在，原样返回
    tail.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  return join(realpathSync(existing), ...tail);
}

/**
 * `repoId` → 仓库根的绝对路径。
 *
 * `repoId` 就是 `GPT_Workspace` 下的目录名（规格 §4.2），**不是任意路径**。
 * 因此这里不做「路径拼接后再检查」，而是先否定一切含分隔符、含 `.`/`..`、
 * 绝对路径形式的输入——这样路径穿越在拼接之前就不可能发生。
 *
 * 之后仍要检查符号链接逃逸：`GPT_Workspace/x` 可以是一个指向工作区之外的链接，
 * 名字上完全合法。
 */
export function resolveRepoPath(layout: Layout, repoId: string, registered: ReadonlySet<string>): string {
  if (repoId.length === 0) {
    throw new PathSecurityError("INVALID_INPUT", "repoId 不能为空");
  }
  if (repoId.includes("/") || repoId.includes("\\") || isAbsolute(repoId)) {
    throw new PathSecurityError(
      "INVALID_INPUT",
      `repoId 必须是 ${layout.workspaceRoot} 下的目录名，不能包含路径分隔符：${repoId}`,
    );
  }
  if (repoId === "." || repoId === "..") {
    throw new PathSecurityError("INVALID_INPUT", `repoId 不能是 ${repoId}`);
  }
  if (!registered.has(repoId)) {
    throw new PathSecurityError(
      "REPO_NOT_REGISTERED",
      `仓库 ${repoId} 未注册。工作区下的仓库会被自动发现为候选，但必须显式注册后才可访问。`,
    );
  }

  const candidate = join(layout.workspaceRoot, repoId);
  if (!existsSync(candidate)) {
    throw new PathSecurityError("REPO_NOT_FOUND", `仓库目录不存在：${candidate}`);
  }

  const real = realpathSync(candidate);
  if (!isUnder(layout.workspaceRoot, real)) {
    throw new PathSecurityError(
      "PATH_ESCAPE",
      `仓库 ${repoId} 解析后落在工作区之外：${real}（工作区：${layout.workspaceRoot}）`,
    );
  }
  return real;
}

/**
 * 仓库内的相对路径 → 绝对路径。允许目标尚不存在（创建新文件）。
 * 解析后必须仍在仓库之内，符号链接也不能把它带出去。
 */
export function resolveInRepo(repoRoot: string, relativePath: string): string {
  if (relativePath.length === 0) {
    throw new PathSecurityError("INVALID_INPUT", "路径不能为空");
  }
  if (isAbsolute(relativePath)) {
    throw new PathSecurityError("INVALID_INPUT", `必须是仓库内的相对路径：${relativePath}`);
  }

  const real = realpathAllowingMissing(resolve(repoRoot, relativePath));
  const realRoot = realpathSync(repoRoot);
  if (!isUnder(realRoot, real)) {
    throw new PathSecurityError(
      "PATH_ESCAPE",
      `路径解析后落在仓库之外：${relativePath} → ${real}（仓库：${realRoot}）`,
    );
  }
  return real;
}
