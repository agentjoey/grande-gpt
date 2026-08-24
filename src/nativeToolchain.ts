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
 * 返回 active Developer Directory / Xcode bundle 的只读根、固定 Xcode license-state
 * 文件，以及编译一个 C 可执行文件实际需要的 clang/ld 精确 executable。
 * `/var/select` 保留原始 spelling，因为 xcode-select 的失败路径正是这个 spelling；
 * 把它 realpath 成 `/private/var/select` 会再次漏掉同一权限。
 *
 * 完整 Xcode 安装还有一个额外只读依赖：`xcodebuild` 会读取同一 bundle 的
 * `Contents/Info.plist` 与 `Contents/SharedFrameworks/*`。只有当 active Developer
 * Directory 确实形如 `<Xcode.app>/Contents/Developer` 时才把对应 `Contents` 加入
 * read closure；CommandLineTools 的 `/Library/Developer/CommandLineTools` 不满足这个
 * 结构，因此不会顺手把 `/Library/Developer` 放开。
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
    readRoots: [...new Set(["/var/select", ...(xcodeContents ? [xcodeContents] : []), developerDir])],
    readFiles: XCODE_LICENSE_STATE_FILES.filter((path) => existsSync(path)),
    execTargets: [...new Set([clang, ld])],
  };
}
