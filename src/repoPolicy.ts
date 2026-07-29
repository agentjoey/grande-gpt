import { existsSync, readFileSync, statSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { parse } from "yaml";

export interface RepoPolicy {
  readOnlyPaths: string[];
  pairedEdits: { when: string; require: string }[];
}

export class RepoPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = `RepoPolicyError [${code}]`;
    this.code = code;
  }
}

function emptyPolicy(): RepoPolicy {
  return { readOnlyPaths: [], pairedEdits: [] };
}

function badConfig(file: string, message: string): never {
  throw new RepoPolicyError("BAD_CONFIG", `${file} ${message}`);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGlob(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return badConfig(file, `的 ${field} 必须是非空 glob 字符串`);
  }
  try {
    // Node 24 的内置 glob 解析器是后续策略匹配的唯一实现；这里提前解析一次，
    // 让无效 pattern 在加载阶段 fail closed，而不是等到写入门禁时才出错。
    matchesGlob("__grande_policy_probe__", value);
  } catch (error) {
    return badConfig(
      file,
      `的 ${field} 不是有效 glob：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}

/** 从 <worktreeRoot>/.grande/policy.yaml 加载 repo 级收紧规则。 */
export function loadRepoPolicy(worktreeRoot: string): RepoPolicy {
  const file = join(worktreeRoot, ".grande", "policy.yaml");
  if (!existsSync(file)) return emptyPolicy();

  try {
    if (!statSync(file).isFile()) badConfig(file, "必须是普通文件");
  } catch (error) {
    if (error instanceof RepoPolicyError) throw error;
    throw new RepoPolicyError(
      "BAD_CONFIG",
      `无法检查 ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let document: unknown;
  try {
    document = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new RepoPolicyError(
      "BAD_CONFIG",
      `无法解析 ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (document === null || document === undefined) return emptyPolicy();
  if (!isMapping(document)) badConfig(file, "顶层必须是映射");

  const allowedTopLevel = new Set(["readOnlyPaths", "pairedEdits"]);
  for (const key of Object.keys(document)) {
    if (!allowedTopLevel.has(key)) badConfig(file, `包含未知字段 ${key}`);
  }

  const readOnlyPaths: string[] = [];
  const rawReadOnlyPaths = document.readOnlyPaths;
  if (rawReadOnlyPaths !== undefined) {
    if (!Array.isArray(rawReadOnlyPaths)) badConfig(file, "的 readOnlyPaths 必须是数组");
    for (let index = 0; index < rawReadOnlyPaths.length; index += 1) {
      readOnlyPaths.push(validateGlob(file, `readOnlyPaths[${index}]`, rawReadOnlyPaths[index]));
    }
  }

  const pairedEdits: RepoPolicy["pairedEdits"] = [];
  const rawPairedEdits = document.pairedEdits;
  if (rawPairedEdits !== undefined) {
    if (!Array.isArray(rawPairedEdits)) badConfig(file, "的 pairedEdits 必须是数组");
    for (let index = 0; index < rawPairedEdits.length; index += 1) {
      const entry = rawPairedEdits[index];
      if (!isMapping(entry)) badConfig(file, `的 pairedEdits[${index}] 必须是映射`);
      const keys = Object.keys(entry);
      if (keys.some((key) => key !== "when" && key !== "require")) {
        badConfig(file, `的 pairedEdits[${index}] 只能包含 when 与 require`);
      }
      pairedEdits.push({
        when: validateGlob(file, `pairedEdits[${index}].when`, entry.when),
        require: validateGlob(file, `pairedEdits[${index}].require`, entry.require),
      });
    }
  }

  return { readOnlyPaths, pairedEdits };
}

/** 合并全局与 repo 规则；两类规则均取并集，因此 repo 无法移除全局约束。 */
export function mergePolicy(global: RepoPolicy, repo: RepoPolicy): RepoPolicy {
  const readOnlyPaths = [...new Set([...global.readOnlyPaths, ...repo.readOnlyPaths])];
  const pairedEdits: RepoPolicy["pairedEdits"] = [];
  const seenPairs = new Set<string>();

  for (const pair of [...global.pairedEdits, ...repo.pairedEdits]) {
    const key = JSON.stringify([pair.when, pair.require]);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    pairedEdits.push({ when: pair.when, require: pair.require });
  }

  return { readOnlyPaths, pairedEdits };
}
