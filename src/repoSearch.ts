import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { truncateText } from "./envelope.ts";

export class SearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `SearchError [${code}]`;
    this.code = code;
  }
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
  contentTruncated: boolean;
}

export interface SearchResult {
  truncated: boolean;
  nextCursor: string | null;
  timedOut: boolean;
  skippedOversized: number;
  matches: SearchMatch[];
}

/** 与 repoMap 各自声明一份：跳过哪些目录是每个模块自己的策略，不是跨模块契约 */
const SKIP_DIRS = new Set([".git", "node_modules", ".grande-work"]);
// 规格 §5.4②：每条 3 行上下文 = 1 行前 + 命中行本身 + 1 行后。
const CONTEXT_LINES = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_SEARCH_MATCHES = 20;
export const MAX_SEARCH_MATCHES = 25;
export const MAX_SEARCH_RESULT_BYTES = 16 * 1024;
const MAX_SEARCH_MATCH_BYTES = 8 * 1024;

interface ParsedCursor {
  fileIndex: number;
  offset: number;
  versioned: boolean;
}

function parseCursor(raw: string | null | undefined): ParsedCursor {
  if (raw === undefined || raw === null || raw === "") return { fileIndex: 0, offset: 0, versioned: false };
  if (/^\d+$/.test(raw)) return { fileIndex: 0, offset: Number(raw), versioned: false };
  const match = /^v1:(\d+):(\d+)$/.exec(raw);
  if (!match) throw new SearchError("INVALID_INPUT", `cursor 格式无效，收到：${raw}`);
  const fileIndex = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(fileIndex) || !Number.isSafeInteger(offset)) {
    throw new SearchError("INVALID_INPUT", `cursor 超出安全整数范围，收到：${raw}`);
  }
  return { fileIndex, offset, versioned: true };
}

function versionedCursor(fileIndex: number, offset: number): string {
  return `v1:${fileIndex}:${offset}`;
}

function boundedMatch(match: Omit<SearchMatch, "contentTruncated">): SearchMatch {
  const out: SearchMatch = { ...match, contentTruncated: false };
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > MAX_SEARCH_MATCH_BYTES) {
    const fields = [
      { value: out.text, set: (value: string) => { out.text = value; } },
      ...out.before.map((value, index) => ({ value, set: (next: string) => { out.before[index] = next; } })),
      ...out.after.map((value, index) => ({ value, set: (next: string) => { out.after[index] = next; } })),
    ].sort((a, b) => Buffer.byteLength(JSON.stringify(b.value)) - Buffer.byteLength(JSON.stringify(a.value)));
    const largest = fields[0];
    if (!largest || largest.value.length === 0) break;
    const bytes = Buffer.byteLength(largest.value, "utf8");
    largest.set(truncateText(largest.value, Math.floor(bytes / 2)).text);
    out.contentTruncated = true;
  }
  return out;
}

