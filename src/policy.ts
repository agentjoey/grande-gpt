import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, normalize, relative, sep } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";

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
}

/**
 * 内置拒绝项。**用户配置只能追加、不能移除这些** —— AC-14 是硬门禁，
 * 而配置文件是可编辑的；允许放宽就等于把硬约束降级成软约束（铁律三）。
 */
const BUILTIN_PREFIXES = [".git/"] as const;

/**
 * 从**控制平面**读拒绝表。绝不从仓库内读（铁律一：仓库内容不可信）。
 * 文件不存在是正常情况，返回内置默认值。
 */
export function loadDenyRules(layout: Layout): DenyRules {
  const file = join(layout.configDir, "deny.yaml");
  const extra: string[] = [];

  if (existsSync(file)) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new PolicyError("BAD_CONFIG", `无法解析 ${file}：${(e as Error).message}`);
    }
    if (doc !== null && doc !== undefined) {
      if (typeof doc !== "object" || Array.isArray(doc)) {
        throw new PolicyError("BAD_CONFIG", `${file} 顶层必须是映射，实际是 ${typeof doc}`);
      }
      const raw = (doc as { prefixes?: unknown }).prefixes;
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
          // 两者都不是「配置写错了会漏拒绝」，而是「配置写错了会拒绝到奇怪的地方」；
          // 响亮地拒绝配置本身，好过默默留一条永远不会命中的规则。
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
    }
  }

  // 内置在前，且用 Set 去重后【不】过滤内置项——合并方向是只增不减
  return { prefixes: [...new Set([...BUILTIN_PREFIXES, ...extra])] };
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
  const probe = normalize(relativePath).split(sep).join("/").toLowerCase();
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
