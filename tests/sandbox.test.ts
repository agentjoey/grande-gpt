import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxPaths } from "../src/sbpl.ts";
import { defaultExecRoots, runSandboxed } from "../src/sandbox.ts";

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
    execRoots: defaultExecRoots(),
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

  it("worktree 自己的 .git 也不可写（它是指向 canonical 的文件，改写会劫持后续 git 操作）", async () => {
    // 真实 git worktree 的 .git 不是目录，是一个指向 canonical `.git/worktrees/<id>`
    // 的文件。之前只测过 canonicalGit 那一侧（hooks 共享），worktree 这一侧的
    // deny 规则连文本存在性检查都没有——这里补上行为级验证。
    const worktreeGit = join(paths.worktree, ".git");
    writeFileSync(worktreeGit, `gitdir: ${paths.canonicalGit}\n`);

    const r = await runSandboxed({
      argv: ["/bin/sh", "-c", `echo pwned > ${worktreeGit}`],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).not.toBe(0);
    expect(readFileSync(worktreeGit, "utf8")).not.toContain("pwned");
  });

  it("同级 worktree 相互隔离：新建的兄弟 worktree 自动被挡住，无需逐个枚举", async () => {
    // 让「本任务」的 worktree 真正嵌在 worktreesRoot 之下（贴近真实目录形状
    // .grande-work/worktrees/<repo>/<task>/），再在它旁边造一个「隔壁任务」的
    // worktree。deny worktreesRoot + allow worktree 的隔离设计能不能扛住，
    // 全靠「最具体规则优先」——这里是唯一真正跑两个 worktree 互相看不见的用例，
    // 之前只检查过 profile 文本里有没有这两行，没验证过行为。
    const ownWorktree = join(paths.worktreesRoot, "task-own");
    const siblingWorktree = join(paths.worktreesRoot, "task-sibling");
    mkdirSync(ownWorktree, { recursive: true });
    mkdirSync(siblingWorktree, { recursive: true });
    writeFileSync(join(siblingWorktree, "secret.txt"), "SIBLING-SECRET");

    const scopedPaths: SandboxPaths = { ...paths, worktree: ownWorktree };
    const r = await runSandboxed({
      argv: ["/bin/cat", join(siblingWorktree, "secret.txt")],
      cwd: ownWorktree,
      paths: scopedPaths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).not.toContain("SIBLING-SECRET");
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

  it("execRoots 覆盖本机工具链：沙箱内可以执行 node（U2 的前提，不能是假 PASS）", async () => {
    // 这是 finding 1 的决定性检查：之前硬编码的 exec 放行清单只覆盖
    // /usr/bin、/bin、/usr/sbin、/opt/homebrew，本机的 node 装在 /usr/local/bin，
    // 实测会被 Seatbelt 拒绝执行（execvp() ... Operation not permitted）。
    // 如果这条不通过，U2「Seatbelt 下 node/npm/vitest 能不能跑」就会被误判为
    // FAIL——而误判的原因跟 Seatbelt 本身无关，只是放行清单没跟上这台机器。
    const r = await runSandboxed({
      argv: [process.execPath, "-e", "console.log('sandboxed-node-ok')"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("sandboxed-node-ok");
  });

  it("超时杀掉整个进程组，孤儿不残留", async () => {
    // marker 必须在 worktree 内：沙箱只放行 worktree 与 jobTmp 两个可写根，
    // 放在 root 的兄弟目录（worktree 之外）会导致 `>>` 在 open() 那一步就被拒绝、
    // 文件从未被创建——那样 before === after 恒成立（0 === 0），跟进程组有没有
    // 真的被杀掉毫无关系，测试等于形同虚设。
    const marker = join(paths.worktree, "orphan-alive");
    const sizeOf = () => (existsSync(marker) ? readFileSync(marker, "utf8").length : 0);

    const r = await runSandboxed({
      // 子进程每秒往 marker 追加一行；父进程 sleep。超时后两者都应停止。
      argv: ["/bin/sh", "-c", `( while true; do echo x >> ${marker}; sleep 1; done ) & sleep 60`],
      cwd: paths.worktree,
      paths,
      timeoutMs: 3_000,
      maxOutputBytes: 65_536,
    });
    expect(r.killedBy).toBe("timeout");

    // 先证明子进程确实活过、确实写过——不然下面「不再增长」的断言在子进程
    // 从未启动时也会平凡成立，等于什么都没证明。
    const before = sizeOf();
    expect(before, "runSandboxed 返回前子进程应已写入过至少一行，证明它确实启动并跑过").toBeGreaterThan(0);

    await new Promise((res) => setTimeout(res, 2500));
    const after = sizeOf();
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

  it("onSpawn 回调在返回前同步触发，传入真实 pgid", async () => {
    let capturedPgid = -1;
    const r = await runSandboxed({
      argv: ["/bin/echo", "x"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 5_000,
      maxOutputBytes: 4096,
      onSpawn: (pgid) => {
        capturedPgid = pgid;
      },
    });
    expect(capturedPgid).toBeGreaterThan(0);
    expect(r.exitCode).toBe(0);
  });

  it("拼写与磁盘不一致的路径被拒，而不是生成一份 deny 规则静默失效的 profile", async () => {
    // APFS 大小写不敏感：这个路径 open() 得开，realpathSync 也原样返回它，
    // 但 Seatbelt 按字节匹配——它对应的 deny 规则会静默失效。
    const wrongCase = join(dirname(paths.worktree), basename(paths.worktree).toUpperCase());
    await expect(
      runSandboxed({ argv: ["/bin/echo", "x"], cwd: paths.worktree,
        paths: { ...paths, worktree: wrongCase }, timeoutMs: 5_000, maxOutputBytes: 4096 }),
    ).rejects.toThrow(/拼写与磁盘不一致/);
  });

  it("拼写正确的路径正常跑（不能过度拒绝）", async () => {
    const r = await runSandboxed({ argv: ["/bin/echo", "ok"], cwd: paths.worktree,
      paths, timeoutMs: 5_000, maxOutputBytes: 4096 });
    expect(r.exitCode).toBe(0);
  });
});

describe("PATH 与 execRoots 同源（回归：修复前二者是两处独立硬编码）", () => {
  /**
   * 用 `env node` 而不是 shebang 脚本来测——两者走的是同一条 PATH 查找，
   * 但 shebang 脚本必须放在 worktree 里，而 worktree 不在 execRoots，
   * 会先撞上「不能 exec worktree 内文件」那个独立问题（exit 71），
   * 把 PATH 的信号盖掉。见 findings/U2 里关于 worktree exec 的记录。
   */
  it("沙箱内经 PATH 能解析到 node —— pnpm 的 shebang 走的正是这条查找", async () => {
    const r = await runSandboxed({
      argv: ["/usr/bin/env", "node", "-e", "console.log('path-ok')"],
      cwd: paths.worktree,
      paths: { ...paths, execRoots: defaultExecRoots() },
      timeoutMs: 20_000,
      maxOutputBytes: 65_536,
    });
    // 修复前：PATH 硬编码为 /opt/homebrew/bin 而 node 在 /usr/local/bin，
    // 此处会得到 exit 127 + "env: node: No such file or directory"
    expect(r.stdout + r.stderr).not.toContain("No such file or directory");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("path-ok");
  }, 25_000);

  it("PATH 与 profile 的 execRoots 完全一致，不可能再分叉", async () => {
    const roots = defaultExecRoots();
    const r = await runSandboxed({
      argv: ["/usr/bin/env"],
      cwd: paths.worktree,
      paths: { ...paths, execRoots: roots },
      timeoutMs: 20_000,
      maxOutputBytes: 65_536,
    });
    const line = r.stdout.split("\n").find((l) => l.startsWith("PATH="));
    expect(line).toBeDefined();
    expect(line!.slice("PATH=".length).split(":").sort()).toEqual([...roots].sort());
  }, 25_000);
});
