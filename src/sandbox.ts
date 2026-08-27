import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { buildNativeExecSbplRules, resolveNativeExecTargets } from "./nativeExecTargets.ts";
import { resolveNativeToolchainClosure, type NativeToolchain } from "./nativeToolchain.ts";
import { buildProfile, type SandboxPaths } from "../src/sbpl.ts";

/**
 * I3：`assertOnDiskSpelling` 此前抛裸 `Error`，同样经由 `runSandboxed` 可达
 * `grande_run`。形状与 `PathSecurityError`/`SbplError` 保持一致——见 `sbpl.ts`
 * 里 `SbplError` 的 JSDoc，理由相同，不重复。
 */
export class SandboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `SandboxError [${code}]`;
    this.code = code;
  }
}

export interface RunOptions {
  argv: string[];
  cwd: string;
  paths: SandboxPaths;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Only a trusted control-plane profile may opt in; the resolver accepts no caller paths/argv. */
  toolchain?: NativeToolchain;
  /** Trusted profile declarations; resolved only against the current task worktree to exact literals. */
  nativeExecTargets?: readonly string[];
  /**
   * Internal-only GG-BL-031 capability. This field is never populated from RunProfile or MCP input;
   * the dependency bootstrap helper selects it together with fixed npm/pnpm argv.
   */
  networkPolicy?: "package-manager-bootstrap";
  /** 进程组总 RSS 上限（MB）。省略则不做内存兜底 */
  maxRssMb?: number;
  /** 在子进程 spawn 后同步回调，传入 pgid —— 调用方不需要 await 就能拿到 pgid */
  onSpawn?: (pgid: number) => void;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  killedBy: null | "timeout" | "rss";
  /** killGroup 被触发时，若 child.pid 从未产生（pgid 退化为 0），信号从未真正
   *  发出——process.kill(-0, …) 按 POSIX 语义会打到调用者自己的进程组，宁可
   *  什么都不做也不能冒这个险。正常路径（拿到了 pid）恒为 false。 */
  killSignalSkipped: boolean;
  durationMs: number;
  peakRssMb: number;
}

/** 每 2 秒采一次进程组总 RSS。这不是 cgroup——采样窗口内仍可冲高，是已接受的取舍 */
const RSS_POLL_MS = 2000;

function groupRssMb(pgid: number): number {
  try {
    const out = execFileSync("/bin/ps", ["-o", "rss=", "-g", String(pgid)], { encoding: "utf8" });
    const kb = out.split("\n").reduce((s, l) => s + (Number(l.trim()) || 0), 0);
    return Math.round(kb / 1024);
  } catch {
    return 0;
  }
}

/** 托管基础 coreutils（sh、cat、env、curl……）的系统路径，任何安装方式下都存在 */
const STANDARD_EXEC_ROOTS = ["/usr/bin", "/bin", "/usr/sbin"];

/** 需要在沙箱里放行的包管理器二进制。逐个用 `which` 探测——某个名字在本机
 *  没装（比如没有独立的 npx）就跳过，不是错误。 */
const PACKAGE_MANAGER_BINARIES = ["pnpm", "npm", "npx", "git"];

