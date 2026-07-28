import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { buildProfile, type SandboxPaths } from "../src/sbpl.ts";
import { defaultExecRoots } from "../src/sandbox.ts";

const paths: SandboxPaths = {
  worktree: "/W/.grande-work/worktrees/demo/task_1",
  canonicalGit: "/W/demo/.git",
  jobTmp: "/tmp/job_1",
  controlRoot: "/Users/u/.grande-control",
  worktreesRoot: "/W/.grande-work/worktrees",
  execRoots: ["/usr/bin", "/bin", "/usr/sbin", "/opt/homebrew/bin"],
};

describe("buildProfile()", () => {
  it("以 deny default 开头并全局禁网", () => {
    const p = buildProfile(paths);
    expect(p).toContain("(deny default)");
    expect(p).toContain("(deny network*)");
  });

  it("worktree 可写", () => {
    expect(buildProfile(paths)).toContain(`(allow file-write* (subpath "${paths.worktree}"))`);
  });

  it("canonical 的 .git 不可写（hooks 为所有 worktree 共享）", () => {
    expect(buildProfile(paths)).toContain(`(deny file-write* (subpath "${paths.canonicalGit}"))`);
  });

  it("控制平面根不可读", () => {
    expect(buildProfile(paths)).toContain(`(deny file-read* (subpath "${paths.controlRoot}"))`);
  });

  it("worktreesRoot 目录条目自身放行 file-read-metadata——否则向上遍历目录树找 workspace root 的工具（pnpm/npm/yarn/vitest/tsc）在 lstat(worktreesRoot) 这一级直接 EPERM，实测 100% 复现", () => {
    const p = buildProfile(paths);
    expect(p).toContain(`(allow file-read-metadata (literal "${paths.worktreesRoot}"))`);
  });

  it("worktree 与 worktreesRoot 之间的中间祖先目录（真实布局的 <repoId> 那一级）同样放行 file-read-metadata——否则向上遍历会先死在这一级而不是 worktreesRoot", () => {
    // fixture 的 worktree 是 worktreesRoot + "/demo/task_1"，中间夹着 "demo"
    // 这一级（对应真实布局 join(worktreesRoot, repoId, taskId) 里的 repoId）。
    const p = buildProfile(paths);
    expect(p).toContain(`(allow file-read-metadata (literal "${paths.worktreesRoot}/demo"))`);
  });

  it("worktree 自己不出现在 file-read-metadata 的 literal 放行里——它已经由 file-read* 整体放行，不需要重复", () => {
    const p = buildProfile(paths);
    expect(p).not.toContain(`(allow file-read-metadata (literal "${paths.worktree}"))`);
  });

  it("先 deny worktrees 父目录、再 allow 本任务 worktree（依赖最具体规则优先）", () => {
    const p = buildProfile(paths);
    const denyIdx = p.indexOf(`(deny file-read* (subpath "${paths.worktreesRoot}"))`);
    const allowIdx = p.indexOf(`(allow file-read* (subpath "${paths.worktree}"))`);
    expect(denyIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(-1);
    // I6：这条测试名字叫「先 deny 再 allow」，但此前只断言两行各自存在，从未
    // 断言过谁先谁后——两行顺序颠倒过来这条测试也会一样通过，等于空转。复核
    // 已经证明书写顺序在具体程度相等时是 load-bearing 的（不能假设 Seatbelt
    // 总是「不管顺序、只看谁更具体」），所以这里必须真的钉住 buildProfile 输出
    // 的实际书写顺序，而不只是「两行都在」。
    expect(denyIdx).toBeLessThan(allowIdx);
  });

  it("路径中的双引号被转义，不能截断 SBPL 字符串", () => {
    const evil = { ...paths, worktree: '/W/a"b' };
    const p = buildProfile(evil);
    expect(p).toContain('/W/a\\"b');
    expect(p).not.toContain('"/W/a"b"');
  });

  it("拒绝相对路径——SBPL 的 subpath 必须是绝对路径", () => {
    // I3：断言 .code 而不是 message 正则——message 文案一改这条测试就会悄悄
    // 失真（已实测过这个模式：这类正则谁都能匹配上一个凑巧带同一个词的裸
    // Error，证明不了真的抛出的是带结构化 .code 的 SbplError）。
    expect(() => buildProfile({ ...paths, worktree: "relative/path" })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("execRoots 逐条生成 subpath 规则，而不是硬编码常量", () => {
    const p = buildProfile(paths);
    const execLine = p.split("\n").find((l) => l.startsWith("(allow process-exec"));
    expect(execLine).toBeDefined();
    for (const root of paths.execRoots) {
      expect(execLine).toContain(`(subpath "${root}")`);
    }
  });

  it("execRoots 里的路径同样要求绝对路径", () => {
    expect(() => buildProfile({ ...paths, execRoots: ["relative/bin"] })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("execRoots 里的双引号同样被转义", () => {
    const p = buildProfile({ ...paths, execRoots: ['/opt/weird"bin'] });
    expect(p).toContain('/opt/weird\\"bin');
    expect(p).not.toContain('"/opt/weird"bin"');
  });

  it("execRoots 为空数组时拒绝——否则 process-exec 会退化为放行一切可执行文件", () => {
    // I6：此前是不带任何 matcher 的 toThrow()——任何异常都能让它通过，包括一个
    // 因为无关 bug 提前抛出的、完全不相干的 TypeError。给出期望的 .code。
    expect(() => buildProfile({ ...paths, execRoots: [] })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("含 /dev/null 读写放行，且不含 (subpath \"/dev\")", () => {
    const p = buildProfile(paths);
    expect(p).toContain('(allow file-read* file-write* (literal "/dev/null"))');
    // 注释里允许提到 subpath "/dev"，但实际 SBPL 规则（非注释非空行）中不能有
    const rules = p.split("\n").filter((l) => !l.startsWith(";;") && l.trim() !== "");
    expect(rules.some((l) => l.includes('(subpath "/dev")'))).toBe(false);
  });

  it("execRoots 里出现真实 git 所在目录", () => {
    const roots = defaultExecRoots();
    // 用 xcrun --find 拿到真实 git 二进制路径（处理 /usr/bin/git 是 shim 的情况），
    // 不可用时退回 which
    let gitPath = "";
    try {
      gitPath = execFileSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8" }).trim();
    } catch {
      try {
        gitPath = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
      } catch {
        return; // git 未安装，跳过
      }
    }
    if (!gitPath) return;
    expect(roots).toContain(dirname(gitPath));
  });
});
