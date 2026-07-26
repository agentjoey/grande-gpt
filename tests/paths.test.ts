import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import { loadLayout } from "../src/layout.ts";
import { PathSecurityError, resolveInRepo, resolveRepoPath } from "../src/paths.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
const REGISTERED = new Set(["demo"]);
// 保存/恢复：避免这两个变量的赋值泄漏到本文件之外的测试（同一套件里的其它 .test.ts）。
// tests/layout.test.ts 已建立此模式；Task 1 的一处真实教训（测试在开发机上建出了
// 真的 ~/.grande-control）促成了它。
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  mkdirSync(join(ws, "demo"), { recursive: true });
  layout = loadLayout();
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("resolveRepoPath()", () => {
  it("已注册且存在的 repoId 解析为工作区下的直接子目录", () => {
    expect(resolveRepoPath(layout, "demo", REGISTERED)).toBe(join(layout.workspaceRoot, "demo"));
  });

  it("未注册的 repoId 被拒——自动发现只产生候选，注册才授权", () => {
    mkdirSync(join(ws, "unregistered"));
    expect(() => resolveRepoPath(layout, "unregistered", REGISTERED)).toThrow(
      expect.objectContaining({ code: "REPO_NOT_REGISTERED" }),
    );
  });

  // 每一行都把待测 id 自己注册进临时 registry（`new Set([bad])`），而不是复用共享的
  // REGISTERED（只含 "demo"）。否则 registered.has() 这道**更早**的门会先把所有坏
  // id 拒了，而名字检查本身有没有在起作用，测试根本无法分辨——把名字检查全删了，
  // 六行照样通过（I1）。把 id 自己注册进去，才能让流程真正跑到名字检查这一步，
  // 断言也才能落在它抛出的**具体** code 上，而不是裸 `toThrow()`。
  it.each([
    ["..", "上级目录", "INVALID_INPUT"],
    ["../escape", "相对穿越", "INVALID_INPUT"],
    ["demo/nested", "非直接子目录", "INVALID_INPUT"],
    ["/etc", "绝对路径", "INVALID_INPUT"],
    [".", "当前目录", "INVALID_INPUT"],
    ["", "空串", "INVALID_INPUT"],
  ])("拒绝 %s（%s）", (bad, _desc, code) => {
    expect(() => resolveRepoPath(layout, bad, new Set([bad]))).toThrow(expect.objectContaining({ code }));
  });

  it("拒绝含分隔符的 repoId，即使它已被注册", () => {
    expect(() => resolveRepoPath(layout, "a/b", new Set(["a/b"]))).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it.each([
    ["de\nmo", "换行符"],
    ["de\x00mo", "NUL"],
  ])("拒绝含控制字符的 repoId（%s / %s）（I3-narrow）", (bad) => {
    expect(() => resolveRepoPath(layout, bad, new Set([bad]))).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("拒绝以 - 开头的 repoId——到了 argv 里会被当成命令行选项注入（I3-narrow）", () => {
    const bad = "-rf";
    expect(() => resolveRepoPath(layout, bad, new Set([bad]))).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it.each([" demo", "demo "])("拒绝带前导/尾随空白的 repoId：%s（I3-narrow）", (bad) => {
    expect(() => resolveRepoPath(layout, bad, new Set([bad]))).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("符号链接逃逸：repoId 指向工作区外的目录时必须被拒", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    symlinkSync(outside, join(ws, "escape"));
    expect(() => resolveRepoPath(layout, "escape", new Set(["escape"]))).toThrow(
      expect.objectContaining({ code: "PATH_ESCAPE" }),
    );
    rmSync(outside, { recursive: true, force: true });
  });

  // C2 复现：secret-project 存在但未注册；aliased 已注册，但只是指向 secret-project
  // 的符号链接。aliased 本身是工作区的直接子目录，`dirname(real) === workspaceRoot`
  // 成立——「候选路径必须是工作区的直接子目录」这条检查如果只按 dirname 做，会被
  // 这个例子绕过。`real !== candidate`（real 落在 secret-project，candidate 是
  // aliased 自己）能挡住它，因为它不要求「在工作区下的某个直接子目录」，而要求
  // 「candidate 自己就是它的 realpath」。
  it("已注册的 repoId 若只是指向另一个未注册目录的符号链接，即使该链接本身是工作区直接子目录，也必须被拒（C2）", () => {
    mkdirSync(join(ws, "secret-project"), { recursive: true }); // 存在，但未注册
    symlinkSync(join(ws, "secret-project"), join(ws, "aliased"));
    expect(() => resolveRepoPath(layout, "aliased", new Set(["aliased"]))).toThrow(
      expect.objectContaining({ code: "PATH_ESCAPE" }),
    );
  });

  it("已注册的 repoId 若指向一个普通文件而非目录，必须被拒（M4）", () => {
    writeFileSync(join(ws, "filerepo"), "not a directory");
    expect(() => resolveRepoPath(layout, "filerepo", new Set(["filerepo"]))).toThrow(
      expect.objectContaining({ code: "REPO_NOT_FOUND" }),
    );
  });

  it("目录不存在时报 REPO_NOT_FOUND，而不是返回一个不存在的路径", () => {
    expect(() => resolveRepoPath(layout, "ghost", new Set(["ghost"]))).toThrow(
      expect.objectContaining({ code: "REPO_NOT_FOUND" }),
    );
  });

  it("PathSecurityError：message 干净不带 code 前缀，code 只出现在 name 里（结构化字段才是权威契约）", () => {
    expect.assertions(3);
    try {
      resolveRepoPath(layout, "", REGISTERED);
    } catch (e) {
      expect(e).toBeInstanceOf(PathSecurityError);
      expect((e as PathSecurityError).message).not.toMatch(/^INVALID_INPUT/);
      expect((e as PathSecurityError).name).toBe("PathSecurityError [INVALID_INPUT]");
    }
  });
});

describe("resolveInRepo()", () => {
  let repo: string;
  beforeEach(() => {
    repo = join(layout.workspaceRoot, "demo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "x");
  });

  it("解析仓库内的相对路径", () => {
    expect(resolveInRepo(repo, "src/a.ts")).toBe(join(repo, "src", "a.ts"));
  });

  it.each([
    ["../outside", "PATH_ESCAPE"],
    ["../../etc/passwd", "PATH_ESCAPE"],
    ["/etc/passwd", "INVALID_INPUT"],
    ["src/../../escape", "PATH_ESCAPE"],
  ])("拒绝越界路径 %s（%s）", (bad, code) => {
    expect(() => resolveInRepo(repo, bad)).toThrow(expect.objectContaining({ code }));
  });

  it("允许尚不存在的路径——创建新文件时目标本就不存在", () => {
    expect(resolveInRepo(repo, "src/new.ts")).toBe(join(repo, "src", "new.ts"));
  });

  it("符号链接逃逸：仓库内的链接指向仓库外时被拒", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside2-"));
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(outside, join(repo, "link"));
    expect(() => resolveInRepo(repo, "link/secret.txt")).toThrow(
      expect.objectContaining({ code: "PATH_ESCAPE" }),
    );
    rmSync(outside, { recursive: true, force: true });
  });

  // C1 复现：symlink 目标不存在（悬空）。旧实现用 existsSync 判断「是否已存在」，
  // 而 existsSync 跟随符号链接——目标不存在时它返回 false，把链接本身也当成
  // 「尚未创建的路径」，越过它继续向上找祖先，再把链接的名字拼回已 canonical
  // 化的仓库路径之下：于是一个指向仓库外的悬空链接被当成仓库内的普通路径接受，
  // 而 OS 在实际写入时仍然会跟随这个链接，写到仓库外面去。
  it("悬空符号链接：目标不存在的符号链接必须被拒，而不是被当成仓库内尚未创建的路径接受（C1）", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside3-"));
    const missingTarget = join(outside, "B-PWNED.txt"); // 故意不创建——悬空
    symlinkSync(missingTarget, join(repo, "readme.md"));
    expect(() => resolveInRepo(repo, "readme.md")).toThrow(expect.objectContaining({ code: "PATH_ESCAPE" }));
    rmSync(outside, { recursive: true, force: true });
  });

  it("悬空符号链接（中间路径组件）：目录本身是指向不存在外部目录的符号链接时必须被拒（C1）", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside4-"));
    const missingDir = join(outside, "absent-dir"); // 故意不创建
    symlinkSync(missingDir, join(repo, "build"));
    expect(() => resolveInRepo(repo, "build/out.txt")).toThrow(
      expect.objectContaining({ code: "PATH_ESCAPE" }),
    );
    rmSync(outside, { recursive: true, force: true });
  });

  // C3 复现：demoX-evil 是 demoX 的「字符串前缀扩展」兄弟目录（demoX 是 demoX-evil
  // 的前缀，但不是它的祖先）。isUnder 如果丢了 `+ sep` 这一步，`"...demoX-evil..."
  // .startsWith("...demoX")` 会误判为真——把 demoX-evil 当成在 demoX 之下。
  // 这是 isUnder 存在的全部理由（它自己的注释也这么说），但删掉 `+ sep` 后现有
  // 28 个测试全部照样通过——没有任何一个 fixture 的名字是仓库名的字符串前缀。
  it("isUnder 的字符串前缀防御：兄弟目录名恰是仓库名的前缀扩展时不能被当成「在仓库之下」（C3）", () => {
    mkdirSync(join(ws, "demoX"), { recursive: true });
    mkdirSync(join(ws, "demoX-evil"), { recursive: true });
    writeFileSync(join(ws, "demoX-evil", "secret.txt"), "TOPSECRET");
    symlinkSync(join(ws, "demoX-evil"), join(ws, "demoX", "sib"));
    expect(() => resolveInRepo(join(ws, "demoX"), "sib/secret.txt")).toThrow(
      expect.objectContaining({ code: "PATH_ESCAPE" }),
    );
  });

  // I2 复现：dirname("/x") === "/"，且 "/" 本身已经以分隔符结尾——旧实现的
  // `existing.slice(parent.length + 1)` 假设 parent 从不以分隔符结尾，在文件系统
  // 根部会多切掉一个字符，静默吞掉文件名的第一个字符（实测 realpathAllowingMissing
  // ("/no-such-top-level-dir") 返回 "/o-such-top-level-dir"）。用足够多的 ".." 越过
  // repo 的所有真实祖先（resolve() 在根部截断多余的 ".."），落在一个「/ + 单个不
  // 存在的路径段」上，直接命中这条根部专属的边界。损坏前后的路径都在仓库之外，
  // 所以两种实现都会抛 PATH_ESCAPE——真正能分辨 bug 是否还在的，是错误信息里
  // 那个路径字符串本身有没有被啃掉一个字符。
  it("off-by-one：realpathAllowingMissing 在文件系统根部不能丢字符（I2）", () => {
    const relPath = `${"../".repeat(20)}no-such-top-level-dir-xyz`;
    expect(() => resolveInRepo(repo, relPath)).toThrow(/no-such-top-level-dir-xyz/);
  });
});