function listFiles(root: string, dir: string, out: string[], stats: { skippedOversized: number }): void {
  // 根目录读不到是调用方的错，要报出来；子目录读不到（权限/竞态删除）不该让
  // 整棵搜索失败——与 repoMap 的 walk 同一套区分方式。
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    if (dir === root) {
      throw new SearchError("INVALID_INPUT", `无法读取仓库根 ${root}：${(e as Error).message}`);
    }
    return;
  }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      // C2：lstatSync（不跟随符号链接）而不是 statSync——与 repoMap 的 walk 同一
      // 个根因、同一个修法。statSync 跟随符号链接会把「指向仓库外的链接」
      // （repo/vendor -> /outside）与「给 .git 起别名的链接」（repo/gitalias ->
      // repo/.git，SKIP_DIRS 只按名字过滤、"gitalias" 不在集合里）都当成普通
      // 目录递归进去，NEEDLE 搜索命中的内容会被原样返回给 ChatGPT。
      st = lstatSync(abs);
    } catch {
      continue;
    }
    // 不跟随、直接跳过（fail closed，与 repoMap.walk 选择同一种修法——两个模块
    // 各自维护一份 SKIP_DIRS 已经是既有约定，这里同样各自实现而不是提取共享
    // helper，见两个文件顶部注释）。代价与 repoMap 相同：仓库内指向普通文件的
    // 符号链接不会被搜索到。
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      listFiles(root, abs, out, stats);
    } else if (st.isFile()) {
      if (st.size <= MAX_FILE_BYTES) out.push(abs);
      else stats.skippedOversized++; // 静默跳过会让模型误以为「搜过了没有」；在结果里报出计数
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 搜索仓库文本。
 *
 * **时间预算是硬要求，不是优化**：ChatGPT 的工具调用 ~60s 超时不可配置，
 * 搜到底可能直接撑爆它。到点返回部分结果 + `timedOut: true`，
 * 让模型知道结果不完整，远好过整个调用失败。
 *
 * **只支持字面量匹配，不支持调用方提供的正则**（S0 范围收窄，见 CLAUDE.md 铁律二
 * 「没有通用逃生舱」）：正则的灾难性回溯是无界 CPU 消耗，且 Node 的 `RegExp` 没有
 * 内置超时——`new RegExp("(a+)+$").test("a".repeat(40)+"b")` 在这台机器上实测耗时
 * 55,661 ms，一个 40 字节的输入就能把 ChatGPT 那个不可配置的 ~60s 工具超时撑爆。
 * 把预算检查放进逐行循环挡不住这个：预算检查是在两次 `re.test()` 之间才有机会
 * 运行，而单次 `re.test()` 本身就可能不返回。要重新开放正则匹配，必须先把匹配
 * 移进 Worker/子进程并对它做硬性 kill（`terminate()`/`SIGKILL`），留给后续切片。
 */
export function repoSearch(
  root: string,
  pattern: string,
  opts?: { maxMatches?: number; budgetMs?: number; cursor?: string | null },
): SearchResult {
  if (opts && "regex" in opts) {
    throw new SearchError(
      "INVALID_INPUT",
      "S0 只支持字面量搜索，不支持调用方提供的正则：进程内运行调用方给的正则是一个" +
        "无界 CPU 逃生舱（灾难性回溯可以让单次匹配耗时数万毫秒，且 Node 的 RegExp 没有" +
        "超时机制），违反铁律二「没有通用逃生舱」。",
    );
  }
  const maxMatches = opts?.maxMatches ?? DEFAULT_SEARCH_MATCHES;
  if (!Number.isInteger(maxMatches) || maxMatches <= 0 || maxMatches > MAX_SEARCH_MATCHES) {
    throw new SearchError(
      "INVALID_INPUT",
      `maxMatches 必须是 1..${MAX_SEARCH_MATCHES} 的整数，收到：${String(maxMatches)}`,
    );
  }
  const budgetMs = opts?.budgetMs ?? 4000;
  const cursor = parseCursor(opts?.cursor);
  const { fileIndex: startFileIndex, offset } = cursor;
  if (pattern.length === 0) throw new SearchError("INVALID_INPUT", "pattern 不能为空");

  // pattern 恒按字面量处理：escapeRegExp 把每个正则特殊字符都转义掉，理论上不应该
  // 再编译失败。仍然保留这层 try/catch（而不是假设它绝对安全）——万一某个未预见的
  // 输入让编译失败，也要转成带 .code 的 SearchError，而不是让裸 SyntaxError 逃出
  // 本模块（I1 的同一条要求：每条失败都带结构化 .code）。
  let re: RegExp;
  try {
    re = new RegExp(escapeRegExp(pattern));
  } catch (e) {
    throw new SearchError("INVALID_INPUT", `pattern 无法用于匹配：${(e as Error).message}`);
  }

  const started = Date.now();
  const files: string[] = [];
  const stats = { skippedOversized: 0 };
  listFiles(root, root, files, stats);
  // 与 repoMap 一致：全局排序。listFiles 只在每个目录内排序，得到的是 DFS 顺序 ——
  // `src/a.ts` 与 `src.ts` 就会排反（"." < "/"）。cursor 是偏移量，续取的正确性
  // 依赖两次调用的顺序完全一致，不排就只是「碰巧一致」。
  files.sort();

  const found: SearchMatch[] = [];
  let timedOut = false;
  let nextFileIndex = startFileIndex;

  // 需要收集 offset + maxMatches + 1 条才能既跳过已给出的、又判断还有没有更多
  const need = offset + maxMatches + 1;

  outer: for (let fileIndex = startFileIndex; fileIndex < files.length; fileIndex++) {
    const abs = files[fileIndex]!;
    nextFileIndex = fileIndex + 1;
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // 二进制判定：NUL 字节。写成 \0 转义而不是源码里嵌一个真的 NUL —— 那个字节
    // 在任何渲染器/编辑器/剪贴板里都是不可见的，抄错了没人看得出来。
    if (content.includes("\0")) continue;

    const lines = content.split("\n");
    const rel = relative(root, abs).split(sep).join("/");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      found.push(boundedMatch({
        path: rel,
        line: i + 1,
        text: lines[i]!,
        before: lines.slice(Math.max(0, i - CONTEXT_LINES), i),
        after: lines.slice(i + 1, i + 1 + CONTEXT_LINES),
      }));
      if (found.length >= need) break outer;
    }

    // 预算检查放在**处理完一个文件之后**，两个理由：
    // ① 保证每次调用至少推进一个文件，否则 budgetMs=0 的行为取决于 Date.now() 的
    //    毫秒边界 —— 实测 100 次里有 8 次「还没超预算」，是一条会随机变红的测试；
    // ② 到点时已找到的结果留在 found 里，这才是「已找到的结果不丢」。
    if (Date.now() - started >= budgetMs) {
      if (nextFileIndex < files.length) {
        timedOut = true;
        break;
      }
    }
  }

  let slice = found.slice(offset, offset + maxMatches);
  for (;;) {
    const consumed = offset + slice.length;
    const truncated = timedOut || consumed < found.length;
    let nextCursor: string | null = null;
    if (truncated) {
      if (timedOut) {
        nextCursor = consumed < found.length
          ? versionedCursor(startFileIndex, consumed)
          : versionedCursor(nextFileIndex, 0);
      } else {
        nextCursor = cursor.versioned
          ? versionedCursor(startFileIndex, consumed)
          : String(consumed);
      }
    }
    const result: SearchResult = {
      truncated,
      nextCursor,
      timedOut,
      skippedOversized: stats.skippedOversized,
      matches: slice,
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_SEARCH_RESULT_BYTES) return result;

    // The budget applies to the actual serialized SearchResult, including metadata and
    // nextCursor. Drop only trailing matches, then rebuild the result so the cursor advances
    // by exactly the matches the caller really received.
    if (slice.length === 0) return result;
    slice = slice.slice(0, -1);
  }
}
