import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, matchesGlob, normalize, relative, sep } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";
import {
  loadRepoPolicy,
  mergePolicy,
  RepoPolicyError,
  type RepoPolicy,
} from "./repoPolicy.ts";

export class PolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    // 与 PathSecurityError 保持同一形状：码存 .code 供程序分支，name 带码供日志与
    // 堆栈定位，message 保持干净——码不进 message，因为它在响应信封里已有独立字段，
    // 重复一遍是在会被静默截断的响应里浪费字节。
    super(message);
    this.name = `PolicyError [${code}]`;
    this.code = code;
  }
}

export interface DenyRules {
  readonly prefixes: readonly string[];
  readonly readOnlyPaths?: readonly string[];
  readonly pairedEdits?: readonly { readonly when: string; readonly require: string }[];
}

/**
 * 内置拒绝项。**用户配置只能追加、不能移除这些** —— AC-14 是硬门禁，
 * 而配置文件是可编辑的；允许放宽就等于把硬约束降级成软约束（铁律三）。
 */
const BUILTIN_PREFIXES = [".git/"] as const;

function readControlPolicy(layout: Layout): { file: string; doc: Record<string, unknown> } {
  const file = join(layout.configDir, "deny.yaml");
  if (!existsSync(file)) return { file, doc: {} };

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PolicyError(
      "BAD_CONFIG",
      `无法解析 ${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === null || parsed === undefined) return { file, doc: {} };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PolicyError("BAD_CONFIG", `${file} 顶层必须是映射，实际是 ${typeof parsed}`);
  }
  return { file, doc: parsed as Record<string, unknown> };
}

function validateGlob(file: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PolicyError("BAD_CONFIG", `${file} 的 ${field} 必须是非空 glob 字符串`);
  }
  try {
    matchesGlob("__grande_policy_probe__", value);
  } catch (error) {
    throw new PolicyError(
      "BAD_CONFIG",
      `${file} 的 ${field} 不是有效 glob：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return value;
}

function readRepoPolicyFields(file: string, doc: Record<string, unknown>): RepoPolicy {
  const readOnlyPaths: string[] = [];
  const rawReadOnlyPaths = doc.readOnlyPaths;
  if (rawReadOnlyPaths !== undefined) {
    if (!Array.isArray(rawReadOnlyPaths)) {
      throw new PolicyError("BAD_CONFIG", `${file} 的 readOnlyPaths 必须是数组`);
    }
    for (let index = 0; index < rawReadOnlyPaths.length; index += 1) {
      readOnlyPaths.push(validateGlob(file, `readOnlyPaths[${index}]`, rawReadOnlyPaths[index]));
    }
  }

  const pairedEdits: RepoPolicy["pairedEdits"] = [];
  const rawPairedEdits = doc.pairedEdits;
  if (rawPairedEdits !== undefined) {
    if (!Array.isArray(rawPairedEdits)) {
      throw new PolicyError("BAD_CONFIG", `${file} 的 pairedEdits 必须是数组`);
    }
    for (let index = 0; index < rawPairedEdits.length; index += 1) {
      const entry = rawPairedEdits[index];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new PolicyError("BAD_CONFIG", `${file} 的 pairedEdits[${index}] 必须是映射`);
      }
      const mapping = entry as Record<string, unknown>;
      const keys = Object.keys(mapping);
      if (keys.some((key) => key !== "when" && key !== "require")) {
        throw new PolicyError("BAD_CONFIG", `${file} 的 pairedEdits[${index}] 只能包含 when 与 require`);
      }
      pairedEdits.push({
        when: validateGlob(file, `pairedEdits[${index}].when`, mapping.when),
        require: validateGlob(file, `pairedEdits[${index}].require`, mapping.require),
      });
    }
  }

  return { readOnlyPaths, pairedEdits };
}

/**
 * 从**控制平面**读拒绝表。绝不从仓库内读（铁律一：仓库内容不可信）。
 * 文件不存在是正常情况，返回内置默认值。S1.5 起，同一个 deny.yaml 还承载
 * 全局 readOnlyPaths / pairedEdits；repo 规则只能在其上继续收紧。
 */
export function loadDenyRules(layout: Layout): DenyRules {
  const { file, doc } = readControlPolicy(layout);
  const extra: string[] = [];
  const raw = doc.prefixes;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      throw new PolicyError("BAD_CONFIG", `${file} 的 prefixes 必须是数组，实际是 ${typeof raw}`);
    }
    for (const p of raw) {
      if (typeof p !== "string" || p.length === 0) {
        throw new PolicyError("BAD_CONFIG", `${file} 的 prefixes 每一项必须是非空字符串`);
      }
      // 拒绝表只应表达仓库内相对路径的收窄，没有理由指向仓库之外或向上穿越——
      // `/` 开头看着像绝对路径（对拒绝表没有意义），`..` 试图向上走出仓库。
      if (p.startsWith("/")) {
        throw new PolicyError(
          "BAD_CONFIG",
          `${file} 的 prefixes 条目不能以 / 开头（拒绝表只表达仓库内相对路径）：${p}`,
        );
      }
      if (p.split("/").includes("..")) {
        throw new PolicyError("BAD_CONFIG", `${file} 的 prefixes 条目不能包含 ..：${p}`);
      }
      extra.push(p.endsWith("/") ? p : `${p}/`);
    }
  }

  const globalPolicy = readRepoPolicyFields(file, doc);
  return {
    prefixes: [...new Set([...BUILTIN_PREFIXES, ...extra])],
    readOnlyPaths: globalPolicy.readOnlyPaths,
    pairedEdits: globalPolicy.pairedEdits,
  };
}

