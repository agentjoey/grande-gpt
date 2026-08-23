import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StateError } from "./errors.ts";

export type VerificationPackageManager = "pnpm" | "npm";
export type VerificationLockfile = "pnpm-lock.yaml" | "package-lock.json";

export interface ModernHostToolchainIdentity {
  node: string;
  packageManager: VerificationPackageManager;
  packageManagerVersion: string;
  lockfile: VerificationLockfile;
  lockfileSha256: string;
}

/** Pre-GG-BL-026 persisted shape. Read-only compatibility; never emit for new runs. */
export interface LegacyPnpmHostToolchainIdentity {
  node: string;
  pnpm: string;
  lockfileSha256: string;
}

export type HostToolchainIdentity = ModernHostToolchainIdentity | LegacyPnpmHostToolchainIdentity;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "unknown";
}

function parseDeclaredManager(repoRoot: string): VerificationPackageManager | null {
  const packageJsonPath = join(repoRoot, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new StateError(
      "INVALID_INPUT",
      `无法解析 package.json，不能确定 verification package manager：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StateError("INVALID_INPUT", "package.json 顶层不是 object，不能确定 verification package manager。");
  }
  const declared = (parsed as Record<string, unknown>).packageManager;
  if (declared === undefined) return null;
  if (typeof declared !== "string" || declared.trim().length === 0) {
    throw new StateError("INVALID_INPUT", "package.json#packageManager 非法，不能签发 verification identity。");
  }
  const manager = declared.split("@", 1)[0];
  if (manager === "pnpm" || manager === "npm") return manager;
  throw new StateError(
    "INVALID_INPUT",
    `verification identity 当前只支持 pnpm/npm，package.json 声明的是 ${manager || declared}。`,
  );
}

function resolveManager(repoRoot: string): { manager: VerificationPackageManager; lockfile: VerificationLockfile } {
  const declared = parseDeclaredManager(repoRoot);
  const pnpmLock = existsSync(join(repoRoot, "pnpm-lock.yaml"));
  const npmLock = existsSync(join(repoRoot, "package-lock.json"));

  if (declared === "pnpm") {
    if (!pnpmLock) {
      throw new StateError("INVALID_INPUT", "packageManager=pnpm 但缺少 pnpm-lock.yaml，不能签发 verification identity。");
    }
    return { manager: "pnpm", lockfile: "pnpm-lock.yaml" };
  }
  if (declared === "npm") {
    if (!npmLock) {
      throw new StateError("INVALID_INPUT", "packageManager=npm 但缺少 package-lock.json，不能签发 verification identity。");
    }
    return { manager: "npm", lockfile: "package-lock.json" };
  }

  if (pnpmLock && npmLock) {
    throw new StateError(
      "INVALID_INPUT",
      "同时存在 pnpm-lock.yaml 与 package-lock.json 且 packageManager 未声明，verification package manager 存在冲突，拒绝猜测。",
    );
  }
  if (pnpmLock) return { manager: "pnpm", lockfile: "pnpm-lock.yaml" };
  if (npmLock) return { manager: "npm", lockfile: "package-lock.json" };
  throw new StateError(
    "INVALID_INPUT",
    "未找到受支持的 pnpm-lock.yaml 或 package-lock.json，不能确定 verification package manager。",
  );
}

export function capturePackageManagerIdentity(repoRoot: string): ModernHostToolchainIdentity {
  const { manager, lockfile } = resolveManager(repoRoot);
  const version = execFileSync(manager, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!process.version || !version) {
    throw new StateError("INVALID_INPUT", `无法记录本机验证工具链：node 或 ${manager} 版本为空。`);
  }
  const lockfileBytes = readFileSync(join(repoRoot, lockfile));
  return {
    node: process.version,
    packageManager: manager,
    packageManagerVersion: version,
    lockfile,
    lockfileSha256: createHash("sha256").update(lockfileBytes).digest("hex"),
  };
}

/**
 * Attestation rows predate GG-BL-026 and historically only required a non-empty legacy
 * lockfileSha256. Preserve that read boundary so old rows remain readable. Modern rows
 * are stricter because every newly captured hash is a real SHA-256.
 */
export function isValidHostToolchainIdentity(value: unknown): value is HostToolchainIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const toolchain = value as Record<string, unknown>;
  if (!nonEmpty(toolchain.node) || !nonEmpty(toolchain.lockfileSha256)) return false;

  if (toolchain.packageManager !== undefined || toolchain.packageManagerVersion !== undefined || toolchain.lockfile !== undefined) {
    const manager = toolchain.packageManager;
    const lockfile = toolchain.lockfile;
    return toolchain.pnpm === undefined
      && /^[0-9a-f]{64}$/u.test(toolchain.lockfileSha256)
      && (manager === "pnpm" || manager === "npm")
      && nonEmpty(toolchain.packageManagerVersion)
      && ((manager === "pnpm" && lockfile === "pnpm-lock.yaml") || (manager === "npm" && lockfile === "package-lock.json"));
  }

  return nonEmpty(toolchain.pnpm);
}

/** Host receipts already required an actual 64-hex lockfile hash before GG-BL-026. */
export function isValidReceiptHostToolchainIdentity(value: unknown): value is HostToolchainIdentity {
  if (!isValidHostToolchainIdentity(value)) return false;
  return /^[0-9a-f]{64}$/u.test(value.lockfileSha256);
}
