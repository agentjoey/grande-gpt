import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxPaths } from "../src/sbpl.ts";
import { defaultExecRoots, runSandboxed } from "../src/sandbox.ts";

// U2 决定性验证：在真实 pnpm 项目（poc/）上跑 vitest，deny default + deny network 之下。
// poc/ 是本机唯一一个用 pnpm 装好、有真实 vitest 套件（135 用例）且 node_modules
// 为 pnpm 符号链接布局的项目——保真度最高，零搭建成本。

const POC = "/Users/xtation/AgentWorks/GPT_Workspace/grande-gpt/poc";
// 解析真实 pnpm 路径而不是硬编码 /opt/homebrew/bin/pnpm——装法因机器而异
// （官方安装器、nvm、volta、asdf、Intel/Apple Silicon Homebrew 各不相同），
// 硬编码在换一台机器时会直接报「找不到文件」，跟这个任务要测的东西无关。
const PNPM = execFileSync("/usr/bin/which", ["pnpm"], { encoding: "utf8" }).trim();
let jobTmp: string;
let paths: SandboxPaths;

beforeEach(() => {
  jobTmp = mkdtempSync(join(tmpdir(), "u2-"));
  mkdirSync(join(jobTmp, "home"), { recursive: true });
  // canonicalGit / controlRoot / worktreesRoot 自 Task 1 起是 realpathSync 的强制
  // 输入（runSandboxed 对 SandboxPaths 的全部路径字段做符号链接解析——这是
  // load-bearing 行为，见 sandbox.ts 顶部注释）。三者对这个场景而言语义上都是
  // "不存在/不相关的占位"，但 realpathSync 要求路径必须真实存在，否则直接抛
  // ENOENT——brief 原稿写的 `.git-nonexistent`/`.nope` 字面上就不存在，会在
  // buildProfile 之前就崩溃。这里改为在 jobTmp 下建空目录占位，靠 afterEach
  // 自动清理，也不碰 POC 本身（poc/ 除测试运行自身产生的写入外必须保持只读）。
  const canonicalGitStub = join(jobTmp, "canonical-git-stub");
  const controlRootStub = join(jobTmp, "control-none");
  const worktreesRootStub = join(jobTmp, "worktrees-none");
  mkdirSync(canonicalGitStub, { recursive: true });
  mkdirSync(controlRootStub, { recursive: true });
  mkdirSync(worktreesRootStub, { recursive: true });
  paths = {
    // 把 poc/ 当作「worktree」：它可写（vitest 会写缓存），其余边界照常
    worktree: POC,
    canonicalGit: canonicalGitStub,
    jobTmp,
    controlRoot: controlRootStub,
    worktreesRoot: worktreesRootStub,
    execRoots: defaultExecRoots(),
  };
});

afterEach(() => rmSync(jobTmp, { recursive: true, force: true }));

describe("U2：Seatbelt 下真实 pnpm 项目能否跑通", () => {
  it("在 deny default + deny network 下，vitest 全套通过", async () => {
    const r = await runSandboxed({
      argv: [PNPM, "test"],
      cwd: POC,
      paths,
      timeoutMs: 180_000,
      maxOutputBytes: 512_000,
    });
    // 失败时把输出打出来——这份输出就是「还需要放行什么」的清单
    if (r.exitCode !== 0) {
      console.error("=== STDOUT ===\n" + r.stdout.slice(-4000));
      console.error("=== STDERR ===\n" + r.stderr.slice(-4000));
    }
    expect(r.killedBy, "被兜底机制杀掉，不是正常退出").toBeNull();
    expect(r.exitCode, "沙箱内 pnpm test 未通过").toBe(0);
    expect(r.stdout + r.stderr).toContain("135 passed");
  }, 200_000);
});
