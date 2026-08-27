import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    // I6：此前只断言 exitCode !== 0——AC-7 要求的是「断言被拒且文件未创建」，
    // 单看 exitCode 证明不了 shell 重定向真的没能创建/写入那个文件（比如
    // exitCode 非 0 也可能来自其它无关原因）。下面 worktree 自己 .git 的用例
    // 已经用「内容不含 pwned」正确验证过这一类情况，这里的 probe 是全新文件
    // （之前不存在），对应的断言形状是「文件压根没被建出来」。
    const probe = join(paths.canonicalGit, "hooks-probe");
    const r = await runSandboxed({
      argv: ["/bin/sh", "-c", `echo x > ${probe}`],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(probe)).toBe(false);
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

  it("worktreesRoot 目录条目本身可被 lstat/stat——祖先目录遍历不再在这一级 EPERM", async () => {
    // 复现真实故障：`pnpm test`（以及 npm/yarn/vitest/tsc 几乎所有 JS 工具链）启动时
    // 会从 cwd 向上遍历目录树找 workspace root/配置/lockfile，这一步只 lstat 经过的
    // 每一级目录、不读其内容。旧规则用 `subpath` 整体拒读 worktreesRoot，连目录条目
    // 自身『是否存在』都问不到，遍历在这一级直接 EPERM——这里让 worktree 真正嵌在
    // worktreesRoot 之下（贴近 `.grande-work/worktrees/<repo>/<task>/` 的真实形状），
    // 断言从 worktree 出发能 lstat 到 worktreesRoot 本身。
    const ownWorktree = join(paths.worktreesRoot, "task-own");
    mkdirSync(ownWorktree, { recursive: true });
    const scopedPaths: SandboxPaths = { ...paths, worktree: ownWorktree };

    const rLs = await runSandboxed({
      argv: ["/bin/ls", "-d", paths.worktreesRoot],
      cwd: ownWorktree,
      paths: scopedPaths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(rLs.exitCode).toBe(0);
    expect(rLs.stdout.trim()).toBe(paths.worktreesRoot);

    // 与故障报告原文同形的复现：node 直接 lstatSync worktreesRoot。
    const rNode = await runSandboxed({
      argv: [process.execPath, "-e", `require("fs").lstatSync(${JSON.stringify(paths.worktreesRoot)})`],
      cwd: ownWorktree,
      paths: scopedPaths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(rNode.stdout + rNode.stderr).not.toContain("EPERM");
    expect(rNode.stdout + rNode.stderr).not.toContain("operation not permitted");
    expect(rNode.exitCode).toBe(0);
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

describe("pnpm 可执行（BUG 2：pnpm 是符号链接时 execvp 按字面文件名查找会落空）", () => {
  /**
   * 实测复现（本机 2026-07-28）：`which pnpm` → `~/.local/bin/pnpm`，是个符号
   * 链接，真正指向 `~/.local/lib/node_modules/pnpm/bin/pnpm.cjs`；该目标目录
   * 里只有 `pnpm.cjs`，没有字面量叫 `pnpm` 的文件。旧的 `resolveBinaryDir` 只把
   * `realpathSync` 解析后的目标目录塞进 PATH/execRoots，`sandbox-exec` 内部
   * `execvp("pnpm", …)` 按 PATH 逐目录找字面量文件名 `pnpm`——那个目录里找不到，
   * 报 `execvp() of 'pnpm' failed: No such file or directory`（exit 71），这正是
   * 首次真实运行观测到的失败。这条测试跑的是与生产 `~/.grande-control/config/
   * profiles.yaml` 里 `unit` profile 完全相同形状的命令（`argv: ["pnpm", "test"]`），
   * 只是指向一个跑得很快的 fixture package.json，而不是本仓库自己的 446 条测试。
   */
  let root: string;
  let paths: SandboxPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bug2-"));
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
    writeFileSync(
      join(paths.worktree, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: { test: "node -e \"console.log('pnpm-test-ok')\"" },
      }),
      "utf8",
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("argv[0] = 'pnpm'（与真实 unit profile 同形）在沙箱内能被 execvp 解析并跑通", async () => {
    const r = await runSandboxed({
      argv: ["pnpm", "test"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });
    // 修复前的失败形状：exit 71 + "No such file or directory"（sandbox-exec 的
    // execvp 报错文案）。不断言具体 exitCode !== 71 之外还断言 stderr 不含这句
    // 文案，双重锁定这一种失败模式，不是随便什么非零退出码都算过。
    expect(r.exitCode).not.toBe(71);
    expect(r.stdout + r.stderr).not.toContain("No such file or directory");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("pnpm-test-ok");
  }, 35_000);
});

describe("pnpm 向上遍历目录树时不再撞上 EPERM lstat(worktreesRoot)（真实故障复现）", () => {
  /**
   * 上面「BUG 2」那组测试的 worktree 是 `join(root, "worktree")`——跟 worktreesRoot
   * 是兄弟目录，从未嵌在它下面，所以从 worktree 向上走一步就到 root，根本不会经过
   * worktreesRoot，测不出这个故障。真实布局是 `.grande-work/worktrees/<repo>/<task>/`，
   * worktree 嵌在 worktreesRoot 之下；这里照实还原这个嵌套关系，跑一次跟生产 `unit`
   * profile 同形的 `pnpm test`，验证它不再在向上找 workspace root 时死在
   * `lstat(worktreesRoot)` 这一级（原始故障：`EPERM: operation not permitted, lstat
   * '/…/.grande-work/worktrees'`，退出码 1）。
   */
  let root: string;
  let worktree: string;
  let paths: SandboxPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "walkup-"));
    const worktreesRoot = join(root, "worktrees");
    worktree = join(worktreesRoot, "demo-repo", "task-1");
    paths = {
      worktree,
      canonicalGit: join(root, "canonical", ".git"),
      jobTmp: join(root, "jobtmp"),
      controlRoot: join(root, "control"),
      worktreesRoot,
      execRoots: defaultExecRoots(),
    };
    for (const d of [worktree, paths.canonicalGit, paths.jobTmp, paths.controlRoot, worktreesRoot]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(
      join(worktree, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: { test: "node -e \"console.log('walkup-pnpm-test-ok')\"" },
      }),
      "utf8",
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pnpm test 在嵌套于 worktreesRoot 下的 worktree 里正常跑通，不因祖先目录 EPERM 而在启动阶段就死掉", async () => {
    const r = await runSandboxed({
      argv: ["pnpm", "test"],
      cwd: worktree,
      paths,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });
    expect(r.stdout + r.stderr).not.toContain("EPERM");
    expect(r.stdout + r.stderr).not.toContain("operation not permitted");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("walkup-pnpm-test-ok");
  }, 35_000);
});

describe("PATH 与 execRoots 同源（回归：修复前二者是两处独立硬编码）", () => {
  it("将当前 Node 所在目录置于 PATH 首位，避免 runner 工具链被 shadow", () => {
    const roots = defaultExecRoots();
    const nodeRoot = dirname(realpathSync(process.execPath));

    expect(roots.indexOf(nodeRoot)).toBeGreaterThan(-1);
    expect(roots[0]).toBe(nodeRoot);
  });

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

describe("git 在沙箱内可用", () => {
  let root: string;
  let paths: SandboxPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-sbx-"));
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
    execFileSync("git", ["init"], { cwd: paths.worktree });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: paths.worktree });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: paths.worktree });
    writeFileSync(join(paths.worktree, "README.md"), "# Test\n");
    execFileSync("git", ["add", "."], { cwd: paths.worktree });
    execFileSync("git", ["commit", "-m", "init"], { cwd: paths.worktree });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("沙箱内 git rev-parse HEAD 返回 40 位 sha", async () => {
    const r = await runSandboxed({
      argv: ["git", "rev-parse", "HEAD"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("沙箱内 git status --short 在干净 worktree 上返回空", async () => {
    const r = await runSandboxed({
      argv: ["git", "status", "--short"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("沙箱内 git log --oneline -1 返回最新的 commit（形如 'sha msg'）", async () => {
    const r = await runSandboxed({
      argv: ["git", "log", "--oneline", "-1"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{7,} init$/);
  });

  it("沙箱内 git diff --stat HEAD 返回空（HEAD 自身无 diff）", async () => {
    const r = await runSandboxed({
      argv: ["git", "diff", "--stat", "HEAD"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("反向：沙箱内写 worktree 之外路径仍被拒（真实可写路径，不是系统密封卷）", async () => {
    // 在 root 下建一个兄弟目录——磁盘上真实可写，但不在 sandbox 的 file-write* allow 清单里。
    // /pwned.txt 是在 macOS 密封系统卷上，没沙箱时也被拒 (Read-only file system)，是恒真断言。
    // ~/pwned.txt 也不行：runSandboxed 把 HOME 重映射到 jobTmp/home，那里本来就可写。
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const target = join(outside, "pwned.txt");
    const r = await runSandboxed({
      argv: ["/bin/sh", "-c", `echo x > ${target}`],
      cwd: paths.worktree,
      paths,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/not permitted/i);
    // I7：既要断言行文信息，也要断言目标文件真的没被创建——
    // 不能只靠 stderr 文字（万一 sandbox 报的是别的 permission 错误、文件已经落盘了）
    expect(existsSync(target)).toBe(false);
  });

  it("反向：沙箱内 git ls-remote 仍失败（网络仍被拒）", async () => {
    const r = await runSandboxed({
      argv: ["git", "ls-remote", "https://github.com/anomalyco/opencode.git"],
      cwd: paths.worktree,
      paths,
      timeoutMs: 15_000,
      maxOutputBytes: 65_536,
    });
    expect(r.exitCode).not.toBe(0);
  });
});
