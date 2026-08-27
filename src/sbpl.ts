import { dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * 一条绝对路径从自身的父目录一路向上到（但不含）`/` 的每一级。
 *
 * 白名单化读放行之后必须显式补这条链：此前 `(allow file-read*)` 把整台机器都放行了，
 * 向上遍历自然通过；改成白名单后，从 worktree 往上走到 `/Users` 就断了——实测 git
 * 报 `fatal: Invalid path '/Users': Operation not permitted`。
 *
 * 既有的 `worktreeAncestors()` 只覆盖 worktreesRoot **以下**那几级，覆盖不到这里。
 */
function pathAncestors(p: string): string[] {
  const out: string[] = [];
  let cur = dirname(p);
  while (cur !== "/" && cur !== "." && cur !== dirname(cur)) {
    out.push(cur);
    cur = dirname(cur);
  }
  return out;
}

/**
 * I3：`sbpl.ts` 里此前有两处裸 `Error`（`q()` 的相对路径校验、`buildProfile()`
 * 的空 `execRoots` 校验），二者都经由 `runSandboxed`/`startJob` 可达
 * `grande_run` 这条工具调用路径。规格 §7.1 要求任何能到达工具层的异常都带
 * 结构化 `.code`——裸 `Error` 没有，响应信封的 `{code, message}` 没法按码分支，
 * 调用方只能靠正则匹配 message（已实测：`sbpl.test.ts` 曾经就是这么测的，
 * message 文案一改这类测试就跟着悄悄失真）。形状与 `PathSecurityError` 保持
 * 一致：`.code` 是结构化字段，`name` 带码供日志/堆栈定位，`message` 保持干净。
 */
export class SbplError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `SbplError [${code}]`;
    this.code = code;
  }
}

export interface SandboxPaths {
  /** 当前任务 worktree —— 唯一可写的仓库路径 */
  worktree: string;
  /** canonical 仓库的 .git 目录。worktree 里的 .git 是个文件、指向这里，
   *  而 hooks 存放于此且为所有 worktree 共享——必须整体不可写 */
  canonicalGit: string;
  /** 本 job 的临时目录，同时用作 HOME 与 TMPDIR */
  jobTmp: string;
  /** 控制平面根（状态/配置/审计）——被审计者不能读 */
  controlRoot: string;
  /** 全部 worktree 的父目录——内容整体拒读，目录条目自身放行 stat/lstat
   *  （否则向上遍历目录树的工具在这一级直接 EPERM），再单独放行本任务的 */
  worktreesRoot: string;
  /** 允许 process-exec 的根目录列表。显式作为输入而非硬编码常量：node/pnpm 的
   *  实际安装位置因安装方式而异（官方安装器、nvm、volta、asdf、Intel/Apple
   *  Silicon Homebrew 各不相同），硬编码在换一台机器时会悄悄漏放行、
   *  报 `Operation not permitted`。本机的默认值见 sandbox.ts 的 defaultExecRoots()
   *  ——那里才是允许碰真实文件系统（realpathSync/which）的层。 */
  execRoots: string[];
  /**
   * npm `.bin` symlink 在 Seatbelt 裁决前会被解析成 `.bin` 之外的真实 target。
   * 这里只允许 `runSandboxed()` 从当前 worktree 实际 `.bin` 重新推导出的 exact target；
   * buildProfile 仍会再次验证它们位于本 worktree `node_modules` 内。
   */
  worktreeExecTargets?: string[];
  /**
   * Trusted native-toolchain closure。普通 caller 不能直接扩这些字段：production
   * `runSandboxed()` 会根据 control-plane profile 的固定 toolchain enum 重新推导。
   */
  toolchainReadRoots?: string[];
  /** 精确宿主状态文件，只允许 literal read；例如 Xcode license acceptance plist。 */
  toolchainReadFiles?: string[];
  toolchainExecTargets?: string[];
}

export interface SandboxProfileOptions {
  /**
   * Ordinary jobs are always offline. The sole broader mode is selected by trusted parent code
   * for fixed npm/pnpm dependency bootstrap argv; it is never sourced from a run profile or repo.
   */
  network?: "deny" | "package-manager-bootstrap";
}

