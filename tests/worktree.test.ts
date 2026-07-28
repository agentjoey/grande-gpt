import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { listChangedFiles, openWorktree, removeWorktree, repoDiff } from "../src/worktree.ts";

let ws: string, ctrl: string, layout: Layout, repo: string;
let savedWs: string | undefined, savedCtrl: string | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** 与 layout.ts/paths.ts 里同名函数逻辑一致，本文件单独放一份而不是跨模块 import
 *  （项目既有约定，见 layout.ts 同名函数的 JSDoc）：真正判断 child 是否在 parent
 *  之下，而不是裸 `.startsWith`——后者在 `/a/bc` 相对 `/a/b` 这类相邻兄弟路径上
 *  会给出假阳性（MINOR 修复）。 */
function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "wt-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "wt-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);

  repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.ts"), "v1\n", "utf8");
  // z.ts 必须在初始提交里（C-3）：排序的承重性靠「已跟踪且被修改的文件排在
  // 未跟踪文件之后」才能测出来——见下面「顺序确定」测试的注释。
  writeFileSync(join(repo, "z.ts"), "v1\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");

  writeFileSync(join(layout.reposConfig), `repos:\n  - repoId: demo\n    path: ${repo}\n    registered: true\n`, "utf8");
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("openWorktree()", () => {
  it("建出 worktree 与分支，路径在 worktreesRoot 之下", () => {
    const info = openWorktree(layout, "demo", "fix-parser", "task_abcd");
    expect(existsSync(info.worktreePath)).toBe(true);
    // 用真正的「在……之下」判断，不用裸 `.startsWith`（MINOR 修复，见上面 isUnder）。
    expect(isUnder(layout.worktreesRoot, info.worktreePath)).toBe(true);
    expect(info.branch).toBe("grande/fix-parser-abcd");
    expect(info.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    // worktree 里能看到 canonical 的内容
    expect(existsSync(join(info.worktreePath, "a.ts"))).toBe(true);
  });

  it("taskId 末尾是分隔符时分支名不出现双连字符（生产实测 grande/<slug>--001 的回归）", () => {
    // `task-ub-probe-20260729-001` 的裸 slice(-4) 是 `-001`，拼在 `${slug}-` 后面
    // 就产出了 `grande/ub-probe--001`。后缀改取末 4 位【字母数字】后应为 `9001`。
    const info = openWorktree(layout, "demo", "ub-probe", "task-ub-probe-20260729-001");
    expect(info.branch).toBe("grande/ub-probe-9001");
    expect(info.branch).not.toContain("--");
  });

  it("canonical 的工作区【不受影响】：分支没被切走，文件没变", () => {
    // 这是原地模型（D4）的核心承诺——用户还在用编辑器干活，不能被我们切分支。
    const before = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
    openWorktree(layout, "demo", "fix", "task_abcd");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(before);
  });

  it("两个任务的 worktree 互相隔离", () => {
    const a = openWorktree(layout, "demo", "one", "task_aaaa");
    const b = openWorktree(layout, "demo", "two", "task_bbbb");
    expect(a.worktreePath).not.toBe(b.worktreePath);
    writeFileSync(join(a.worktreePath, "only-a.ts"), "x", "utf8");
    expect(existsSync(join(b.worktreePath, "only-a.ts"))).toBe(false);
  });

  it("未注册的仓库被拒", () => {
    expect(() => openWorktree(layout, "not-registered", "s", "task_abcd")).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/REPO_NOT_REGISTERED|REPO_NOT_FOUND/) }),
    );
  });

  it("重复的 taskId 被拒，而不是静默复用别人的 worktree", () => {
    openWorktree(layout, "demo", "one", "task_abcd");
    expect(() => openWorktree(layout, "demo", "two", "task_abcd")).toThrow(
      expect.objectContaining({ code: "WORKTREE_EXISTS" }),
    );
  });

  it.each(["../../../../tmp/evil", "..", ".", "a/b", "task abcd", ""])(
    "含路径穿越的 taskId 被拒：%s（C-4）", (bad) => {
      expect(() => openWorktree(layout, "demo", "s", bad)).toThrow(
        expect.objectContaining({ code: "INVALID_INPUT" }),
      );
      // 关键在于「worktree 没被建到工作区外面」，不只是「抛了个错」——断言的是
      // 漏洞真正会产生的那个 join 结果本身不存在。此前这里断言的是硬编码的
      // `/tmp/evil`：ws/layout.worktreesRoot 来自 mkdtempSync，在 macOS 上落在
      // `/var/folders/.../T/wt-ws-XXXXXX/...` 之下（tmpdir() 不是字面量
      // `/tmp`），`../../../../tmp/evil` 从这么深的 worktreesRoot 向上走 4 层
      // 也走不到字面量 `/tmp` 之下——`existsSync("/tmp/evil")` 无论校验有没有
      // 生效都恒为 false，这条断言从未真正验证过任何东西（空转）。
      const wouldBeTarget = join(layout.worktreesRoot, "demo", bad);
      expect(existsSync(wouldBeTarget)).toBe(false);
    },
  );

  it("canonical 处于 rebase 中时拒绝开新任务", () => {
    mkdirSync(join(repo, ".git", "rebase-merge"), { recursive: true });
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).toThrow(
      expect.objectContaining({ code: "CANONICAL_BUSY" }),
    );
  });

  it("canonical 处于 detached HEAD 时拒绝开新任务（规格 §7：CANONICAL_BUSY 明确列出这一种状态）", () => {
    const sha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", sha); // 直接检出一个 sha，产生 detached HEAD
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).toThrow(
      expect.objectContaining({ code: "CANONICAL_BUSY" }),
    );
  });

  it("绝不执行 git fetch（规格 §5.4①：大仓库上会撑爆 60s 超时）", () => {
    // 无 remote 的仓库里 `git fetch` 静默 exit 0（实测），所以「不抛错」证明不了任何事。
    // 改成给仓库配一个必然失败的 remote：只要实现里有 fetch，就一定抛 GIT_FAILED（I-1）。
    git(repo, "remote", "add", "origin", "file:///nonexistent-remote-for-fetch-probe.git");
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).not.toThrow();
  });

  it("depDirs 声明的目录（如 node_modules）会从 canonical 克隆进新 worktree（I-6）", () => {
    const nm = join(repo, "node_modules", "some-pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "index.js"), "module.exports = 1;\n", "utf8");
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      'depDirs:\n  demo: ["node_modules"]\nrepos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
      "utf8",
    );
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    expect(existsSync(join(info.worktreePath, "node_modules", "some-pkg", "index.js"))).toBe(true);
  });

  it("clonefile 语义（BUG 3）：改写 worktree 里克隆出的文件，canonical 的原文件不受影响", () => {
    const nm = join(repo, "node_modules", "some-pkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "index.js"), "module.exports = 1;\n", "utf8");
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      'depDirs:\n  demo: ["node_modules"]\nrepos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
      "utf8",
    );
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    const clonedFile = join(info.worktreePath, "node_modules", "some-pkg", "index.js");
    expect(existsSync(clonedFile)).toBe(true);

    // `cp -Rc` 是写时复制：两份 inode 不同但内容相同，改写克隆出来的那一份必须
    // 不影响 canonical 的原始文件——如果这里失败（两者内容一起变），说明落地的
    // 不是 clonefile 而是硬链接/引用同一份数据。
    writeFileSync(clonedFile, "module.exports = 999; // 被任务修改\n", "utf8");
    expect(readFileSync(join(nm, "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(readFileSync(clonedFile, "utf8")).toContain("999");
  });

  it("canonical 里没有的 depDirs 目录被跳过，不报错（比如全新仓库还没 install）", () => {
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      'depDirs:\n  demo: ["node_modules"]\nrepos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
      "utf8",
    );
    expect(() => openWorktree(layout, "demo", "s", "task_abcd")).not.toThrow();
  });
});

