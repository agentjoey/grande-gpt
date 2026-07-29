import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";
import { PolicyError } from "./policy.ts";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取控制平面里某个 repo 的软约束文本。文件不存在或该 repo 未配置都返回
 * undefined；配置内容只作为原始字符串返回，不解释、不模板展开、更不执行。
 */
export function loadGuidance(layout: Layout, repoId: string): string | undefined {
  const file = join(layout.configDir, "guidance.yaml");
  if (!existsSync(file)) return undefined;

  let document: unknown;
  try {
    document = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PolicyError(
      "BAD_CONFIG",
      `无法解析 ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (document === null || document === undefined) return undefined;
  if (!isMapping(document)) {
    throw new PolicyError("BAD_CONFIG", `${file} 顶层必须是映射`);
  }
  for (const key of Object.keys(document)) {
    if (key !== "repos") {
      throw new PolicyError("BAD_CONFIG", `${file} 包含未知字段 ${key}`);
    }
  }

  const repos = document.repos;
  if (repos === undefined) return undefined;
  if (!isMapping(repos)) {
    throw new PolicyError("BAD_CONFIG", `${file} 的 repos 必须是映射`);
  }
  if (!Object.hasOwn(repos, repoId)) return undefined;

  const guidance = repos[repoId];
  if (typeof guidance !== "string") {
    throw new PolicyError("BAD_CONFIG", `${file} 的 repos.${repoId} 必须是字符串`);
  }
  return guidance;
}
