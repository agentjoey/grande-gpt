import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Layout } from "./layout.ts";

export class PathSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    // `.code` 是结构化字段，供调用方按码分支、供响应信封 `{code, message}` 使用——
    // 不再把 code 前缀进 message：那样会在信封里把 code 重复一遍（每个错误、每个
    // 工具都重复一次），而且 `toThrow(/PATH_ESCAPE/)` 是对 message 做正则匹配，
    // 一个普通 `Error("PATH_ESCAPE: x")` 也能匹配上，并不能证明真的抛出的是
    // PathSecurityError。code 放进 `name`：stack trace 和日志里仍能一眼看出是
    // 哪一类拒绝——对齐 Node 自己的惯例（`err.code === "ERR_INVALID_ARG_TYPE"`，
    // 但 `err.message` 不含它，code 走的是 `name` 这一行)。
    this.name = `PathSecurityError [${code}]`;
    this.code = code;
  }
}

/** 判断 child 是否真的在 parent 之下（而不是只有字符串前缀相同，如 /a/bc vs /a/b） */
function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * 执行 `fn`，把它抛出的任何非 `PathSecurityError` 错误转换成带 `.code` 的
 * `PathSecurityError`。典型触发场景：`existsSync`/`realpathSync` 之间的 TOCTOU
 * 窗口，或悬空符号链接（目标不存在，`realpathSync` 抛裸 ENOENT）。本模块任何一条
 * 失败路径都必须携带 code，裸 `Error` 不能逃出这个模块——否则响应信封的
 * `{code, message}` 没法按码分支（M5）。
 */
