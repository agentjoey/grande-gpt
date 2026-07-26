import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxPaths } from "../src/sbpl.ts";
import { runSandboxed } from "../src/sandbox.ts";

let root: string;
let paths: SandboxPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spike-"));
  paths = {
    worktree: join(root, "worktree"),
    canonicalGit: join(root, "canonical", ".git"),
    jobTmp: join(root, "jobtmp"),
    controlRoot: join(root, "control"),
    worktreesRoot: join(root, "worktrees"),
  };
  for (const d of [paths.worktree, paths.canonicalGit, paths.jobTmp, paths.controlRoot, paths.worktreesRoot]) {
    mkdirSync(d, { recursive: true });
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("runSandboxed()", () => {
  it("可写根内写入成功", async () => {
    const r = await runSandboxed({
      argv: ["/bin/sh", "-c", `echo hi > ${paths.worktree}/a.txt && echo done`],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("done");
  });

  it("控制平面根不可读", async () => {
    writeFileSync(join(paths.controlRoot, "secret.txt"), "TOPSECRET");
    const r = await runSandboxed({
      argv: ["/bin/cat", join(paths.controlRoot, "secret.txt")],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("TOPSECRET");
  });

  it("canonical 的 .git 不可写", async () => {
    const r = await runSandboxed({
      argv: ["/bin/sh", "-c", `echo x > ${paths.canonicalGit}/hooks-probe`],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).not.toBe(0);
  });

  it("网络被拒", async () => {
    const r = await runSandboxed({
      argv: ["/usr/bin/curl", "-sS", "--max-time", "5", "http://1.1.1.1"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).not.toBe(0);
  });

  it("环境变量被清洗：宿主的密钥不进沙箱", async () => {
    process.env.SPIKE_FAKE_TOKEN = "should-not-leak";
    try {
      const r = await runSandboxed({
        argv: ["/usr/bin/env"],
        cwd: paths.worktree,
        paths,
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
      });
      expect(r.stdout).not.toContain("should-not-leak");
      expect(r.stdout).toContain(`HOME=${paths.jobTmp}/home`);
    } finally {
      delete process.env.SPIKE_FAKE_TOKEN;
    }
  });

  it("超时杀掉整个进程组，孤儿不残留", async () => {
    const marker = join(root, "orphan-alive");
    const r = await runSandboxed({
      // 子进程每秒往 marker 追加一行；父进程 sleep。超时后两者都应停止。
      argv: ["/bin/sh", "-c", `( while true; do echo x >> ${marker}; sleep 1; done ) & sleep 60`],
      cwd: paths.worktree,
      paths,
      timeoutMs: 3_000,
      maxOutputBytes: 65_536,
    });
    expect(r.killedBy).toBe("timeout");
    const { readFileSync, existsSync } = await import("node:fs");
    const before = existsSync(marker) ? readFileSync(marker, "utf8").length : 0;
    await new Promise((res) => setTimeout(res, 2500));
    const after = existsSync(marker) ? readFileSync(marker, "utf8").length : 0;
    expect(after, "超时后子进程仍在写文件，说明进程组没杀干净").toBe(before);
  }, 10_000); // vitest 默认 testTimeout 5000ms < 本用例自身设计耗时(3000ms timeoutMs + 2500ms 观察窗口)，需单独放宽

  it("输出超限时截断并标记", async () => {
    const r = await runSandboxed({
      argv: ["/bin/sh", "-c", "for i in $(seq 1 100000); do echo AAAAAAAAAAAAAAAAAAAA; done"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 20_000,
      maxOutputBytes: 4096,
    });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout, "utf8")).toBeLessThanOrEqual(8192);
  });
});
