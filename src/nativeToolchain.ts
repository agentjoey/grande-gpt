import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";

export type NativeToolchain = "darwin-clang";

export interface NativeToolchainClosure {
  readonly readRoots: readonly string[];
  readonly readFiles: readonly string[];
  readonly execTargets: readonly string[];
}

export class NativeToolchainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `NativeToolchainError [${code}]`;
    this.code = code;
  }
}

function commandOutput(executable: string, argv: readonly string[], label: string): string {
  try {
    const out = execFileSync(executable, [...argv], { encoding: "utf8" }).trim();
    if (!out) throw new Error("empty output");
    return out;
  } catch (e) {
    throw new NativeToolchainError(
      "TOOLCHAIN_UNAVAILABLE",
      `${label} 解析失败：${(e as Error).message}`,
    );
  }
}

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function xcodeContentsRoot(developerDir: string): string | null {
  if (basename(developerDir) !== "Developer") return null;
  const contents = dirname(developerDir);
  if (basename(contents) !== "Contents") return null;
  const app = dirname(contents);
  if (!basename(app).endsWith(".app")) return null;
  return contents;
}

const XCODE_LICENSE_STATE_FILES = [
  "/Library/Preferences/com.apple.dt.Xcode.plist",
] as const;

/**
 * 解析受控 Darwin clang toolchain 的宿主依赖闭包。
 *
 * 这里没有 caller-provided path/argv：只执行固定的 macOS discovery commands，
 * 返回 active toolchain 的最小只读根、固定 Xcode license-state 文件，以及编译一个
 * C 可执行文件实际需要的 clang/ld 精确 executable。
 *
 * `/var/select` 是 `/usr/bin/clang` / xcode-select 的 selector dependency。最初的
 * synthetic Host fixture 曾显示完整 Xcode closure 下移除它仍可编译，但 2026-08-24
 * 在 production activation 后原样重跑 grande-obsidian-mcp Phase 3 P3-0 probe，仍稳定
 * 复现 `/var/select/developer_dir` EPERM。真实外部 probe 优先于合成 fixture，因此两种
 * Darwin clang 布局都保留这个 selector 目录；仍只放到 `/var/select`，不扩大 `/var`。
 *
 * 完整 Xcode 安装下，`<Xcode.app>/Contents` 已经覆盖 Developer Directory、Info.plist
 * 与 SharedFrameworks，因此不要再重复放行 `Contents/Developer`。CommandLineTools 没有
 * `<Xcode.app>/Contents` 父根可用，因此兼容分支显式放行 active Developer Directory；
 * 这仍不会把 `/Library/Developer` 整棵开放。
 *
 * Xcode license acceptance 是宿主机状态，不属于 repo。只允许固定、已知且实际存在的
 * plist 作为 exact literal read，绝不放开整个 `/Library/Preferences`。
 */
export function resolveNativeToolchainClosure(toolchain: NativeToolchain): NativeToolchainClosure {
  if (toolchain !== "darwin-clang") {
    throw new NativeToolchainError("INVALID_INPUT", `不支持的 native toolchain：${toolchain}`);
  }
  if (process.platform !== "darwin") {
    throw new NativeToolchainError("TOOLCHAIN_UNAVAILABLE", "darwin-clang 仅支持 macOS host");
  }

  const developerDir = realpathSync(commandOutput("/usr/bin/xcode-select", ["-p"], "xcode-select -p"));
  const clang = realpathSync(commandOutput("/usr/bin/xcrun", ["--find", "clang"], "xcrun --find clang"));
  const ld = realpathSync(commandOutput("/usr/bin/xcrun", ["--find", "ld"], "xcrun --find ld"));

  if (!statSync(developerDir).isDirectory()) {
    throw new NativeToolchainError("TOOLCHAIN_UNAVAILABLE", `Developer Directory 不是目录：${developerDir}`);
  }
  for (const [label, executable] of [["clang", clang], ["ld", ld]] as const) {
    if (!statSync(executable).isFile()) {
      throw new NativeToolchainError("TOOLCHAIN_UNAVAILABLE", `${label} 不是普通文件：${executable}`);
    }
    if (!isUnder(developerDir, executable)) {
      throw new NativeToolchainError(
        "TOOLCHAIN_UNAVAILABLE",
        `${label} 不在 active Developer Directory 内：${executable}`,
      );
    }
  }

  const xcodeContents = xcodeContentsRoot(developerDir);
  return {
    readRoots: xcodeContents ? ["/var/select", xcodeContents] : ["/var/select", developerDir],
    readFiles: XCODE_LICENSE_STATE_FILES.filter((path) => existsSync(path)),
    execTargets: [...new Set([clang, ld])],
  };
}
