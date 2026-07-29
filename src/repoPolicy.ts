import { existsSync, readFileSync, statSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";

export interface RepoPolicy {
  readOnlyPaths: string[];
  pairedEdits: { when: string; require: string }[];
  /** S2 commit 门禁；为空时省略，保持旧响应与对象字面量兼容。 */
  requireGreenBeforeCommit?: string[];
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
    matchesGlob("__grande_policy_probe__", value);
  } catch (error) {
    return badConfig(
      file,
      `的 ${field} 不是有效 glob：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}

function validateProfile(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return badConfig(file, `的 ${field} 必须是非空 profile 名称字符串`);
  }
  return value.trim();
}

function parsePolicyDocument(file: string, document: unknown, allowOtherControlFields = false): RepoPolicy {
  if (document === null || document === undefined) return emptyPolicy();
  if (!isMapping(document)) badConfig(file, "顶层必须是映射");

  const allowedTopLevel = new Set([
    "readOnlyPaths",
    "pairedEdits",
    "requireGreenBeforeCommit",
    ...(allowOtherControlFields ? ["prefixes"] : []),
  ]);
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

  const requireGreenBeforeCommit: string[] = [];
  const rawRequired = document.requireGreenBeforeCommit;
  if (rawRequired !== undefined) {
    if (!Array.isArray(rawRequired)) {
      badConfig(file, "的 requireGreenBeforeCommit 必须是数组");
    }
    for (let index = 0; index < rawRequired.length; index += 1) {
      requireGreenBeforeCommit.push(
        validateProfile(file, `requireGreenBeforeCommit[${index}]`, rawRequired[index]),
      );
    }
  }

  const result: RepoPolicy = { readOnlyPaths, pairedEdits };
  if (requireGreenBeforeCommit.length > 0) result.requireGreenBeforeCommit = requireGreenBeforeCommit;
  return result;
}

function readYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new RepoPolicyError(
      "BAD_CONFIG",
      `无法解析 ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  return parsePolicyDocument(file, readYaml(file));
}

/**
 * 从控制平面 deny.yaml 读取与 repo policy 同形的收紧字段。`prefixes` 是 deny.yaml
 * 自己已有的字段，在这里允许但不消费；其余未知字段仍 fail closed。
 */
export function loadControlRepoPolicy(layout: Layout): RepoPolicy {
  const file = join(layout.configDir, "deny.yaml");
  if (!existsSync(file)) return emptyPolicy();
  return parsePolicyDocument(file, readYaml(file), true);
}

/** 合并全局与 repo 规则；三类规则均取并集，因此 repo 无法移除全局约束。 */
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

  const requireGreenBeforeCommit = [
    ...new Set([
      ...(global.requireGreenBeforeCommit ?? []),
      ...(repo.requireGreenBeforeCommit ?? []),
    ]),
  ];
  const result: RepoPolicy = { readOnlyPaths, pairedEdits };
  if (requireGreenBeforeCommit.length > 0) result.requireGreenBeforeCommit = requireGreenBeforeCommit;
  return result;
}

export function loadEffectiveCommitPolicy(layout: Layout, worktreeRoot: string): RepoPolicy {
  return mergePolicy(loadControlRepoPolicy(layout), loadRepoPolicy(worktreeRoot));
}