describe("listChangedFiles() 与 repoDiff()", () => {
  it("无改动时返回空", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    expect(listChangedFiles(info.worktreePath, info.baseCommit)).toEqual([]);
    expect(repoDiff(info.worktreePath, info.baseCommit).files).toEqual([]);
  });

  it("列出已改与新增的文件，顺序确定（已跟踪的 z.ts 排在未跟踪的 b.ts 之后）", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "z.ts"), "v2\n", "utf8");   // 已跟踪，被修改
    writeFileSync(join(info.worktreePath, "b.ts"), "new\n", "utf8");  // 未跟踪，新增
    // 未排序时 git 给的是 ["z.ts","b.ts"]（两个列表各自有序，拼接后无序）——
    // 这正是去掉 .sort() 会变红的形状（C-3）。
    expect(listChangedFiles(info.worktreePath, info.baseCommit)).toEqual(["b.ts", "z.ts"]);
  });

  it("diff 含实际改动内容", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "a.ts"), "v2\n", "utf8");
    const d = repoDiff(info.worktreePath, info.baseCommit);
    expect(d.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(d.files[0]!.hunks).toContain("+v2");
    expect(d.files[0]!.hunks).toContain("-v1");
  });

  it("新增文件的 diff 也含实际内容，不是空字符串（C-1：git diff --no-index 有差异时 exit 1，此前被 catch 吞成空）", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "new.ts"), "brand new\n", "utf8");
    const d = repoDiff(info.worktreePath, info.baseCommit);
    expect(d.files.map((f) => f.path)).toEqual(["new.ts"]);
    expect(d.files[0]!.hunks).toContain("+brand new");
  });

  it("非 ASCII 文件名的新增文件也能被列出与 diff（C-1：默认 core.quotePath 会把它 C-quote 成匹配不到任何文件的字面量）", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "café.ts"), "bonjour\n", "utf8");
    expect(listChangedFiles(info.worktreePath, info.baseCommit)).toEqual(["caf\u00e9.ts"]);
    const d = repoDiff(info.worktreePath, info.baseCommit);
    expect(d.files.map((f) => f.path)).toEqual(["caf\u00e9.ts"]);
    expect(d.files[0]!.hunks).toContain("+bonjour");
  });

  it("超过 maxLines 时按文件分页，续取不重不漏", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    for (const n of ["f1.ts", "f2.ts", "f3.ts"]) {
      writeFileSync(join(info.worktreePath, n), "x\n".repeat(20), "utf8");
    }
    const first = repoDiff(info.worktreePath, info.baseCommit, { maxLines: 25 });
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = repoDiff(info.worktreePath, info.baseCommit, { maxLines: 1000, cursor: first.nextCursor });
    const seen = [...first.files, ...second.files].map((f) => f.path);
    expect(new Set(seen).size).toBe(seen.length);       // 不重
    expect(new Set(seen)).toEqual(new Set(["f1.ts", "f2.ts", "f3.ts"])); // 不漏
  });

  it("单个超过 maxLines 的大文件仍会被给出，cursor 必须前进（否则模型永远轮询，I-2）", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    writeFileSync(join(info.worktreePath, "big.ts"), "y\n".repeat(600), "utf8");
    writeFileSync(join(info.worktreePath, "s2.ts"), "small\n", "utf8");
    const first = repoDiff(info.worktreePath, info.baseCommit, { maxLines: 400 });
    expect(first.files.map((f) => f.path)).toEqual(["big.ts"]); // 去掉 files.length>0 守卫时这里是 []
    expect(first.nextCursor).toBe("1");                         // …且 nextCursor 恒为 "0"
    const second = repoDiff(info.worktreePath, info.baseCommit, { maxLines: 400, cursor: first.nextCursor });
    expect(second.files.map((f) => f.path)).toEqual(["s2.ts"]);
    expect(second.nextCursor).toBeNull();
  });

  it("字段声明顺序：truncated/nextCursor 排在 files 之前", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    const keys = Object.keys(repoDiff(info.worktreePath, info.baseCommit));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("files"));
    expect(keys.indexOf("nextCursor")).toBeLessThan(keys.indexOf("files"));
  });
});

describe("removeWorktree()", () => {
  it("移除 worktree 目录，且 canonical 仓库仍然健康", () => {
    const info = openWorktree(layout, "demo", "s", "task_abcd");
    removeWorktree(layout, { repoId: "demo", worktreePath: info.worktreePath, branch: info.branch });
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(() => git(repo, "status", "--short")).not.toThrow();
  });

  it("同时清理分支：换一个不同 taskId 但后四位相同时，不会因为分支已存在而失败（MINOR）", () => {
    const info = openWorktree(layout, "demo", "s", "task_1abcd");
    removeWorktree(layout, { repoId: "demo", worktreePath: info.worktreePath, branch: info.branch });
    // 分支名只取决于 slug 与 taskId 后四位（见 openWorktree）：task_1abcd 与 task_2abcd
    // 后四位都是 abcd，会撞上同一个分支名 grande/s-abcd——如果上一次没把分支删干净，
    // 这里会因为分支已存在而抛错。
    expect(() => openWorktree(layout, "demo", "s", "task_2abcd")).not.toThrow();
  });
});
