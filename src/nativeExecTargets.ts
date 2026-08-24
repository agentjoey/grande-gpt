import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

export class NativeExecTargetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `NativeExecTargetError [${code}]`;
    this.code = code;
  }
}

function hasGlobSyntax(value: string): boolean {
  return ["*", "?", "[", "]", "{", "}"].some((ch) => value.includes(ch));
}

function isStrictlyUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertRepoRelativeExactTarget(target: string): void {
  const normalized = normalize(target);
  if (
    target.length === 0 || target.includes("\0") || isAbsolute(target) ||
    normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`) ||
    normalized !== target || hasGlobSyntax(target)
  ) {
    throw new NativeExecTargetError(
      "INVALID_INPUT",
      `nativeExecTargets 只能包含固定 repo-relative exact path，收到：${JSON.stringify(target)}`,
    );
  }
}

/**
 * 把 trusted profile 里的 repo-relative declaration 解析到当前 task worktree。
 *
 * 这里故意不 realpath/exists：native output 会在同一个 sandbox job 内先由 clang 创建，
 * profile 生成时文件可能尚不存在。只做词法 containment；若之后某个路径段被做成 symlink
 * 指向 worktree 外，Seatbelt 在 execve 时解析真实 target 后不会命中下面的 exact literal，
 * 因而仍 fail closed。
 */
export function resolveNativeExecTargets(worktree: string, targets: readonly string[] | undefined): string[] {
  if (!isAbsolute(worktree)) {
    throw new NativeExecTargetError("INVALID_INPUT", `worktree 必须是绝对路径：${worktree}`);
  }
  const out = new Set<string>();
  for (const target of targets ?? []) {
    assertRepoRelativeExactTarget(target);
    const absolute = resolve(worktree, target);
    if (!isStrictlyUnder(worktree, absolute)) {
      throw new NativeExecTargetError("INVALID_INPUT", `nativeExecTarget 必须位于当前 task worktree：${target}`);
    }
    out.add(absolute);
  }
  return [...out].sort();
}

function q(path: string): string {
  if (!isAbsolute(path)) {
    throw new NativeExecTargetError("INVALID_INPUT", `native exec SBPL target 必须是绝对路径：${path}`);
  }
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 生成 native artifact 的全部 SBPL 权限增量。
 *
 * 只允许 exact process-exec literal。没有 subpath、glob，也不会恢复整个 worktree exec。
 */
export function buildNativeExecSbplRules(worktree: string, targets: readonly string[]): string {
  if (!isAbsolute(worktree)) {
    throw new NativeExecTargetError("INVALID_INPUT", `worktree 必须是绝对路径：${worktree}`);
  }
  const unique = [...new Set(targets)].sort();
  for (const target of unique) {
    if (!isAbsolute(target) || !isStrictlyUnder(worktree, target)) {
      throw new NativeExecTargetError(
        "INVALID_INPUT",
        `native exec SBPL target 必须是当前 task worktree 内的 absolute exact path：${target}`,
      );
    }
  }
  if (unique.length === 0) return "";
  return unique.map((target) => `(allow process-exec (literal "${q(target)}"))`).join("\n") + "\n";
}
