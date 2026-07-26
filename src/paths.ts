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
 * 判断一个错误是否携带 errno 风格的 `.code`（`ENOENT`/`ELOOP`/`EACCES`/……）——
 * 这是「一次真实的 fs 调用失败」的标志。用来把它和「这段代码本身有 bug」
 * （比如一个 `TypeError`）区分开：后者不该被 `guardFs` 吞成一个策略拒绝
 * （round 2 复审 C）。
 */
function hasErrnoCode(e: unknown): e is Error & { code: string } {
  return e instanceof Error && typeof (e as { code?: unknown }).code === "string";
}

/**
 * 执行 `fn`，把它抛出的、携带 errno 风格 `.code` 的错误转换成带 `.code` 的
 * `PathSecurityError`；不带 errno `.code` 的错误（比如编程错误 `TypeError`）
 * 原样重新抛出，不转换（round 2 复审 C——窄化前这里曾经不加区分地转换任何
 * 错误，一个真正的 bug 也会被伪装成「策略拒绝」，而不是暴露成需要修的问题）。
 * 典型触发场景：`existsSync`/`realpathSync` 之间的 TOCTOU 窗口，或悬空符号链接
 * （目标不存在，`realpathSync` 抛裸 ENOENT）。本模块每一条因为 fs 调用失败而
 * 产生的拒绝都必须携带 code，裸 `Error` 不能逃出这个模块——否则响应信封的
 * `{code, message}` 没法按码分支（M5）。
 */
function guardFs<T>(fn: () => T, code: string, message: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PathSecurityError) throw e;
    if (!hasErrnoCode(e)) throw e;
    throw new PathSecurityError(code, `${message}：${e.message}`);
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
 * 双向覆盖/隔离/标记字符 + 零宽空格 + Unicode 行/段分隔符——都不在 C0 范围内，
 * `CONTROL_CHAR_RE` 挡不住，但同样没有合法的目录名用途（round 2 复审 B）：
 * bidi override（如 U+202E RLO）能让目录名在终端/UI 里显示成误导性的顺序；
 * U+2028/U+2029 一旦被拼进按行处理的日志或文本，效果等同于换行注入；U+200B
 * 零宽空格纯粹用来让两个视觉上相同的名字实际不同。`trim()` 只挡首尾，挡不住
 * 出现在字符串内部的这些字符（比如 "我的" + U+200B + "项目"）。刻意保持极窄，
 * 不做 ASCII allowlist——那样 "我的项目" 这样合法的非 ASCII 目录名会被一起
 * 挡下来。字符集全部用 \u 转义写出、不在源码里直接嵌入不可见字符——这正是
 * 本检查要挡的那类问题，源码自己不能先犯。
 *
 * 覆盖范围：U+200B ZWSP；U+200E/U+200F LRM/RLM；U+202A-U+202E bidi 嵌入/覆盖/
 * 弹出（含 U+202E RLO）；U+2066-U+2069 bidi 隔离符；U+2028/U+2029 行/段分隔符；
 * U+061C 阿拉伯字母标记。不含 ZWNJ/ZWJ（U+200C/U+200D）——它们在部分文字（如
 * 阿拉伯语、印地语连字）里有合法排版用途，划进来会重蹈 ASCII allowlist 的覆辙。
 */
const SPOOFING_CHAR_RE = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\u061c]/;

/**
 * `repoId`／`relativePath` 共用：拒绝任何位置的控制字符。整串扫描而不是逐段
 * 扫描——`/` 本身不是控制字符，二者结果完全一致，整串更简单（round 2 复审
 * BLOCKING 2）。两个输入都是模型可控字符串，都可能流入审计记录、日志行、
 * hint 文本：换行能伪造日志行；NUL 会产生一个 Node 拒绝而不是截断的毒化返回
 * 值，若不在这里挡住，会在调用方下一次 fs 调用时炸出没有 `.code` 的裸
 * `ERR_INVALID_ARG_VALUE`——这正是 M5「每条失败都带 code」想堵住的那类泄漏。
 */
function assertNoControlChars(s: string, label: string): void {
  if (CONTROL_CHAR_RE.test(s)) {
    throw new PathSecurityError("INVALID_INPUT", `${label} 不能包含控制字符：${JSON.stringify(s)}`);
  }
}

/**
 * `repoId`／`relativePath` 的每一段共用：拒绝以 `-` 开头——这个值一旦原样被
 * 传给某个命令当参数，会被当成选项而不是路径/名字（round 2 复审 BLOCKING 2）。
 * `repoId` 本身只有一段，调用一次；`relativePath` 可能有多段，逐段调用。
 */
function assertNoLeadingDash(segment: string, label: string): void {
  if (segment.startsWith("-")) {
    throw new PathSecurityError(
      "INVALID_INPUT",
      `${label} 不能以 - 开头（到了 argv 里会被当成命令行选项）：${JSON.stringify(segment)}`,
    );
  }
}

