import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { buildNativeExecSbplRules, resolveNativeExecTargets } from "./nativeExecTargets.ts";
import { resolveNativeToolchainClosure, type NativeToolchain } from "./nativeToolchain.ts";
import { superviseOwnedProcess, type SupervisedProcessResult } from "./processSupervision.ts";
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
  /** Internal supervisor-owned cancellation; never populated from MCP/profile arguments. */
  signal?: AbortSignal;
}

export interface RunResult extends SupervisedProcessResult {}

/** 托管基础 coreutils（sh、cat、env、curl……）的系统路径，任何安装方式下都存在 */
const STANDARD_EXEC_ROOTS = ["/usr/bin", "/bin", "/usr/sbin"];

/** 需要在沙箱里放行的包管理器二进制。逐个用 `which` 探测——某个名字在本机
 *  没装（比如没有独立的 npx）就跳过，不是错误。 */
const PACKAGE_MANAGER_BINARIES = ["pnpm", "npm", "npx", "git"];

/**
 * BUG 2 实测复现（本机 2026-07-28）：`which pnpm` → `~/.local/bin/pnpm`，
 * 是个符号链接，真正指向 `~/.local/lib/node_modules/pnpm/bin/pnpm.cjs`
 * （`~/.local` 是版本管理器风格的安装布局，等价的坑在 nvm/volta/asdf 下
 * 同样存在）。该目标目录里只有 pnpm.cjs/npx.cjs，没有字面量 pnpm。
 * PATH 名字查找需要符号链接自身所在目录，Seatbelt process-exec 则需要解析后的目录。
 * 两个目录都必须保留，不能以其中一个代替另一个。
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

/**
 * 实际 process-exec 根目录由系统路径、当前 Node 与包管理器的名字/真实路径组成。
 * process.execPath 是运行 GrandeGPT 的实际 Node，不能被 PATH 上另一版本替代。
 */
export function defaultExecRoots(): string[] {
  const gitDirs = resolveBinaryDirs("git");
  const roots = new Set<string>(STANDARD_EXEC_ROOTS.map((r) => realpathSync(r)));
  const nodeRoot = dirname(realpathSync(process.execPath));
  for (const bin of PACKAGE_MANAGER_BINARIES) {
    if (bin === "git") continue;
    for (const dir of resolveBinaryDirs(bin)) roots.add(dir);
  }
  // 当前 Node 必须在 PATH 首位；real Git 在系统 shim 之前。
  return [...new Set([nodeRoot, ...gitDirs, ...roots])];
}

/**
 * npm .bin symlink targets must remain inside this worktree's node_modules.
 * Seatbelt resolves symlinks before process-exec checks, so the exact target is required.
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
 * APFS case/Unicode normalization means realpath alone cannot prove byte-exact spelling.
 * Seatbelt matches the path text by bytes; compare every component with directory entries.
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
  o.signal?.throwIfAborted();
  const home = join(o.paths.jobTmp, "home");
  mkdirSync(home, { recursive: true });

  // Resolve all real paths before SBPL construction. /tmp and /var symlinks otherwise
  // make the profile text disagree with the kernel's resolved allow/deny target.
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
    execRoots: o.paths.execRoots.map((r) => realpathSync(r)),
    // Never accept caller-supplied extra exec roots/targets for worktree or native tools.
    worktreeExecTargets: resolveWorktreeBinExecTargets(canonicalWorktree),
    toolchainReadRoots: toolchain ? [...toolchain.readRoots] : [],
    toolchainReadFiles: toolchain ? [...toolchain.readFiles] : [],
    toolchainExecTargets: toolchain ? [...toolchain.execTargets] : [],
  };
  for (const [label, value] of [
    ["worktree", canonicalPaths.worktree], ["canonicalGit", canonicalPaths.canonicalGit],
    ["jobTmp", canonicalPaths.jobTmp], ["controlRoot", canonicalPaths.controlRoot],
    ["worktreesRoot", canonicalPaths.worktreesRoot],
  ] as const) assertOnDiskSpelling(label, value);
  canonicalPaths.execRoots.forEach((r, i) => assertOnDiskSpelling(`execRoots[${i}]`, r));
  canonicalPaths.worktreeExecTargets?.forEach((r, i) => assertOnDiskSpelling(`worktreeExecTargets[${i}]`, r));
  canonicalPaths.toolchainReadRoots?.forEach((r, i) => assertOnDiskSpelling(`toolchainReadRoots[${i}]`, r));
  canonicalPaths.toolchainReadFiles?.forEach((r, i) => assertOnDiskSpelling(`toolchainReadFiles[${i}]`, r));
  canonicalPaths.toolchainExecTargets?.forEach((r, i) => assertOnDiskSpelling(`toolchainExecTargets[${i}]`, r));

  // Native targets may be created later by this job's compiler: do not realpath/exists them.
  const profile = buildProfile(canonicalPaths, {
    network: o.networkPolicy === "package-manager-bootstrap" ? "package-manager-bootstrap" : "deny",
  }) + buildNativeExecSbplRules(canonicalWorktree, nativeExecTargets);
  writeFileSync(profilePath, profile, "utf8");

  // No host credentials, npmrc, token or DYLD_* inheritance. PATH derives from the
  // same trusted executable roots that SBPL allows; bootstrap only adds fixed CI=true.
  const env = {
    PATH: canonicalPaths.execRoots.join(":"),
    HOME: home,
    LANG: "en_US.UTF-8",
    TMPDIR: o.paths.jobTmp,
    ...(o.networkPolicy === "package-manager-bootstrap" ? { CI: "true" } : {}),
  };

  o.signal?.throwIfAborted();
  const child = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, ...o.argv], {
    cwd: o.cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return superviseOwnedProcess(child, {
    timeoutMs: o.timeoutMs, maxOutputBytes: o.maxOutputBytes, maxRssMb: o.maxRssMb,
    signal: o.signal, onSpawn: o.onSpawn,
  });
}