/**
 * BUG 2 实测复现（本机 2026-07-28）：`which pnpm` → `~/.local/bin/pnpm`，
 * 是个符号链接，真正指向 `~/.local/lib/node_modules/pnpm/bin/pnpm.cjs`
 * （`~/.local` 是版本管理器风格的安装布局，等价的坑在 nvm/volta/asdf 下
 * 同样存在）。该目标目录里**只有** `pnpm.cjs`/`pnpx.cjs`，没有字面量叫
 * `pnpm` 的文件。旧实现只把 `dirname(realpathSync(found))`（解析后的目标
 * 目录）塞进 execRoots/PATH，于是 `sandbox-exec` 内部的 `execvp("pnpm", …)`
 * 按 PATH 逐目录找字面量文件名 `pnpm`——那个目录里找不到，未进入 Seatbelt
 * 权限判定就已经失败：`execvp() of 'pnpm' failed: No such file or
 * directory`（exit 71，与观测到的现象完全一致，已用 `env -i PATH=<仅解析
 * 后目录> sandbox-exec -f <allow-all> pnpm --version` 复现同一报错）。
 *
 * 两个目录都要保留，用途不同：
 * - **符号链接自身所在目录**（`~/.local/bin`）：PATH 名字查找靠它——`execvp`
 *   按字面量文件名逐目录扫，只有这里存在名为 `pnpm` 的条目（哪怕是符号链接）。
 * - **`realpathSync` 解析后的目标目录**：Seatbelt 的 `process-exec` 在真正
 *   execve() 时按内核解析后的真实路径比对 subpath（sbpl.ts 同一个道理），
 *   execvp 顺着符号链接最终 exec 的是这个目录下的 `pnpm.cjs`，这个目录必须
 *   在 allow 列表里，否则换成「Operation not permitted」失败。
 *   本机实测：`env -i PATH=<原始符号链接目录>:<node目录>:<解析后目录>
 *   sandbox-exec -f <allow-all> pnpm --version` → exit 0，两个目录缺一不可。
 */
function resolveBinaryDirs(name: string): string[] {
  try {
    let found = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
    if (!found) return [];
    if (name === "git") {
      // 只有 which 返回 /usr/bin/git（macOS 的 xcrun shim，不是真二进制）时才退回到 xcrun 查找。
      // Homebrew / CLT 安装下 which git 本来就指向真二进制，直接沿用——不静默切换安装来源。
      if (found === "/usr/bin/git") {
        try {
          const real = execFileSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8" }).trim();
          if (real) found = real;
        } catch { /* xcrun 不可用，沿用 which 结果（shim 在沙箱里会挂，由其它放行规则兜底） */ }
      }
    }
    return [...new Set([dirname(found), dirname(realpathSync(found))])];
  } catch {
    return []; // 本机没装这个二进制，跳过而不是报错
  }
}

function resolveBootstrapInterpreterTargets(argv0: string, execRoots: readonly string[]): string[] {
  if (argv0 !== "npm" && argv0 !== "pnpm") return [];
  for (const root of execRoots) {
    const candidate = join(root, argv0);
    if (!existsSync(candidate)) continue;
    const target = realpathSync(candidate);
    const targetAllowed = execRoots.some((trustedRoot) => {
      const rel = relative(trustedRoot, target);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    });
    if (targetAllowed) {
      const env = "/usr/bin/env";
      const envAllowed = existsSync(env) && execRoots.some((trustedRoot) => {
        const rel = relative(trustedRoot, env);
        return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
      });
      const node = realpathSync(process.execPath);
      const nodeAllowed = execRoots.some((trustedRoot) => {
        const rel = relative(trustedRoot, node);
        return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
      });
      return [...new Set([
        candidate,
        target,
        ...(envAllowed ? [env] : []),
        ...(nodeAllowed ? [node] : []),
      ])];
    }
  }
  return [];
}

/**
 * 返回本机实际需要放行的 process-exec 根目录：标准系统路径 + 当前 node 解释器
 * 所在目录 + 包管理器二进制的符号链接目录与解析后目录（见 resolveBinaryDirs）。
 *
 * 不做成硬编码常量的原因：node/pnpm 的安装位置因安装方式而异——官方安装器、
 * nvm、volta、asdf、Intel/Apple Silicon Homebrew 各不相同。硬编码在换一台机器
 * 时会悄悄漏放行，报 `sandbox-exec: execvp() of '...' failed: Operation not permitted`，
 * 而这条路径很可能正是 node 本身——那样会把「Seatbelt 下 node 能不能跑」误判为
 * FAIL，其实只是放行清单没跟上这台机器。
 *
 * 用 process.execPath 而不是 `which node`：它就是正在跑这段代码的那个 node
 * 二进制，比 PATH 查找更权威（不依赖 PATH 里排最前面的恰好是同一个安装）。
 */
