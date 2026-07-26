import { describe, expect, it } from "vitest";
import { buildProfile, type SandboxPaths } from "../src/sbpl.ts";

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

  it("先 deny worktrees 父目录、再 allow 本任务 worktree（依赖最具体规则优先）", () => {
    const p = buildProfile(paths);
    const denyIdx = p.indexOf(`(deny file-read* (subpath "${paths.worktreesRoot}"))`);
    const allowIdx = p.indexOf(`(allow file-read* (subpath "${paths.worktree}"))`);
    expect(denyIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(-1);
  });

  it("路径中的双引号被转义，不能截断 SBPL 字符串", () => {
    const evil = { ...paths, worktree: '/W/a"b' };
    const p = buildProfile(evil);
    expect(p).toContain('/W/a\\"b');
    expect(p).not.toContain('"/W/a"b"');
  });

  it("拒绝相对路径——SBPL 的 subpath 必须是绝对路径", () => {
    expect(() => buildProfile({ ...paths, worktree: "relative/path" })).toThrow(/绝对路径/);
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
    expect(() => buildProfile({ ...paths, execRoots: ["relative/bin"] })).toThrow(/绝对路径/);
  });

  it("execRoots 里的双引号同样被转义", () => {
    const p = buildProfile({ ...paths, execRoots: ['/opt/weird"bin'] });
    expect(p).toContain('/opt/weird\\"bin');
    expect(p).not.toContain('"/opt/weird"bin"');
  });

  it("execRoots 为空数组时拒绝——否则 process-exec 会退化为放行一切可执行文件", () => {
    expect(() => buildProfile({ ...paths, execRoots: [] })).toThrow();
  });
});