/** 加载控制平面规则并与仓库内只能收紧的 policy 合并。 */
export function loadEffectiveDenyRules(layout: Layout, worktreeRoot: string): DenyRules {
  const globalRules = loadDenyRules(layout);
  let repoPolicy: RepoPolicy;
  try {
    repoPolicy = loadRepoPolicy(worktreeRoot);
  } catch (error) {
    if (error instanceof RepoPolicyError) {
      throw new PolicyError(error.code, error.message);
    }
    throw error;
  }

  const effective = mergePolicy(
    {
      readOnlyPaths: [...(globalRules.readOnlyPaths ?? [])],
      pairedEdits: (globalRules.pairedEdits ?? []).map((entry) => ({
        when: entry.when,
        require: entry.require,
      })),
    },
    repoPolicy,
  );

  return {
    prefixes: globalRules.prefixes,
    readOnlyPaths: effective.readOnlyPaths,
    pairedEdits: effective.pairedEdits,
  };
}

/**
 * 在启动验证 job 之前，按整个任务相对 base 的已改文件集合检查配对要求。
 * 多条规则同时不满足时一次性全部列出，避免模型修一条、重跑、再发现下一条。
 */
export function assertPairedEditsSatisfied(changedFiles: readonly string[], rules: DenyRules): void {
  const normalizedFiles = changedFiles.map((path) => normalize(path).split(sep).join("/"));
  const violations: { when: string; require: string }[] = [];

  for (const rule of rules.pairedEdits ?? []) {
    const triggered = normalizedFiles.some((path) => matchesGlob(path, rule.when));
    if (!triggered) continue;
    const satisfied = normalizedFiles.some((path) => matchesGlob(path, rule.require));
    if (!satisfied) violations.push({ when: rule.when, require: rule.require });
  }

  if (violations.length > 0) {
    throw new PolicyError(
      "POLICY_DENIED",
      "任务改动不满足 pairedEdits：" +
        violations
          .map((rule) => `改了匹配 ${rule.when} 的文件，但没有匹配 ${rule.require} 的改动`)
          .join("；"),
    );
  }
}

/**
 * 判定一个**已解析**的仓库内相对路径是否可写。三件事缺一不可：
 *
 * 1. 先 `normalize`，否则 `src/../.git/config` 这种绕行写法会漏网；
 * 2. **大小写不敏感比对** —— macOS APFS 默认大小写不敏感，`.GIT/hooks/pre-commit`
 *    落盘就是 `.git/hooks/pre-commit`（已实测写穿）。在大小写敏感的文件系统上这会误杀
 *    一个真名叫 `.GIT` 的目录 —— 那是安全的失败方向，接受；
 * 3. **内置项恒生效**：不管调用方传进来的 `rules` 是什么，`BUILTIN_PREFIXES` 都参与比对。
 *    否则 `repoEdit(root, ops, { prefixes: [] })` 一行就关掉了 AC-14，硬门禁降级成
 *    「调用方自觉」（铁律三）。
 *
 * **必须传解析后的路径**（见 `assertWritableResolved`）：拿模型给的原始字符串判定会被
 * 仓内符号链接绕过（`vendor -> .git`，已实测写穿到 `.git/hooks/pre-commit`）。
 */
export function assertWritable(relativePath: string, rules: DenyRules): void {
  const normalized = normalize(relativePath).split(sep).join("/");
  const probe = normalized.toLowerCase();
  for (const prefix of [...BUILTIN_PREFIXES, ...rules.prefixes]) {
    const bare = prefix.slice(0, -1);
    if (probe === bare.toLowerCase() || probe.startsWith(prefix.toLowerCase())) {
      throw new PolicyError(
        "POLICY_DENIED",
        `${relativePath} 命中仓内敏感路径拒绝表（${bare}）。` +
          `这类路径能在沙箱之外执行宿主命令（如 .git/hooks/pre-commit、core.pager），` +
          `因此写工具一律不可触及。`,
      );
    }
  }

  for (const pattern of rules.readOnlyPaths ?? []) {
    if (matchesGlob(probe, pattern.toLowerCase())) {
      throw new PolicyError(
        "POLICY_DENIED",
        `${relativePath} 命中只读路径规则（${pattern}）。` +
          `该规则来自控制平面或仓库内只能收紧的 .grande/policy.yaml，写工具不可触及。`,
      );
    }
  }
}

/**
 * 规格 §4.6 字面要求的那道门：**在 `resolveInRepo` 之后**，用解析结果相对 canonical
 * 仓库根算出的路径再过一次拒绝表。这是唯一能挡住仓内符号链接的形式 —— `resolveInRepo`
 * 只保证「解析后仍在仓库之内」，而 `vendor -> .git` 完全满足这一条。
 * 原始字符串那一道（`assertWritable`）仍然保留：它便宜，且报错时引用的是模型自己给的
 * 路径，比引用一个它没见过的绝对路径有用。
 */
export function assertWritableResolved(repoRoot: string, absolutePath: string, rules: DenyRules): void {
  const realRoot = realpathSync(repoRoot);
  const rel = relative(realRoot, absolutePath).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../")) {
    throw new PolicyError("POLICY_DENIED", `${absolutePath} 解析后不在仓库 ${realRoot} 之内`);
  }
  assertWritable(rel, rules);
}