/** SBPL 字符串字面量里只需转义反斜杠与双引号 */
function q(path: string): string {
  if (!isAbsolute(path)) {
    throw new SbplError("INVALID_INPUT", `SBPL 的 subpath 必须是绝对路径，收到：${path}`);
  }
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 真实布局是 `worktreesRoot/<repoId>/<taskId>`（见 `worktree.ts` 的
 * `join(layout.worktreesRoot, repoId, taskId)`）——worktree 与 worktreesRoot
 * 之间还夹着一层 `<repoId>` 目录。实测发现只放行 worktreesRoot 这一个 literal
 * 不够：向上遍历目录树的工具（pnpm 的 workspace-root 查找）会先经过 `<repoId>`
 * 这一级，它同样落在 `deny file-read* (subpath worktreesRoot)` 的覆盖范围内，
 * 同样的 EPERM 会在这一级重演，只是路径多一段。这里把 worktree 到
 * worktreesRoot 之间的**每一级**祖先目录都枚举出来（worktree 自己不算——它已经
 * 由后面 `(allow file-read* (subpath worktree))` 整体放行），逐个放行
 * file-read-metadata。不用 `subpath worktreesRoot` 整体放行 metadata：那样会
 * 连兄弟 `<repoId>`/`<taskId>` 目录的 stat 也放开，超出「向上遍历自己的祖先链」
 * 这个最小需求；这里只放行 worktree 实际所在的那一条祖先链。
 *
 * worktree 没有真的嵌在 worktreesRoot 之下时（不少单测 fixture 图省事没嵌套）
 * 退化为只放行 worktreesRoot 自己，不额外猜测。
 */
function worktreeAncestors(worktreesRoot: string, worktree: string): string[] {
  if (worktree !== worktreesRoot && worktree.startsWith(`${worktreesRoot}/`)) {
    const relSegments = worktree.slice(worktreesRoot.length + 1).split("/");
    relSegments.pop(); // 去掉最后一段（worktree 自己，已由整体 file-read* 覆盖）
    const ancestors = [worktreesRoot];
    let cur = worktreesRoot;
    for (const seg of relSegments) {
      cur = `${cur}/${seg}`;
      ancestors.push(cur);
    }
    return ancestors;
  }
  return [worktreesRoot];
}

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function overlaps(a: string, b: string): boolean {
  return isUnder(a, b) || isUnder(b, a);
}

function validateWorktreeExecTargets(p: SandboxPaths): string[] {
  const targets = p.worktreeExecTargets ?? [];
  const nodeModulesRoot = join(p.worktree, "node_modules");
  for (const target of targets) {
    if (!isAbsolute(target)) {
      throw new SbplError("INVALID_INPUT", `worktreeExecTargets 必须是绝对路径，收到：${target}`);
    }
    const rel = relative(nodeModulesRoot, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new SbplError(
        "INVALID_INPUT",
        `worktreeExecTargets 只能位于当前 worktree 的 node_modules 内，收到：${target}`,
      );
    }
  }
  return [...new Set(targets)].sort();
}

function validateToolchainClosure(p: SandboxPaths): { readRoots: string[]; readFiles: string[]; execTargets: string[] } {
  const readRoots = [...new Set(p.toolchainReadRoots ?? [])].sort();
  const readFiles = [...new Set(p.toolchainReadFiles ?? [])].sort();
  const execTargets = [...new Set(p.toolchainExecTargets ?? [])].sort();
  const sensitive = [p.worktree, p.canonicalGit, p.jobTmp, p.controlRoot, p.worktreesRoot];

  for (const root of readRoots) {
    if (!isAbsolute(root)) {
      throw new SbplError("INVALID_INPUT", `toolchainReadRoots 必须是绝对路径，收到：${root}`);
    }
    if (sensitive.some((value) => overlaps(value, root))) {
      throw new SbplError("INVALID_INPUT", `toolchainReadRoots 不得与任务/控制平面敏感根重叠：${root}`);
    }
  }
  for (const file of readFiles) {
    if (!isAbsolute(file)) {
      throw new SbplError("INVALID_INPUT", `toolchainReadFiles 必须是绝对路径，收到：${file}`);
    }
    if (sensitive.some((value) => isUnder(value, file))) {
      throw new SbplError("INVALID_INPUT", `toolchainReadFiles 不得位于任务/控制平面敏感根：${file}`);
    }
  }
  for (const target of execTargets) {
    if (!isAbsolute(target)) {
      throw new SbplError("INVALID_INPUT", `toolchainExecTargets 必须是绝对路径，收到：${target}`);
    }
    if (sensitive.some((value) => isUnder(value, target))) {
      throw new SbplError("INVALID_INPUT", `toolchainExecTargets 不得位于任务/控制平面敏感根：${target}`);
    }
    if (!readRoots.some((root) => isUnder(root, target)) && !p.execRoots.some((root) => isUnder(root, target))) {
      throw new SbplError(
        "INVALID_INPUT",
        `toolchainExecTargets 必须位于已批准 toolchain read root 或现有 execRoot 内：${target}`,
      );
    }
  }
  return { readRoots, readFiles, execTargets };
}

/**
 * 生成本 job 的 SBPL 策略。
 *
 * 裁决语义（2026-07-25 于 macOS 26.5.1 实测）：**按最具体规则优先，不是按书写顺序**。
 * 因此 `deny (subpath worktreesRoot)` + `allow (subpath worktree)` 能实现
 * 「只见自己、不见他人」，且新建的 worktree 自动被父目录的 deny 覆盖，
 * 无需在每次 job 启动时枚举其他任务。
 *
 * 读权限整体放宽（除控制平面根与他人 worktree 外），因为 node/npm/tsc 会读大量
 * 意想不到的系统路径，逐目录白名单会陷入无穷调试；而普通 job 全禁网意味着读到的
 * 东西出不去。GG-BL-031 唯一例外是 fixed npm/pnpm bootstrap：它仍使用同一套文件系统
 * 与 process-exec 边界，只把 network 从 deny 切到 allow，且该选项不来自 profile/repo。
 */
export function buildProfile(p: SandboxPaths, options: SandboxProfileOptions = {}): string {
  if (p.execRoots.length === 0) {
    throw new SbplError(
      "INVALID_INPUT",
      "execRoots 不能为空：空数组会让 (allow process-exec) 退化成不带过滤条件的规则，等于放行一切可执行文件",
    );
  }
  const network = options.network ?? "deny";
  if (network !== "deny" && network !== "package-manager-bootstrap") {
    throw new SbplError("BAD_CONFIG", `未知 sandbox network mode：${String(network)}`);
  }
  const worktreeExecTargets = validateWorktreeExecTargets(p);
  const toolchain = validateToolchainClosure(p);
  // worktreeAncestors 只覆盖 worktreesRoot **以下**那几级；白名单化读放行之后还要补
  // worktreesRoot 与 canonicalGit 各自往上直到 `/` 的每一级，否则 git 向上找仓库根时
  // 在 `/Users` 就断了（实测 `fatal: Invalid path '/Users': Operation not permitted`）。
  const ancestorDirs = [
    ...worktreeAncestors(p.worktreesRoot, p.worktree),
    ...pathAncestors(p.worktreesRoot),
    ...pathAncestors(p.canonicalGit),
    ...pathAncestors(p.jobTmp),
    // execRoots 的祖先链同样要补：Node 解析 CJS 模块路径时会对每一级 realpath，
    // 一路向上走到 `/Users`。生产布局里 worktree 恰好也在 `/Users` 之下，于是这条
    // 需求被上面几条顺带满足了；测试夹具的 worktree 在 `/private/var/folders/...`，
    // 才把它暴露出来（`EPERM: operation not permitted, lstat '/Users'`，栈顶是
    // `Module._findPath`）。**不要因为生产上碰巧不复现就省掉这条。**
    ...p.execRoots.flatMap((r) => pathAncestors(r)),
    ...toolchain.readRoots.flatMap((r) => pathAncestors(r)),
    ...toolchain.readFiles.flatMap((r) => pathAncestors(r)),
  ];
  // macOS 把 /var、/tmp、/etc 做成指向 /private/... 的符号链接。调用方传进来的路径
  // 已经 realpath 过（见 sandbox.ts 的 canonicalPaths），于是这里拿到的一律是
  // `/private/var/folders/...` 这种形式；但**进程实际使用的仍是 `/var/folders/...`**
  // （cwd、argv、TMPDIR 都是未解析的原始串），解析这一步要读 `/var` 这个符号链接本身。
  //
  // 旧的无条件 `(allow file-read*)` 顺带覆盖了它，白名单化之后就断了。症状具有欺骗性：
  // 报的是**写**失败（`/bin/sh: …/a.txt: Operation not permitted`），而真正缺的是对
  // `/var` 的**读**——因为路径根本解析不到那个可写目录。
  const privateAliases = [...new Set(ancestorDirs)]
    .filter((d) => d.startsWith("/private/"))
    .map((d) => d.slice("/private".length));
  const ancestorMetadataAllows = [...new Set([...ancestorDirs, ...privateAliases])].map(
    (dir) => `(allow file-read-metadata (literal "${q(dir)}"))`,
  );
  return [
    "(version 1)",
    "(deny default)",
    network === "package-manager-bootstrap" ? "(allow network*)" : "(deny network*)",
    ...(network === "package-manager-bootstrap"
      ? [
          ";; macOS 26 resolver bootstrap: production sandboxd showed getaddrinfo failing immediately after",
          ";; this exact SystemConfiguration lookup was denied. Keep it scoped to fixed npm/pnpm bootstrap.",
          '(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration"))',
        ]
      : []),
    "",
    ";; /dev/null —— git 打开它抑制信息输出（例如 `git status --short` 的重定向），",
    ";; 且 git 内部以 O_RDWR 打开（例：pipeline 的 dup2）。",
    ";;",
    ";; 用 literal 不用 subpath：对整个 /dev 做 subpath 匹配会把整个设备树（磁盘、",
    ";; pty、dtrace 等）放行进来，不必要的 file-read* 放行让每个字符设备都暴露为",
    ";; 可读句柄。只有这一个字符设备是 git 实际需要的最小集合。",
    "(allow file-read* file-write* (literal \"/dev/null\"))",
    "",
    ";; 读：显式白名单。此前是 `(allow file-read*)` 无条件放行再挖掉两块——规格里写的是",
    ";; 「读放宽」，有意为之，但威胁模型只覆盖了「写」与「网络」两个方向，漏掉了这条：",
    ";; **沙箱内读宿主文件 → 写进 worktree → 模型 grande_repo_read 读走 → 出到 ChatGPT**。",
    ";; 网络封死使直接外传不通，worktree 中转这条通。实测确认 `~/.npmrc`（含明文",
    ";; registry token）、`~/.ssh`、`~/.aws`、工作区里别的仓库当时全部可读。",
    ";;",
    ";; 白名单只有两条**固定常量**，其余全部从输入派生——本机路径不进代码：",
    ";;   /System —— dyld 共享缓存与系统 framework。实测：删掉它，node/git/pnpm 三者",
    ";;              全部以 SIGABRT 静默中止（连错误信息都打不出来，因为动态链接器就没起来）。",
    ";;   /etc    —— git 读 /etc/gitconfig；另有 passwd/localtime 一类。注意 /etc 是",
    ";;              指向 /private/etc 的符号链接，而 Seatbelt 按**给出的路径**匹配，",
    ";;              所以放行 /private 并不能替代它（实测：只放 /private 时 git 报",
    ";;              `unable to access '/etc/gitconfig'`）。",
    ";;",
    ";; 最小性证明（实测，探针 = node -e / git rev-parse / pnpm lint / pnpm verify）：",
    ";; /usr、/bin、/sbin、/private 四条候选逐一删除后全部探针仍绿——它们被下面",
    ";; 「execRoots 及其父目录」那两条覆盖了，因此**不予保留**。",
    "(allow file-read* (subpath \"/System\"))",
    ";; /etc 与 /private/etc **两个都要写**。它们是同一份内容的两条路径（/etc 是指向",
    ";; private/etc 的符号链接），而 Seatbelt 按进程给出的路径匹配，不同程序用哪一条",
    ";; 全看它自己怎么拼：git 读 `/etc/gitconfig`，curl 读 `/private/etc/ssl/openssl.cnf`。",
    ";; 只放一条的症状是「一个工具好了另一个还坏」，而且报错完全不像权限问题",
    ";; （curl 报的是 `Auto configuration failed` 加一串 libressl 的内部路径）。",
    "(allow file-read* (subpath \"/etc\"))",
    "(allow file-read* (subpath \"/private/etc\"))",
    ";; /bin/sh uses the canonical selector spelling. Keep it globally because ordinary JS",
    ";; package-manager profiles need shell shims; the /var/select alias is toolchain-only below.",
    "(allow file-read* (subpath \"/private/var/select\"))",
    ";; Optional native-toolchain read closure is derived only from a trusted control-plane enum.",
    ";; It may include /var/select plus the active Developer Directory, never caller-provided paths.",
    ...toolchain.readRoots.map((root) => `(allow file-read* (subpath "${q(root)}"))`),
    ";; Exact host-state files stay literal-only; do not widen to their parent preference directories.",
    ...toolchain.readFiles.map((file) => `(allow file-read* (literal "${q(file)}"))`),
    ";; 根目录条目本身：动态链接器与多数工具启动时会 readdir \"/\"。这里必须是",
    ";; file-read*（含 file-read-data，对目录即 readdir），file-read-metadata 不够",
    ";; ——实测只给 metadata 时 /bin/echo 都起不来。放行的内容仅仅是「根下有哪些",
    ";; 顶层目录名」，本身不含任何用户数据。",
    "(allow file-read* (literal \"/\"))",
    ";; execRoots 必须**可读**，不只是可执行：process-exec 只管「能否执行」，而 PATH",
    ";; 逐目录查找、读 shebang 首行、dyld 读二进制本身，走的都是 file-read*。",
    ";; 实测漏掉这条的症状是 `env: pnpm: No such file or directory`——看起来像 PATH",
    ";; 配错，实际是目录读不到。",
    ...p.execRoots.map((root) => `(allow file-read* (subpath "${q(root)}"))`),
    ";; 以及每个 execRoot 的**父目录**：工具链把 libexec/share/lib 放在 bin 旁边",
    ";; （git 的子命令在 <toolchain>/libexec/git-core）。这条泛化替掉了原本要硬编码",
    ";; 的 `/Applications/Xcode.app/Contents/Developer/usr`——别的机器上可能是",
    ";; CommandLineTools 或 Homebrew，路径不该进代码。",
    ...[...new Set(p.execRoots.map((r) => dirname(r)).filter((d) => d !== "/"))].map(
      (d) => `(allow file-read* (subpath "${q(d)}"))`,
    ),
    ";; canonical 的 .git：worktree 里的 .git 是一个指向 <canonical>/.git/worktrees/<name>",
    ";; 的文件，git 任何一条命令都要顺着它读过去。写仍然是拒的（见下方 file-write* 段）。",
    `(allow file-read* (subpath "${q(p.canonicalGit)}"))`,
    ";; 这两条 deny 在白名单模型下已经冗余（没被 allow 覆盖的默认就拒），保留作纵深。",
    ";;",
    ";; ⚠️ **顺序是有意义的，且规则是「后匹配者胜」，不是「更具体者胜」。**",
    ";; 实测：把 `(allow file-read* (subpath jobTmp))` 写在下面这条 controlRoot 的 deny",
    ";; **之前**，jobTmp 就读不到了——尽管它是 controlRoot 的子路径、明显更具体。",
    ";; 症状极隐蔽：git 照常工作（它不碰 TMPDIR），node 在 InitializeOncePerProcess",
    ";; 阶段直接 SIGABRT，栈里只有 dyld，看不出跟 TMPDIR 有任何关系。",
    ";; 原实现把 worktree 的 allow 放在 worktreesRoot 的 deny 之后，靠的正是这条规则。",
    `(deny file-read* (subpath "${q(p.controlRoot)}"))`,
    `(deny file-read* (subpath "${q(p.worktreesRoot)}"))`,
    ";; 必须排在上面两条 deny 之后：jobTmp 在生产布局里位于 controlRoot 之下。",
    `(allow file-read* (subpath "${q(p.jobTmp)}"))`,
    ";; pnpm/npm/yarn/vitest/tsc 启动时都会向上遍历目录树找 workspace root/配置/",
    ";; lockfile——这一步只会 lstat/stat 经过的每一级目录，不会读它们的内容。",
    ";; `subpath` 连目录条目自身都拒，于是从 worktree 出发向上走、经过",
    ";; worktreesRoot（以及真实布局里夹在中间的 <repoId> 那一级，见",
    ";; worktreeAncestors() 的注释）时 lstat 直接 EPERM，工具还没跑测试就先死在",
    ";; 启动阶段（实测：worktree 内 `pnpm test` 100% 复现）。",
    ";; 我们真正要的隔离性质是「一个任务读不到兄弟 worktree 的内容」，不需要",
    ";; 连这条祖先链上的目录条目本身『存在、是目录、属主是谁』都不让问。",
    ";; Seatbelt 把 file-read* 拆成 file-read-metadata（stat/lstat 一类，只问",
    ";; 属性）和 file-read-data（真正读内容，对目录来说即 readdir 列出条目）",
    ";; 两个更细的操作，`literal` 又比 `subpath` 更具体——因此可以只把",
    ";; file-read-metadata 单独放行给 worktree 到 worktreesRoot 之间的每一级",
    ";; literal 路径（不是整个 worktreesRoot 的 subpath——那样会连兄弟",
    ";; <repoId>/<taskId> 目录的 stat 也放开，超出「向上遍历自己祖先链」这个",
    ";; 最小需求）：向上走的 lstat 能通过，但 file-read-data（含 readdir 列出",
    ";; 兄弟任务目录名、以及下面这条 deny 覆盖的兄弟内容）依旧被拒——AC-3 的",
    ";; 兄弟隔离不受影响。",
    ...ancestorMetadataAllows,
    `(allow file-read* (subpath "${q(p.worktree)}"))`,
    "",
    ";; 写：只有本任务 worktree 与本 job 临时目录",
    `(allow file-write* (subpath "${q(p.worktree)}"))`,
    `(allow file-write* (subpath "${q(p.jobTmp)}"))`,
    `(deny file-write* (subpath "${q(p.canonicalGit)}"))`,
    `(deny file-write* (subpath "${q(p.worktree)}/.git"))`,
    "",
    ";; 执行：根目录列表由调用方传入（见 SandboxPaths.execRoots），不是硬编码常量",
    `(allow process-exec ${p.execRoots.map((root) => `(subpath "${q(root)}")`).join(" ")})`,
    ...(network === "package-manager-bootstrap" ? ["(allow process-exec-interpreter)"] : []),
    ";; worktree 内也要放行 exec，但只到 node_modules/.bin——U2 实测：pnpm/npm 把包的可执行",
    ";; 入口（如 node_modules/.bin/vitest）生成为物理落在 worktree 内的 POSIX shell shim（不是",
    ";; 符号链接出去），`pnpm test` 经由该 shim 的 shebang 调起，因此 shim 自身必须可 exec。",
    ";; 复核发现原先放行整个 worktree 过宽：复核用同一份 135 用例套件验证，只放行",
    ";; node_modules/.bin 得到完全相同的结果（135/135 通过、exit 0），因此收窄到这一个子目录。",
    ";;",
    ";; 「放行整个 worktree 到底多让出了什么」——之前的注释声称『并未新增可达的攻击面』，",
    ";; 这个说法不成立，已用实测推翻：把一个新编译、未签名的 Mach-O 二进制放进 worktree 里",
    ";; （不在 .bin 下），没有本条规则时 exec 被拒（sandbox-exec 报 `Operation not permitted`，",
    ";; exit 71）；放行整个 worktree 后同一个二进制能被直接 exec（exit 0）。这与「shell 脚本",
    ";; 本来就能跑」不是一回事：`sh script.sh` 这种写法从不对 script.sh 本身发起 execve——",
    ";; 解释器 /bin/sh 已经在 execRoots 里被信任，脚本内容只是被当数据 read() 进去；但",
    ";; `pnpm test` 触发的是 shim 文件自身的 execve（内核处理 #! 这一步），跟 node_modules/.bin",
    ";; 之外新扔一个二进制文件、直接执行它，是完全相同性质的操作。所以放行整个 worktree 的",
    ";; 真实边际效果是『worktree 里任何位置放一个自包含可执行文件都能被直接启动』——不是",
    ";; 『反正已经能跑图灵完备代码所以无所谓』。收窄到 node_modules/.bin 后，worktree 其余",
    ";; 位置新增的可执行文件依旧被拒（同上，exit 71），只有这一个目录例外。",
    ";;",
    ";; 已知局限：.bin 单目录放行是针对 poc/（非 pnpm workspace，只有一层 node_modules/.bin）",
    ";; 验证的。若生产环境目标是 pnpm workspace/monorepo，会有多个",
    ";; packages/*/node_modules/.bin，需要递归匹配（例如按 glob 枚举各包目录后逐条放行，或",
    ";; 换一种从子目录到根的匹配策略）——这不是把这一行 subpath 换个路径就能覆盖的，是需要",
    ";; 单独设计的后续工作，S0-C 实现前必须先确认目标仓库的 workspace 布局。",
    `(allow process-exec (subpath "${q(join(p.worktree, "node_modules", ".bin"))}"))`,
    ";; npm 的 `.bin` 常是 symlink。Seatbelt 在 process-exec 前解析真实 target，所以 `.bin`",
    ";; subpath 本身覆盖不到 target。这里只补 `runSandboxed()` 从当前 `.bin` 推导并经",
    ";; node_modules containment 双重验证的 exact literal；不放开整个 node_modules/worktree。",
    ...worktreeExecTargets.map((target) => `(allow process-exec (literal "${q(target)}"))`),
    ";; Native toolchain executables remain exact literals; never authorize an entire Developer/bin subtree.",
    ...toolchain.execTargets.map((target) => `(allow process-exec (literal "${q(target)}"))`),
    "(allow process-fork)",
    "(allow sysctl-read)",
    "",
    ";; vitest 默认 pool: forks 在收尾阶段会 kill() 自己 fork 出的子进程；(deny default) 下这个",
    ";; 自我发信号被拒（EPERM），vitest 退回逐 worker 超时等待，实测让真实 135 用例套件耗时",
    ";; 从 580ms（有这条规则）暴涨到 10702ms（没有，约 18.5 倍），量级与首轮报告的",
    ";; 0.55s（宿主机）vs 10.7s（沙箱、无信号规则）一致，同一个瓶颈。",
    ";; 加这条前独立验证过三条安全性质（均通过，见 findings/U2-seatbelt.md）：",
    ";; 1) 同一 sandbox 内自我发信号成功；2) 沙箱内进程对沙箱外、哪怕同 uid 的宿主进程",
    ";; 发信号依旧被拒；3) 两个独立 sandbox-exec 调用（模拟两个并发 job）互相发信号依旧被拒。",
    ";; `same-sandbox` 是按 sandbox 实例（这次调用 sandbox-exec 生成的那一个容器）区分的，",
    ";; 不是按 uid，所以收益只覆盖「进程信自己」，不会让任务间或沙箱内外的隔离松动。",
    "(allow signal (target same-sandbox))",
    "",
  ].join("\n");
}