/**
 * `repoId` → 仓库根的绝对路径。
 *
 * `repoId` 就是 `GPT_Workspace` 下的目录名（规格 §4.2），**不是任意路径**。因此这里
 * 不做「路径拼接后再检查」，而是先否定一切含分隔符、含 `.`/`..`、绝对路径形式、
 * 控制字符、显示欺骗字符（bidi override/零宽空格/行分隔符，round 2 复审 B）、
 * 前导 `-`（argv 选项注入）、前导/尾随空白的输入——这样路径穿越在拼接之前就不
 * 可能发生（by construction，而不是拼接之后再挡）。
 *
 * 名字合法只是第一道门，不是安全边界本身：`GPT_Workspace/x` 可以是一个名字完全
 * 合法、却指向别处的符号链接——指向工作区之外，或者（更隐蔽）指向工作区**之内**
 * 一个未注册的兄弟目录（C2）。所以名字检查通过之后，仍要做一件独立的事：
 * `realpathSync` 求出真实路径，并要求它与拼接出的候选路径**完全相等**，而不只是
 * 「在工作区之下某处」。名字校验和 realpath 校验是两道独立防线，一道挡不住的
 * 输入不能指望另一道也挡得住。
 *
 * 前置条件：`layout.workspaceRoot` 必须已经是 canonical 路径。下面 `real !==
 * candidate` 这条恒等检查依赖这一点才成立；`loadLayout()` 对 `workspaceRoot`
 * 做过 `realpathSync`，保证了它（round 2 复审 C——这里只补 JSDoc，不加运行时
 * 校验）。
 */
export function resolveRepoPath(layout: Layout, repoId: string, registered: ReadonlySet<string>): string {
  if (repoId.length === 0) {
    throw new PathSecurityError("INVALID_INPUT", "repoId 不能为空");
  }
  assertNoControlChars(repoId, "repoId");
  if (SPOOFING_CHAR_RE.test(repoId)) {
    throw new PathSecurityError(
      "INVALID_INPUT",
      `repoId 不能包含双向覆盖/零宽空格/行分隔符等显示欺骗字符：${JSON.stringify(repoId)}`,
    );
  }
  assertNoLeadingDash(repoId, "repoId");
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
 *
 * `relativePath` 和 `repoId` 一样是模型可控字符串（round 2 复审 BLOCKING 2）：
 * 同样拒绝控制字符（整串扫描，与 `repoId` 共用 `assertNoControlChars`）和每一
 * 段开头的 `-`（`repoId` 前导 `-` 检查的类比——这个值可能被原样传给某个命令
 * 当参数）。不检查首尾空白：路径分段里的空格是合法文件名的一部分（例如
 * "my file.txt"），逐段 trim 会连带拒掉这类合法输入。不检查显示欺骗字符
 * （bidi/零宽/行分隔符）——那一项目前只加在 `repoId` 上（round 2 复审 B 的
 * 范围本就限定在 `repoId`），未在此扩展。
 */
export function resolveInRepo(repoRoot: string, relativePath: string): string {
  if (relativePath.length === 0) {
    throw new PathSecurityError("INVALID_INPUT", "路径不能为空");
  }
  if (isAbsolute(relativePath)) {
    throw new PathSecurityError("INVALID_INPUT", `必须是仓库内的相对路径：${relativePath}`);
  }
  assertNoControlChars(relativePath, "relativePath");
  for (const segment of relativePath.split("/")) {
    assertNoLeadingDash(segment, "relativePath 的路径分段");
  }

  // 悬空符号链接会让 realpathAllowingMissing 在链接本身处停下，随后对它做的
  // realpathSync 因为目标不存在而抛裸 ENOENT——guardFs 把它转换成 PATH_ESCAPE，
  // 而不是让裸 Error 逃出模块（M5）。
  //
  // 这也会拒绝目标其实在仓库内的悬空链接（例如 repo/alias.ts -> repo/real.ts，
  // real.ts 还没创建）——这不是因为没法判断目标在哪儿：`readlinkSync` 能读出
  // 目标，对它套用同一套 containment 检查完全可以证明目标在不在仓库内。这里是
  // **选择**不做这层解析（round 2 复审后的决定，未实现）：要在整个系统里安全
  // 敏感度最高的函数里再加一段「跟着链接链走」的逻辑，换来的只是修掉一个假
  // 阳性——对真实工作区的普查显示这个假阳性目前不咬人（340 个符号链接，0 个
  // 悬空），而且拒绝的方向是安全的失败方向（该放行的路径被拒，好过该拒绝的
  // 路径被放行）。真咬人了再做。当前行为（目标在仓库内的悬空链接也照样被拒）
  // 已用测试钉住，见 tests/paths.test.ts 里标注「round 2 A」的两个用例，防止
  // 以后不知不觉翻转。
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