export function defaultExecRoots(): string[] {
  const gitDirs = resolveBinaryDirs("git");
  const roots = new Set<string>(STANDARD_EXEC_ROOTS.map((r) => realpathSync(r)));
  roots.add(dirname(realpathSync(process.execPath)));
  for (const bin of PACKAGE_MANAGER_BINARIES) {
    if (bin === "git") continue; // 已单独解析，放在最前面确保 PATH 优先级
    for (const dir of resolveBinaryDirs(bin)) roots.add(dir);
  }
  // git 的真实二进制目录必须排在 /usr/bin 之前：macOS 上 /usr/bin/git 是 xcrun shim，
  // 按 PATH 顺序最先被 execvp 找到——真实二进制目录排在前才能让 execvp 跳过 shim。
  return [...new Set([...gitDirs, ...roots])];
}

/**
 * npm 传统 `.bin` 布局使用 symlink，例如 `.bin/vitest -> ../vitest/vitest.mjs`。
 * Seatbelt 在 process-exec 裁决前解析 symlink，因此只 allow `.bin` 自身覆盖不到真实 target。
 * 这里只枚举 `.bin` 暴露出来的 symlink，并且只保留 realpath 后仍位于当前 worktree
 * `node_modules` 内的普通文件。越界、断链、目录 target 都跳过，后续继续由 deny default 拒绝。
 */
