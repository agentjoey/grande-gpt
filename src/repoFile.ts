import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { truncateText } from "./envelope.ts";
import { resolveInRepo } from "./paths.ts";
import { assertWritable, assertWritableResolved, type DenyRules } from "./policy.ts";

export class EditError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `EditError [${code}]`;
    this.code = code;
  }
}

export interface ReadResult {
  truncated: boolean;
  path: string;
  sha256: string;
  bytes: number;
  totalLines: number;
  content: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;

function sha256Of(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** 对已经在磁盘上的原始字节哈希——不经过任何字符串解码。见 `isBinary` 的 JSDoc：
 *  `repoRead`/`repoEdit` 的 staleness sha256 必须是【原始字节】的哈希，而不是
 *  「解码成字符串再按 utf8 编码回去」这条路径的哈希——一旦内容不是合法 UTF-8，
 *  两者不再恒等（I1）。 */
function sha256OfBuffer(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * `raw` 是否是 S0 的读写工具拒绝处理的二进制内容。两条判据缺一不可：
 *
 * 1. 含 NUL 字节——原有判据，覆盖大多数明显的二进制格式（PNG、ELF……）。
 * 2. **不是合法 UTF-8**：`raw.toString("utf8")` 对非法字节序列会替换成
 *    U+FFFD，而不是抛错——把结果重新编码回 UTF-8 若与 `raw` 不逐字节相等，
 *    说明刚才的解码发生了有损替换，`raw` 本来就不是合法 UTF-8（I1 复现：
 *    一个 Latin-1 编码、高位字节但不含 NUL 的文件，纯 NUL 检查完全放行）。
 *
 * **两处调用点都必须用这同一个判据**（I1 的核心）：`repoRead` 用它决定要不要
 * 把文件内容读给模型；`repoEdit` 的 modify 分支必须**独立**再判一次，不能只
 * 依赖「sha256 对不对得上」——sha256 校验的是「staleness」（内容有没有变），
 * 不是「能不能安全地当文本改写」。此前 `repoEdit` 完全没有这一层：它把磁盘内容
 * 当 UTF-8 解码、哈希、和 `expectedSha256` 比对，只要两者算出的哈希恰好相等
 * （因为都用同一套「解码再按 utf8 重新编码」的算法，对同一份原始字节必然算出
 * 相同结果，无论那份字节是不是合法 UTF-8），就会用模型给的新内容整份覆盖掉
 * 原始二进制字节——即使 `repoRead` 一开始就会拒绝读这份内容。
 */
function isBinary(raw: Buffer): boolean {
  return raw.includes(0) || !Buffer.from(raw.toString("utf8"), "utf8").equals(raw);
}

/**
 * 读一个仓库内文件。
 *
 * **`sha256` 永远是完整文件的哈希，即使 `content` 被截断。** 它的用途是
 * `repoEdit` 的 staleness 校验（规格 §5.6）；若返回截断内容的哈希，
 * 模型拿它回来改文件会永远对不上。
 */
export function repoRead(
  root: string,
  relativePath: string,
  opts?: { maxBytes?: number; lineRange?: [number, number] },
): ReadResult {
  const abs = resolveInRepo(root, relativePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new EditError("FILE_NOT_FOUND", `文件不存在：${relativePath}`);
  }
  // 按字节读、按字节判定，再决定要不要解成字符串。
  // 直接 readFileSync(abs,"utf8") 会把非法字节换成 U+FFFD，而 repoEdit 的 staleness
  // 校验哈希的是同一个解码结果 —— sha256 会「对得上」，modify 于是放行，二进制文件
  // 被一堆 U+FFFD 覆盖。S0 没有 Checkpoint（§5.3），这一步不可逆。
  const raw = readFileSync(abs);
  if (raw.byteLength > MAX_READ_BYTES) {
    throw new EditError("INVALID_INPUT", `${relativePath} 超过 ${MAX_READ_BYTES} 字节，拒绝整文件读入`);
  }
  if (isBinary(raw)) {
    throw new EditError(
      "INVALID_INPUT",
      `${relativePath} 是二进制文件（含 NUL 字节，或不是合法 UTF-8）；S0 的读写工具只处理文本`,
    );
  }
  const full = raw.toString("utf8");
  const digest = sha256OfBuffer(raw);
  const lines = full.split("\n");

  let body = full;
  let truncated = false;
  if (opts?.lineRange) {
    const [from, to] = opts.lineRange;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new EditError("INVALID_INPUT", `lineRange 非法：[${from}, ${to}]`);
    }
    body = lines.slice(from - 1, to).join("\n");
    // full.split("\n") 在文件以换行结尾时会多出一个幻影空行（"a\n".split("\n") ===
    // ["a", ""]）；不扣掉它，读到真正的文件末尾也会被误判成 truncated。
    truncated = from > 1 || to < lines.length - (full.endsWith("\n") ? 1 : 0);
  }

  const capped = truncateText(body, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  return {
    truncated: truncated || capped.truncated,
    path: relativePath,
    sha256: digest,
    bytes: raw.byteLength,
    totalLines: lines.length,
    content: capped.text,
  };
}

export type EditOp =
  | { op: "create"; path: string; content: string }
  | { op: "modify"; path: string; content: string; expectedSha256: string }
  | { op: "move"; from: string; to: string };

export interface EditResult {
  applied: { op: string; path: string; sha256: string | null }[];
}

/** 一个 op 涉及的所有仓库内相对路径（move 有两个） */
function pathsOf(op: EditOp): string[] {
  return op.op === "move" ? [op.from, op.to] : [op.path];
}

/**
 * 批量修改仓库文件。**不支持删除**（规格 §5.3）。
 *
 * **先全量校验、再逐个落盘。** S0 没有事务性 patch（留 S1），所以落盘过程中
 * 出现 I/O 错误仍会留下改了一半的状态；但一个**非法**的 op 绝不会导致部分应用，
 * 因为所有校验都在第一次写之前完成。这两者的区别很重要：前者是已知缺口，
 * 后者会是缺陷。
 */
export function repoEdit(root: string, ops: readonly EditOp[], rules: DenyRules): EditResult {
  if (ops.length === 0) throw new EditError("INVALID_INPUT", "ops 不能为空");

  // ── 阶段一：全量校验，不碰磁盘内容 ──
  // `seen` 按**解析后的绝对路径**去重，不按原始字符串：`x.ts` 与 `./x.ts` 是同一个文件，
  // 按字符串去重会让同一批里的第二个 op 静默覆盖第一个（已实测）。
  const seen = new Set<string>();
  const resolved: { op: EditOp; abs: string; absTo?: string }[] = [];

  for (const op of ops) {
    if (op.op !== "create" && op.op !== "modify" && op.op !== "move") {
      throw new EditError("INVALID_INPUT", `不支持的 op：${JSON.stringify((op as { op: unknown }).op)}`);
    }

    const abses: string[] = [];
    for (const p of pathsOf(op)) {
      assertWritable(p, rules);                // 廉价前置判定，报错引用模型给的原始路径
      const a = resolveInRepo(root, p);        // 路径物理安全：穿越 / 绝对 / 符号链接逃逸
      assertWritableResolved(root, a, rules);  // 规格 §4.6：resolveInRepo **之后**再过一道
      if (seen.has(a)) {
        throw new EditError("INVALID_INPUT", `同一批中对 ${p} 有多个操作；请拆成多次调用`);
      }
      seen.add(a);
      abses.push(a);
    }

    if (op.op === "move") {
      const from = abses[0]!;
      const to = abses[1]!;
      if (!existsSync(from)) throw new EditError("FILE_NOT_FOUND", `源文件不存在：${op.from}`);
      if (existsSync(to)) throw new EditError("FILE_EXISTS", `目标已存在：${op.to}`);
      resolved.push({ op, abs: from, absTo: to });
      continue;
    }

    const abs = abses[0]!;
    if (op.op === "create") {
      if (existsSync(abs)) {
        throw new EditError("FILE_EXISTS", `文件已存在：${op.path}。修改已有文件请用 modify。`);
      }
    } else {
      if (!existsSync(abs)) throw new EditError("FILE_NOT_FOUND", `文件不存在：${op.path}`);
      // I1：modify 分支此前完全没有二进制守卫，只靠 sha256 是否对得上——而
      // sha256 校验的是 staleness，不是「这份内容能不能安全地当文本改写」。
      // 按原始字节读、按原始字节判定是否二进制，两条都要在与 expectedSha256
      // 比较**之前**做：即使调用方碰巧算出了一个匹配的哈希（例如拿 repoRead
      // 返回的哈希——modify 这里也必须独立拒绝，不能信任上游已经拒过一次）。
      const rawExisting = readFileSync(abs);
      if (isBinary(rawExisting)) {
        throw new EditError(
          "INVALID_INPUT",
          `${op.path} 是二进制文件（含 NUL 字节，或不是合法 UTF-8）；S0 的读写工具只处理文本，` +
            `modify 不能用于二进制文件——即使提供的 sha256 恰好与它匹配。`,
        );
      }
      const actual = sha256OfBuffer(rawExisting);
      if (actual !== op.expectedSha256) {
        throw new EditError(
          "STALE_FILE",
          `${op.path} 自上次读取后已改变。请重新 read 取得最新 sha256 后再改 —— ` +
            `否则你会用旧内容覆盖掉中间的修改。`,
        );
      }
    }
    resolved.push({ op, abs });
  }

  // ── 阶段二：落盘 ──
  const applied: EditResult["applied"] = [];
  for (const r of resolved) {
    if (r.op.op === "move") {
      mkdirSync(dirname(r.absTo!), { recursive: true });
      renameSync(r.abs, r.absTo!);
      applied.push({ op: "move", path: r.op.to, sha256: null });
    } else {
      mkdirSync(dirname(r.abs), { recursive: true });
      writeFileSync(r.abs, r.op.content, "utf8");
      applied.push({ op: r.op.op, path: r.op.path, sha256: sha256Of(r.op.content) });
    }
  }
  return { applied };
}
