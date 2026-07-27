import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";

export class ProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `ProfileError [${code}]`;
    this.code = code;
  }
}

export interface RunProfile {
  name: string;
  argv: readonly string[];
  timeoutSeconds: number;
  maxOutputBytes: number;
  maxRssMb: number;
}

/** 墙钟超时是唯一可靠的资源兜底（规格 §6.5），上限防止一个笔误挂住 job 一整天 */
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
/** RSS 轮询兜底的默认上限（「已接受的风险」：轮询不是 cgroup，这只是尽力而为的兜底） */
const DEFAULT_MAX_RSS_MB = 4096;

/**
 * 加载某仓库的 run profile。
 *
 * **只从控制平面读**（铁律一）。profile 是「允许执行什么」的白名单；若从仓库读，
 * 仓库里放一个 profiles.yaml 就等于任意命令执行 —— 而仓库内容（包括模型自己刚写
 * 进去的）按定义不可信。
 */
export function loadProfiles(layout: Layout, repoId: string): Map<string, RunProfile> {
  const file = join(layout.configDir, "profiles.yaml");
  const out = new Map<string, RunProfile>();
  if (!existsSync(file)) return out;

  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ProfileError("BAD_CONFIG", `无法解析 ${file}：${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return out;
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ProfileError("BAD_CONFIG", `${file} 顶层必须是映射`);
  }
  const repos = (doc as { repos?: unknown }).repos;
  if (repos === undefined) return out;
  if (typeof repos !== "object" || repos === null || Array.isArray(repos)) {
    throw new ProfileError("BAD_CONFIG", `${file} 的 repos 必须是映射，实际是 ${typeof repos}`);
  }

  const forRepo = (repos as Record<string, unknown>)[repoId];
  if (forRepo === undefined) return out;
  if (typeof forRepo !== "object" || forRepo === null || Array.isArray(forRepo)) {
    throw new ProfileError("BAD_CONFIG", `${file} 中 repos.${repoId} 必须是映射`);
  }

  for (const [name, raw] of Object.entries(forRepo as Record<string, unknown>)) {
    const where = `${file} 中 repos.${repoId}.${name}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ProfileError("BAD_CONFIG", `${where} 必须是映射`);
    }
    const { argv, timeoutSeconds, maxOutputBytes, maxRssMb } = raw as Record<string, unknown>;

    if (!Array.isArray(argv)) {
      throw new ProfileError(
        "BAD_CONFIG",
        `${where} 的 argv 必须是数组。字符串会被当成 shell 命令拼接，而 argv 永远是数组、` +
          `绝不拼 shell 字符串（铁律二）。`,
      );
    }
    if (argv.length === 0) throw new ProfileError("BAD_CONFIG", `${where} 的 argv 不能为空`);
    for (const a of argv) {
      if (typeof a !== "string") throw new ProfileError("BAD_CONFIG", `${where} 的 argv 每一项必须是字符串`);
    }
    if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
      throw new ProfileError("BAD_CONFIG", `${where} 的 timeoutSeconds 必须是正整数`);
    }
    if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new ProfileError("BAD_CONFIG", `${where} 的 timeoutSeconds 超过上限 ${MAX_TIMEOUT_SECONDS}`);
    }
    if (maxOutputBytes !== undefined && (typeof maxOutputBytes !== "number" || maxOutputBytes <= 0)) {
      throw new ProfileError("BAD_CONFIG", `${where} 的 maxOutputBytes 必须是正数`);
    }
    // 与 maxOutputBytes 同一种校验形状：省略即用默认值，给了就必须是正数（I-3）。
    // maxRssMb 此前根本不存在于这个接口，RSS 轮询兜底（sandbox.ts 已经实现）因此
    // 永远拿不到调用方设置的上限，RESOURCE_EXHAUSTED 这条路径永远不可达。
    if (maxRssMb !== undefined && (typeof maxRssMb !== "number" || maxRssMb <= 0)) {
      throw new ProfileError("BAD_CONFIG", `${where} 的 maxRssMb 必须是正数`);
    }

    out.set(name, {
      name,
      argv: argv as string[],
      timeoutSeconds,
      maxOutputBytes: (maxOutputBytes as number | undefined) ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxRssMb: (maxRssMb as number | undefined) ?? DEFAULT_MAX_RSS_MB,
    });
  }
  return out;
}

/** 取一个 profile；不存在时的错误信息列出可选项 —— 干巴巴报错对模型没用 */
export function getProfile(layout: Layout, repoId: string, name: string): RunProfile {
  const all = loadProfiles(layout, repoId);
  const p = all.get(name);
  if (p) return p;
  const available = [...all.keys()].sort();
  throw new ProfileError(
    "PROFILE_NOT_FOUND",
    available.length === 0
      ? `仓库 ${repoId} 没有注册任何 run profile。请在 ${join(layout.configDir, "profiles.yaml")} 中注册。`
      : `仓库 ${repoId} 没有名为 ${name} 的 profile。可用：${available.join("、")}`,
  );
}

/**
 * 某仓库在新 worktree 里需要克隆的依赖目录（相对仓库根，如 `node_modules`）。
 *
 * **独立于 `repos.<repoId>.<profileName>` 存放**（顶层 `depDirs.<repoId>`），
 * 不与 profile 名字共用同一层命名空间——`loadProfiles` 把 `repos.<repoId>` 下每一个
 * 键都当 profile 名解析，若 `depDirs` 也挤在那一层，会被当成一个 profile 尝试解析，
 * 报出一个跟真实配置错误无关的 `BAD_CONFIG`。
 *
 * **为什么这个函数存在**（I-6）：`git worktree add` 产出的是一份干净 checkout，
 * 不含 `node_modules`；S0 全离线（Global Constraints），新 worktree 里 `pnpm install`
 * 跑不通——`pnpm test` 这个最现实的 profile 会在每一个 worktree 里失败。跑不了
 * 自己项目测试套件的 runner 不能算交付，因此 Task 4 的 `openWorktree` 会用这里
 * 返回的列表逐个把 canonical 里已经存在的目录克隆进新 worktree
 * （见 Task 4 `cloneDepDirs`）。
 */
export function loadDepDirs(layout: Layout, repoId: string): readonly string[] {
  const file = join(layout.configDir, "profiles.yaml");
  if (!existsSync(file)) return [];

  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ProfileError("BAD_CONFIG", `无法解析 ${file}：${(e as Error).message}`);
  }
  if (doc === null || doc === undefined || typeof doc !== "object" || Array.isArray(doc)) return [];

  const depDirs = (doc as { depDirs?: unknown }).depDirs;
  if (depDirs === undefined) return [];
  if (typeof depDirs !== "object" || depDirs === null || Array.isArray(depDirs)) {
    throw new ProfileError("BAD_CONFIG", `${file} 的 depDirs 必须是映射（repoId → 字符串数组）`);
  }

  const forRepo = (depDirs as Record<string, unknown>)[repoId];
  if (forRepo === undefined) return [];
  if (!Array.isArray(forRepo) || forRepo.some((d) => typeof d !== "string")) {
    throw new ProfileError("BAD_CONFIG", `${file} 中 depDirs.${repoId} 必须是字符串数组`);
  }
  return forRepo as string[];
}