export function resolveWorktreeBinExecTargets(worktree: string): string[] {
  const canonicalWorktree = realpathSync(worktree);
  const nodeModulesRoot = join(canonicalWorktree, "node_modules");
  const binDir = join(nodeModulesRoot, ".bin");
  if (!existsSync(binDir)) return [];

  const targets = new Set<string>();
  for (const entry of readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    let target: string;
    try {
      target = realpathSync(join(binDir, entry.name));
    } catch {
      continue;
    }
    const rel = relative(nodeModulesRoot, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    try {
      if (!statSync(target).isFile()) continue;
    } catch {
      continue;
    }
    targets.add(target);
  }
  return [...targets].sort();
}

/**
 * 断言路径的**每一段**都与磁盘上的实际拼写逐字节相同。
 *
 * 为什么不是 `realpathSync(p) === p`：那个检查抓不到本条要防的东西（本机实测）。
 * APFS 大小写与 Unicode 归一化不敏感，`realpathSync` 只解符号链接、不改写调用方给的
 * 拼写——目录实为 `MixedCase` 时问 `mixedcase`，原样返回 `mixedcase`，`real === p`
 * 成立、断言通过；NFD 问 NFC 同理。而 Seatbelt 按字节精确匹配 profile 文本里的
 * subpath：拼写不一致会让 allow 规则过严、deny 规则静默失效（fail-open）。
 * 逐段跟 `readdirSync` 的结果对，才是规格 §11 说的「取磁盘实际拼写」。
 */
function assertOnDiskSpelling(label: string, p: string): void {
  let cur = p;
  let dir = dirname(cur);
  while (dir !== cur) {
    if (!readdirSync(dir).includes(basename(cur))) {
      throw new SandboxError(
        "PATH_SPELLING_MISMATCH",
        `SBPL 路径 ${label} 的拼写与磁盘不一致：${dir} 下没有逐字节等于 ` +
          `${JSON.stringify(basename(cur))} 的条目（${p}）。Seatbelt 按字节匹配策略路径，` +
          `拼写不一致会让 deny 规则静默失效（规格 §11）。`,
      );
    }
    cur = dir;
    dir = dirname(cur);
  }
}

export async function runSandboxed(o: RunOptions): Promise<RunResult> {
  const home = join(o.paths.jobTmp, "home");
  mkdirSync(home, { recursive: true });

  // 实测发现（本机 macOS 26.5.1）：内核在做 Seatbelt subpath 匹配前会解析符号链接
  // （/tmp -> /private/tmp、/var -> /private/var 等），但 profile 里的 subpath 字符串
  // 不会被自动解析。两者形式不一致时 allow / deny 规则都会静默失配——worktree 的 allow
  // 规则失配后整体拒写；controlRoot 的 deny 规则失配后回落到全局 (allow file-read*)、
  // 泄漏本应受控的内容。这里统一转成真实路径再喂给 buildProfile，使其与内核实际比对的
  // 路径一致。sbpl.ts 保持纯函数（测试要用不存在的假路径），解析放在这个本就与真实文件
  // 系统打交道的层。
  const profilePath = join(o.paths.jobTmp, "profile.sb");
  const canonicalWorktree = realpathSync(o.paths.worktree);
  if ((o.nativeExecTargets?.length ?? 0) > 0 && o.toolchain !== "darwin-clang") {
    throw new SandboxError("INVALID_INPUT", "nativeExecTargets 只能与 toolchain: darwin-clang 一起使用。");
  }
  const nativeExecTargets = resolveNativeExecTargets(canonicalWorktree, o.nativeExecTargets);
  const toolchain = o.toolchain ? resolveNativeToolchainClosure(o.toolchain) : undefined;
  const canonicalPaths: SandboxPaths = {
    worktree: canonicalWorktree,
    canonicalGit: realpathSync(o.paths.canonicalGit),
    jobTmp: realpathSync(o.paths.jobTmp),
    controlRoot: realpathSync(o.paths.controlRoot),
    worktreesRoot: realpathSync(o.paths.worktreesRoot),
    // 同样的道理适用于 execRoots：调用方即便已经用 defaultExecRoots() 解析过，
    // 这里仍统一再 realpathSync 一遍——不依赖调用方自律，跟上面五个字段一致。
    execRoots: o.paths.execRoots.map((r) => realpathSync(r)),
    bootstrapInterpreterTargets: [],
    // 不接受调用方传入的额外 worktree exec allow；每次都从当前 `.bin` 实际 symlink
    // 重新推导 exact target，避免 stale/untrusted path 扩大 process-exec。
    worktreeExecTargets: resolveWorktreeBinExecTargets(canonicalWorktree),
    // 同样不接受 caller-supplied native-toolchain roots/files/targets。只有 fixed enum 解析器能产生。
    toolchainReadRoots: toolchain ? [...toolchain.readRoots] : [],
    toolchainReadFiles: toolchain ? [...toolchain.readFiles] : [],
    toolchainExecTargets: toolchain ? [...toolchain.execTargets] : [],
  };
  if (o.networkPolicy === "package-manager-bootstrap") {
    canonicalPaths.bootstrapInterpreterTargets = resolveBootstrapInterpreterTargets(
      o.argv[0]!,
      canonicalPaths.execRoots,
    );
  }
  for (const [label, value] of [
    ["worktree", canonicalPaths.worktree], ["canonicalGit", canonicalPaths.canonicalGit],
    ["jobTmp", canonicalPaths.jobTmp], ["controlRoot", canonicalPaths.controlRoot],
    ["worktreesRoot", canonicalPaths.worktreesRoot],
  ] as const) assertOnDiskSpelling(label, value);
  canonicalPaths.execRoots.forEach((r, i) => assertOnDiskSpelling(`execRoots[${i}]`, r));
  canonicalPaths.bootstrapInterpreterTargets?.forEach(
    (r, i) => assertOnDiskSpelling(`bootstrapInterpreterTargets[${i}]`, r),
  );
  canonicalPaths.worktreeExecTargets?.forEach((r, i) => assertOnDiskSpelling(`worktreeExecTargets[${i}]`, r));
  canonicalPaths.toolchainReadRoots?.forEach((r, i) => assertOnDiskSpelling(`toolchainReadRoots[${i}]`, r));
  canonicalPaths.toolchainReadFiles?.forEach((r, i) => assertOnDiskSpelling(`toolchainReadFiles[${i}]`, r));
  canonicalPaths.toolchainExecTargets?.forEach((r, i) => assertOnDiskSpelling(`toolchainExecTargets[${i}]`, r));

  // nativeExecTargets 可能由同一个 job 内的 clang 稍后创建，因此这里绝不能 realpath/exists。
  // 权限增量由独立 helper 生成，且只能是当前 worktree 内的 exact process-exec literal。
  const profile = buildProfile(canonicalPaths, {
    network: o.networkPolicy === "package-manager-bootstrap" ? "package-manager-bootstrap" : "deny",
  }) + buildNativeExecSbplRules(canonicalWorktree, nativeExecTargets);
  writeFileSync(profilePath, profile, "utf8");

  // 环境清洗：只传必需的四个。宿主的 *_TOKEN / *_API_KEY / DYLD_* 一律不进沙箱。
  // HOME/TMPDIR 都在 per-job root，bootstrap 因而也看不到宿主 ~/.npmrc、~/.pnpm-store
  // 或其它用户级凭据。package-manager 网络模式只改变 Seatbelt network rule，不改变 env。
  //
  // PATH 从 execRoots 派生，不再单独硬编码。原先两者是两处独立的常量，
  // 于是修好了 profile 的放行清单、PATH 却仍指向 /opt/homebrew/bin——
  // 直接 exec node 能过，但 pnpm 的 `#!/usr/bin/env node` shebang 解析不到 node，
  // 报 `env: node: No such file or directory`（exit 127）。二者派生自同一来源后
  // 不可能再分叉。
  const env = {
    PATH: canonicalPaths.execRoots.join(":"),
    HOME: home,
    LANG: "en_US.UTF-8",
    TMPDIR: o.paths.jobTmp,
  };

  const started = Date.now();
  const child = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, ...o.argv], {
    cwd: o.cwd,
    env,
    detached: true, // 新进程组：能一次杀掉整棵进程树
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pgid = child.pid ?? 0;
  if (pgid) o.onSpawn?.(pgid);
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let truncated = false;
  let killedBy: RunResult["killedBy"] = null;
  let killSignalSkipped = false;
  let peakRssMb = 0;

  const killGroup = (reason: NonNullable<RunResult["killedBy"]>) => {
    if (killedBy) return;
    killedBy = reason;
    if (!pgid) {
      // spawn 没能给出 pid，pgid 退化为 0。process.kill(-pgid, …) 就是
      // process.kill(-0, …)，POSIX 语义下会把信号发给调用者自己的进程组——
      // 也就是这个 orchestrator 进程自身，而不是某个不存在的子进程组。
      // 宁可什么都不做、如实记录，也不能把信号打偏。
      killSignalSkipped = true;
      return;
    }
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
    setTimeout(() => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, 5000).unref();
  };

  // I2：命中输出上限只停止收集，绝不杀进程。规格 §6.4/§6.5 要求的是「截断并
  // 停止收集」，不是「杀」——这里此前混淆了两者，命中 cap 会触发跟 timeout/rss
  // 完全一样的 killGroup。后果已实测：一个 3000 行输出、cap 4KB、`exit 0` 的
  // 通过用例被报成 `state: killed, exitCode: null`；默认 cap 是 1MiB，一次
  // verbose 的 `pnpm test` 轻易越过它——模型会被告知自己刚跑过的、真正通过的
  // 测试套件被杀了。timeout 与 rss 两条杀进程路径不受影响：它们各自在下面
  // 独立调用 killGroup("timeout")/killGroup("rss")，与这里完全无关。
  const collect = (chunk: Buffer, into: "out" | "err") => {
    if (truncated) return;
    const remaining = o.maxOutputBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const slice = chunk.subarray(0, remaining);
    bytes += slice.byteLength;
    if (into === "out") stdout += slice.toString("utf8");
    else stderr += slice.toString("utf8");
    if (bytes >= o.maxOutputBytes) {
      truncated = true;
    }
  };

  child.stdout.on("data", (c: Buffer) => collect(c, "out"));
  child.stderr.on("data", (c: Buffer) => collect(c, "err"));

  const timer = setTimeout(() => killGroup("timeout"), o.timeoutMs);
  const poller = setInterval(() => {
    const mb = groupRssMb(pgid);
    if (mb > peakRssMb) peakRssMb = mb;
    if (o.maxRssMb !== undefined && mb > o.maxRssMb) killGroup("rss");
  }, RSS_POLL_MS);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });

  clearTimeout(timer);
  clearInterval(poller);

  return {
    exitCode,
    stdout,
    stderr,
    truncated,
    killedBy,
    killSignalSkipped,
    durationMs: Date.now() - started,
    peakRssMb,
  };
}