function guardFs<T>(fn: () => T, code: string, message: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PathSecurityError) throw e;
    throw new PathSecurityError(code, `${message}：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 路径本身是否存在于文件系统里，哪怕是一个悬空符号链接（链接这个目录项本身
 * 存在，只是它指向的目标不存在）。用 `lstatSync`（不跟随符号链接的最后一段）
 * 而不是 `existsSync`（跟随符号链接）：两者对「悬空符号链接」给出相反答案——
 * 这正是 C1 的根因，见 `realpathAllowingMissing` 的注释。
 */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 对一个可能尚不存在的路径求 canonical 形式：向上找到最近的、本身存在的祖先做
 * `realpathSync`，再把剩余部分拼回去。直接对不存在的路径 `realpathSync` 会抛
 * ENOENT，但创建新文件时目标本就不存在——不能因此拒绝。
 *
 * 用 `lexists`（`lstatSync`）而不是 `existsSync` 判断「存在」，这是 C1 的修复：
 * `existsSync` 跟随符号链接，会把「链接存在但目标不存在」（悬空符号链接）误判成
 * 「这一段路径尚不存在」，于是循环越过链接本身继续往上走，把链接的名字当成一个
 * 普通的、还未创建的路径段，拼回已经 canonical 化的祖先之下——一个指向工作区外
 * 的悬空符号链接就这样被当成工作区内的普通路径接受了，而 OS 在真正写入时仍然
 * 会跟随这个链接。用 `lexists` 时，链接本身作为一个存在的目录项，会让循环在它
 * 这一层停下（不管它指向的目标存不存在）；随后对它做的 `realpathSync` 会因为
 * 目标不存在而抛 ENOENT，由调用方转换成 `PATH_ESCAPE`（见 `resolveInRepo`），
 * 而不是被静默跨过、当作「稍后会创建的文件」放行。
 *
 * `tail.unshift(basename(existing))` 而不是按下标切片：见 I2——`dirname("/x")`
 * 等于 `"/"`，`"/"` 本身已经以分隔符结尾，按「parent 从不以分隔符结尾」假设写的
 * 切片算法在文件系统根部会多切掉一个字符，静默吞掉文件名的第一个字符。
 * `basename` 不依赖这个假设，在任何层级都正确。
 */
function realpathAllowingMissing(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!lexists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return p; // 到根了仍不存在，原样返回
    tail.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...tail);
}

/** C0 控制字符（含 NUL、换行）与 DEL。写进日志/argv 都没有合法理由，直接拒绝（I3-narrow）。 */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * `repoId` → 仓库根的绝对路径。
 *
 * `repoId` 就是 `GPT_Workspace` 下的目录名（规格 §4.2），**不是任意路径**。因此这里
 * 不做「路径拼接后再检查」，而是先否定一切含分隔符、含 `.`/`..`、绝对路径形式、
 * 控制字符、前导 `-`（argv 选项注入）、前导/尾随空白的输入——这样路径穿越在拼接
 * 之前就不可能发生（by construction，而不是拼接之后再挡）。
 *
 * 名字合法只是第一道门，不是安全边界本身：`GPT_Workspace/x` 可以是一个名字完全
 * 合法、却指向别处的符号链接——指向工作区之外，或者（更隐蔽）指向工作区**之内**
 * 一个未注册的兄弟目录（C2）。所以名字检查通过之后，仍要做一件独立的事：
 * `realpathSync` 求出真实路径，并要求它与拼接出的候选路径**完全相等**，而不只是
 * 「在工作区之下某处」。名字校验和 realpath 校验是两道独立防线，一道挡不住的
 * 输入不能指望另一道也挡得住。
 */
export function resolveRepoPath(layout: Layout, repoId: string, registered: ReadonlySet<string>): string {
  if (repoId.length === 0) {
    throw new PathSecurityError("INVALID_INPUT", "repoId 不能为空");
  }
  if (CONTROL_CHAR_RE.test(repoId)) {
    throw new PathSecurityError("INVALID_INPUT", `repoId 不能包含控制字符：${JSON.stringify(repoId)}`);
  }
  if (repoId.startsWith("-")) {
    throw new PathSecurityError(
      "INVALID_INPUT",
      `repoId 不能以 - 开头（到了 argv 里会被当成命令行选项）：${repoId}`,
    );
  }
  if (repoId.trim() !== repoId) {
    throw new PathSecurityError("INVALID_INPUT", `repoId 不能有前导/尾随空白：${JSON.stringify(repoId)}`);
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

  const real = guardFs(() => realpathSync(candidate), "REPO_NOT_FOUND", `仓库目录解析失败：${candidate}`);

  // 候选路径必须**是**自己的 realpath，而不只是「在工作区之下某处」（isUnder 曾经
  // 在这里做的判断）。isUnder 只能挡住指向工作区外的链接；挡不住指向工作区内、
  // 但未注册的兄弟目录的链接——例如 `aliased -> secret-project`，两者都是工作区
  // 的直接子目录，`isUnder(workspaceRoot, real)` 对 secret-project 仍然成立（C2）。
  // `real !== candidate` 更强，且蕴含原来那条：一个指向工作区外的符号链接，
  // 它的 realpath 显然也不等于候选路径本身。
  if (real !== candidate) {
    throw new PathSecurityError(
      "PATH_ESCAPE",
      `仓库 ${repoId} 不是工作区下的真实目录（名字合法不等于位置安全，可能经符号链接指向了别处）：${candidate} → ${real}`,
    );
  }
  // 名字检查 + realpath 相等只证明「这是工作区下一个真实存在的路径」，不证明它是
  // 目录——一个同名的普通文件如果被注册，之前会被直接当成仓库根返回（M4）。
  if (!guardFs(() => statSync(real), "REPO_NOT_FOUND", `${real} 状态获取失败`).isDirectory()) {
    throw new PathSecurityError("REPO_NOT_FOUND", `${real} 不是目录，不能作为仓库根`);
  }
  return real;
}

/**
 * 仓库内的相对路径 → 绝对路径。允许目标尚不存在（创建新文件）。
 * 解析后必须仍在仓库之内，符号链接也不能把它带出去——包括目标尚不存在的
 * （悬空）符号链接，见 `realpathAllowingMissing` 的注释（C1）。
 */
export function resolveInRepo(repoRoot: string, relativePath: string): string {
  if (relativePath.length === 0) {
    throw new PathSecurityError("INVALID_INPUT", "路径不能为空");
  }
  if (isAbsolute(relativePath)) {
    throw new PathSecurityError("INVALID_INPUT", `必须是仓库内的相对路径：${relativePath}`);
  }

  // 悬空符号链接会让 realpathAllowingMissing 在链接本身处停下，随后对它做的
  // realpathSync 因为目标不存在而抛裸 ENOENT——guardFs 把它转换成 PATH_ESCAPE，
  // 而不是让裸 Error 逃出模块（M5）。安全地说这就是穿越：这个悬空链接的目标到底
  // 在不在仓库内，我们没法证明。
  const real = guardFs(
    () => realpathAllowingMissing(resolve(repoRoot, relativePath)),
    "PATH_ESCAPE",
    `路径解析失败（常见原因：目标不存在的符号链接）：${relativePath}`,
  );
  const realRoot = guardFs(() => realpathSync(repoRoot), "PATH_ESCAPE", `仓库根解析失败：${repoRoot}`);
  if (!isUnder(realRoot, real)) {
    throw new PathSecurityError(
      "PATH_ESCAPE",
      `路径解析后落在仓库之外：${relativePath} → ${real}（仓库：${realRoot}）`,
    );
  }
  return real;
}
