import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildProfile, type SandboxPaths } from "./sbpl.ts";

export interface RunOptions {
  argv: string[];
  cwd: string;
  paths: SandboxPaths;
  timeoutMs: number;
  maxOutputBytes: number;
  /** 进程组总 RSS 上限（MB）。省略则不做内存兜底 */
  maxRssMb?: number;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  killedBy: null | "timeout" | "rss" | "output";
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
const PACKAGE_MANAGER_BINARIES = ["pnpm", "npm", "npx"];

function resolveBinaryDir(name: string): string | null {
  try {
    const found = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
    if (!found) return null;
    // `which` 给的路径常常是符号链接（pnpm 的 shim 尤其如此：~/.local/bin/pnpm
    // 实际指向 ~/.local/lib/node_modules/pnpm/bin/pnpm.cjs）。Seatbelt 在真正
    // execve 时按内核解析后的真实路径比对 subpath，这里必须做同样的解析，
    // 否则 allow 规则悄悄失配——跟 runSandboxed 里对 SandboxPaths 五个字段做
    // realpathSync 是同一个道理。
    return dirname(realpathSync(found));
  } catch {
    return null; // 本机没装这个二进制，跳过而不是报错
  }
}

/**
 * 返回本机实际需要放行的 process-exec 根目录：标准系统路径 + 当前 node 解释器
 * 所在目录 + 解析后的包管理器二进制目录。
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
  const roots = new Set<string>(STANDARD_EXEC_ROOTS.map((r) => realpathSync(r)));
  roots.add(dirname(realpathSync(process.execPath)));
  for (const bin of PACKAGE_MANAGER_BINARIES) {
    const dir = resolveBinaryDir(bin);
    if (dir) roots.add(dir);
  }
  return [...roots];
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
  const canonicalPaths: SandboxPaths = {
    worktree: realpathSync(o.paths.worktree),
    canonicalGit: realpathSync(o.paths.canonicalGit),
    jobTmp: realpathSync(o.paths.jobTmp),
    controlRoot: realpathSync(o.paths.controlRoot),
    worktreesRoot: realpathSync(o.paths.worktreesRoot),
    // 同样的道理适用于 execRoots：调用方即便已经用 defaultExecRoots() 解析过，
    // 这里仍统一再 realpathSync 一遍——不依赖调用方自律，跟上面五个字段一致。
    execRoots: o.paths.execRoots.map((r) => realpathSync(r)),
  };
  writeFileSync(profilePath, buildProfile(canonicalPaths), "utf8");

  // 环境清洗：只传必需的四个。宿主的 *_TOKEN / *_API_KEY / DYLD_* 一律不进沙箱。
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

  const collect = (chunk: Buffer, into: "out" | "err") => {
    if (truncated) return;
    const remaining = o.maxOutputBytes - bytes;
    if (remaining <= 0) {
      truncated = true;
      killGroup("output");
      return;
    }
    const slice = chunk.subarray(0, remaining);
    bytes += slice.byteLength;
    if (into === "out") stdout += slice.toString("utf8");
    else stderr += slice.toString("utf8");
    if (bytes >= o.maxOutputBytes) {
      truncated = true;
      killGroup("output");
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
