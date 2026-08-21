import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditHandle } from "./audit.ts";
import { createCheckpoint, restoreCheckpoint } from "./checkpoint.ts";
import { truncateText } from "./envelope.ts";
import type { Layout } from "./layout.ts";
import { resolveInRepo } from "./paths.ts";
import { assertWritable, assertWritableResolved, type DenyRules } from "./policy.ts";
import { moveToTrash } from "./trash.ts";

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
  nextLine: number | null;
  lastLineTruncated: boolean;
  path: string;
  sha256: string;
  bytes: number;
  totalLines: number;
  content: string;
}

export const DEFAULT_REPO_READ_BYTES = 16 * 1024;
export const MAX_REPO_READ_BYTES = 24 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

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
  const maxBytes = opts?.maxBytes ?? DEFAULT_REPO_READ_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_REPO_READ_BYTES) {
    throw new EditError(
      "INVALID_INPUT",
      `maxBytes 必须是 1..${MAX_REPO_READ_BYTES} 的整数，收到：${String(maxBytes)}`,
    );
  }
  const abs = resolveInRepo(root, relativePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new EditError("FILE_NOT_FOUND", `文件不存在：${relativePath}`);
  }
  // 按字节读、按字节判定，再决定要不要解成字符串。
  // 直接 readFileSync(abs,"utf8") 会把非法字节换成 U+FFFD，而 repoEdit 的 staleness
  // 校验哈希的是同一个解码结果 —— sha256 会「对得上」，modify 于是放行，二进制文件
  // 被一堆 U+FFFD 覆盖。S0 没有 Checkpoint（§5.3），这一步不可逆。
  const raw = readFileSync(abs);
  if (raw.byteLength > MAX_FILE_BYTES) {
    throw new EditError("INVALID_INPUT", `${relativePath} 超过 ${MAX_FILE_BYTES} 字节，拒绝整文件读入`);
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
  const actualTotalLines = lines.length - (full.endsWith("\n") ? 1 : 0);

  let body = full;
  let truncated = false;
  let startLine = 1;
  let endLine = actualTotalLines;
  if (opts?.lineRange) {
    const [from, to] = opts.lineRange;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new EditError("INVALID_INPUT", `lineRange 非法：[${from}, ${to}]`);
    }
    startLine = from;
    endLine = Math.min(to, actualTotalLines);
    body = lines.slice(from - 1, to).join("\n");
    // full.split("\n") 在文件以换行结尾时会多出一个幻影空行（"a\n".split("\n") ===
    // ["a", ""]）；不扣掉它，读到真正的文件末尾也会被误判成 truncated。
    truncated = from > 1 || to < actualTotalLines;
  }

  const capped = truncateText(body, maxBytes);
  const returnedNewlines = capped.text.match(/\n/g)?.length ?? 0;
  const returnedBytes = Buffer.byteLength(capped.text, "utf8");
  const nextSourceByte = Buffer.from(body, "utf8")[returnedBytes];
  const lastLineTruncated = capped.truncated && !capped.text.endsWith("\n") && nextSourceByte !== 0x0a;
  const nextCandidate = capped.truncated
    ? startLine + returnedNewlines + (capped.text.endsWith("\n") ? 0 : 1)
    : endLine + 1;
  const nextLine = nextCandidate <= actualTotalLines ? nextCandidate : null;
  return {
    truncated: truncated || capped.truncated,
    nextLine,
    lastLineTruncated,
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
  | { op: "move"; from: string; to: string }
  | { op: "delete"; path: string; expectedSha256: string };

export interface EditResult {
  checkpointId: string;
  applied: { op: string; path: string; sha256: string | null }[];
}

/** 一个 op 涉及的所有仓库内相对路径（move 有两个） */
function pathsOf(op: EditOp): string[] {
  return op.op === "move" ? [op.from, op.to] : [op.path];
}

/**
 * `repoEdit` 建 checkpoint / 移入 Trash 所需的控制平面上下文。
 *
 * 遗留 #6/#7：这两样原先是**在函数内部自己拿的**——`layout` 来自
 * `loadLayout()`（读全局环境变量的模块级配置），`taskId` 来自 `basename(root)`。
 *
 * 后者引入了一条**签名上完全看不见的前置条件**：「root 的最后一段必须是一个
 * 合法 taskId」。安全上没有洞（root 来自库里的 `task.worktreePath`，且
 * `createCheckpoint` / `moveToTrash` 内部都会再 `assertTaskId`），但它意味着
 * 任何人想复用 repoEdit 都得先知道这条不成文的约定，而编译器不会提醒他。
 *
 * 前者则让一个「只依赖入参」的函数变成了读全局配置的函数——测试要构造它必须
 * 先摆好环境变量，复用它必须接受它去读你没打算给它的那份布局。
 */
export interface EditContext {
  layout: Layout;
  /** 这批编辑归属的任务。**显式传，不再从 root 的最后一段猜。** */
  taskId: string;
}

/**
 * 批量修改仓库文件。支持 create、modify、move 与可恢复的 delete。
 *
 * 先全量校验，再为本批涉及的路径建立 checkpoint，最后逐个落盘。写阶段任一步
 * 抛错都会先尝试恢复 checkpoint，再把导致失败的原始错误重新抛出；回滚自己的
 * 错误只记日志，不能掩盖调用方真正需要处理的那一个错误。
 */
export function repoEdit(
  root: string,
  ops: readonly EditOp[],
  rules: DenyRules,
  audit: AuditHandle,
  ctx: EditContext,
): EditResult {
  if (ops.length === 0) throw new EditError("INVALID_INPUT", "ops 不能为空");

  try {
    // ── 阶段一：全量校验，不碰磁盘内容 ──
    // `seen` 按**解析后的绝对路径**去重，不按原始字符串：`x.ts` 与 `./x.ts` 是同一个文件，
    // 按字符串去重会让同一批里的第二个 op 静默覆盖第一个（已实测）。
    const seen = new Set<string>();
    const resolved: { op: EditOp; abs: string; absTo?: string }[] = [];

    for (const op of ops) {
      if (op.op !== "create" && op.op !== "modify" && op.op !== "move" && op.op !== "delete") {
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
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          throw new EditError("FILE_NOT_FOUND", `文件不存在：${op.path}`);
        }
        if (typeof op.expectedSha256 !== "string" || op.expectedSha256.length === 0) {
          throw new EditError("INVALID_INPUT", `${op.op} 必须提供 expectedSha256`);
        }
        const rawExisting = readFileSync(abs);
        if (op.op === "modify" && isBinary(rawExisting)) {
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
            `${op.path} 自上次读取后已改变。请重新 read 取得最新 sha256 后再${op.op === "delete" ? "删除" : "改"} —— ` +
              `否则你会基于旧内容覆盖或删除中间的修改。`,
          );
        }
      }
      resolved.push({ op, abs });
    }

    // 推进审计句柄到 EXECUTING —— 必须在 checkpoint 与写盘之前成功
    if (!audit.executing()) {
      throw new EditError("POLICY_DENIED", "审计句柄推进失败——Policy 未放行或已被他人使用。");
    }

    const { layout, taskId } = ctx;
    const affectedPaths = resolved.flatMap((r) => pathsOf(r.op));
    const checkpointId = createCheckpoint(layout, taskId, root, affectedPaths);

    // ── 阶段二：落盘；失败时恢复本批 checkpoint ──
    const applied: EditResult["applied"] = [];
    try {
      for (const r of resolved) {
        if (r.op.op === "move") {
          mkdirSync(dirname(r.absTo!), { recursive: true });
          renameSync(r.abs, r.absTo!);
          applied.push({ op: "move", path: r.op.to, sha256: null });
        } else if (r.op.op === "delete") {
          moveToTrash(layout, taskId, root, r.op.path);
          applied.push({ op: "delete", path: r.op.path, sha256: null });
        } else {
          mkdirSync(dirname(r.abs), { recursive: true });
          writeFileSync(r.abs, r.op.content, "utf8");
          applied.push({ op: r.op.op, path: r.op.path, sha256: sha256Of(r.op.content) });
        }
      }
    } catch (writeError) {
      try {
        restoreCheckpoint(layout, taskId, root, checkpointId);
      } catch (rollbackError) {
        try {
          console.error(
            `[repoEdit] checkpoint ${checkpointId} 回滚失败；保留并重新抛出原始写入错误：` +
              `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        } catch {
          // 日志通道本身也不能掩盖原始写入错误。
        }
      }
      throw writeError;
    }

    audit.succeeded(resolved.map((r) => (r.op.op === "move" ? r.op.to : r.op.path)));
    return { checkpointId, applied };
  } catch (e) {
    audit.failed(String(e instanceof Error ? e.message : e));
    throw e;
  }
}
