import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// 命名空间导入，专供 round 2 C 的 guardFs 测试引用被 vi.mock 换掉的 realpathSync。
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "../src/layout.ts";
import { loadLayout } from "../src/layout.ts";
import { PathSecurityError, resolveInRepo, resolveRepoPath } from "../src/paths.ts";

// Round 2 复审 C：guardFs 窄化测试要伪造一个「非 fs 错误」，但 node:fs 是内置模块，
// ESM 的模块命名空间不可配置——`vi.spyOn(fs, "realpathSync")` 会直接抛
// "Cannot redefine property"（已实测）。改用 vi.mock 在模块解析层面整体换掉
// node:fs：除 realpathSync 外全部透传 actual 实现（用 vi.fn 包一层，默认行为就是
// 调用真实实现，因此对本文件其它所有测试都透明），只有这一个函数变成可在单个
// 测试里用 mockImplementationOnce 临时改写行为的桩。这个替换对 src/paths.ts 内部
// `import { realpathSync } from "node:fs"` 同样生效——vi.mock 拦截的是模块解析，
// 不只是本文件的直接引用。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

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

  // Round 2 复审 B：这几个码点都不在 C0 控制字符范围内，trim() 也只挡首尾、挡不住
  // 出现在字符串内部的这些字符——bidi override（RLO 等）能让目录名在终端/UI 里
  // 显示成误导性的顺序，U+2028/U+2029 一旦被拼进按行处理的日志效果等同于换行
  // 注入，U+200B 零宽空格能让两个视觉上相同的名字实际不同。刻意只挑这几个「没有
  // 合法目录名用途」的码点，不做 ASCII allowlist——下面单独有一条测试证明
  // "我的项目" 这样合法的非 ASCII 目录名仍然可以注册。
  it.each([
    ["\u202e我的项目", "U+202E RLO 双向覆盖"],
    ["我\u200b的项目", "U+200B 零宽空格"],
    ["我的\u2028项目", "U+2028 行分隔符"],
    ["我的\u2029项目", "U+2029 段分隔符"],
  ])("拒绝含显示欺骗/行分隔符的 repoId：%s（%s）（round 2 B）", (bad, _desc) => {
    expect(() => resolveRepoPath(layout, bad, new Set([bad]))).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("非 ASCII 但合法的目录名仍必须被接受——不能退化成 ASCII allowlist（round 2 B）", () => {
    mkdirSync(join(ws, "我的项目"), { recursive: true });
    expect(resolveRepoPath(layout, "我的项目", new Set(["我的项目"]))).toBe(
      join(layout.workspaceRoot, "我的项目"),
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

  it("允许多层尚不存在的新子目录——每一层都还没创建也不能因此拒绝（round 2 验证不过度拒绝）", () => {
    expect(resolveInRepo(repo, "a/b/c/d/new.ts")).toBe(join(repo, "a", "b", "c", "d", "new.ts"));
  });

  // Round 2 复审 BLOCKING 2：repoId 早就挡了控制字符，relativePath 同样是模型
  // 可控字符串，之前一项都没挡——换行能伪造日志行；NUL 会产生一个 Node 拒绝而
  // 不是截断的毒化返回值，若不在这里挡住，会在调用方下一次 fs 调用时炸出没有
  // .code 的裸 ERR_INVALID_ARG_VALUE（M5 想堵的正是这类泄漏）。整串扫描，与
  // repoId 共用同一个 assertNoControlChars。
  it.each([
    ["src/a\nb.ts", "换行符"],
    ["src/a\x00b.ts", "NUL"],
  ])("拒绝含控制字符的 relativePath：%s（%s）（round 2 BLOCKING 2）", (bad, _desc) => {
    expect(() => resolveInRepo(repo, bad)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  // repoId 前导 - 检查（argv 选项注入）在 relativePath 上的类比，逐段检查而不只
  // 查整串开头——"src/-rf" 中间那一段同样危险，不能只挡 relativePath 本身以
  // - 开头的情况。
  it.each([
    ["-rf", "整串就是一段"],
    ["src/-rf", "危险段在中间"],
  ])("拒绝路径分段以 - 开头的 relativePath：%s（%s）（round 2 BLOCKING 2）", (bad, _desc) => {
    expect(() => resolveInRepo(repo, bad)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  // 不过度拒绝：文件名里的空格是合法字符——round 2 复审明确要求不能因为加固
  // relativePath 校验就连带拒掉这类合法文件名。相对于 repoId 的首尾空白检查，
  // 这里刻意不对 relativePath 做同样的 trim 检查（见 resolveInRepo 上方 JSDoc）。
  it("不过度拒绝：文件名中的空格是合法字符，'my file.txt' 必须仍能正常解析（round 2 BLOCKING 2）", () => {
    expect(resolveInRepo(repo, "my file.txt")).toBe(join(repo, "my file.txt"));
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

  // Round 2 复审 A：上面两个 C1 用例的悬空链接目标都指向仓库外。「目标其实在
  // 仓库内的悬空链接」这个方向此前完全没被钉住——src/paths.ts 曾经的注释声称
  // 「没法证明目标在不在仓库内」，这个说法是假的（readlinkSync 能读出目标，
  // 对它套用同一套 containment 检查就能证明）；真实原因是选择不做这层解析
  // （见 resolveInRepo 上方注释的完整论证）。这里把「选择」钉成行为：即使目标
  // 确凿在仓库内，悬空链接依然被拒——这不是待修的 bug，是当前设计，测试防止它
  // 被后人不知不觉改掉。
  it("悬空符号链接（目标在仓库内）：即使能证明目标其实在仓库内，也依然被拒——这是选择而非局限（round 2 A）", () => {
    const missingTarget = join(repo, "real.ts"); // 故意不创建——悬空，但目标路径在仓库内
    symlinkSync(missingTarget, join(repo, "alias.ts"));
    expect(() => resolveInRepo(repo, "alias.ts")).toThrow(expect.objectContaining({ code: "PATH_ESCAPE" }));
  });

  it("悬空符号链接（中间路径组件，目标在仓库内）：目录本身是指向仓库内不存在目录的符号链接时依然被拒（round 2 A）", () => {
    const missingDir = join(repo, "dist"); // 故意不创建——悬空，但目标路径在仓库内
    symlinkSync(missingDir, join(repo, "build2"));
    expect(() => resolveInRepo(repo, "build2/out.js")).toThrow(
      expect.objectContaining({ code: "PATH_ESCAPE" }),
    );
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
  // Round 2 复审 BLOCKING 1：旧断言 /no-such-top-level-dir-xyz/ 不区分大小写地匹配
  // 整条错误消息，而消息里 `${relativePath} → ${real}` 两段都可能含这个子串——
  // relativePath 是原始输入，永远完整（20 个 "../" 只是前缀，不会碰这段文件名），
  // 所以不管 real 有没有被啃掉一个字符，relativePath 那一半总能让正则匹配上，
  // 测试对 bug 完全没有分辨力（对着 buggy slice() 和修好的 basename() 两种实现
  // 都会 PASS）。锚定到 "→ " 之后，只让它有可能匹配 real 那一半：buggy 版本
  // real 是 "/o-such-top-level-dir-xyz"（丢了开头的 "n"），不含 "→ /no-such..."
  // 这个子串，断言会失败；修好的版本 real 是 "/no-such-top-level-dir-xyz"，断言
  // 通过。下面的「load-bearing 验证」用临时改回 buggy 实现的方式实测了这一点。
  it("off-by-one：realpathAllowingMissing 在文件系统根部不能丢字符（I2）", () => {
    const relPath = `${"../".repeat(20)}no-such-top-level-dir-xyz`;
    expect(() => resolveInRepo(repo, relPath)).toThrow(/→ \/no-such-top-level-dir-xyz/);
  });

  // Round 2 复审 C：guardFs 窄化前会不加区分地把任何错误都转换成
  // PathSecurityError，包括编程错误——一个真正的 bug 会被伪装成「策略拒绝」。
  // 真实的 fs 失败（ENOENT/ELOOP/……）都带 errno 风格 .code，TypeError 没有，
  // 拿它伪造一次「非 fs 错误」：打桩 node:fs 的 realpathSync（resolveInRepo 内部
  // 通过 realpathAllowingMissing 和直接调用两处都会走到它），确认窄化后的
  // guardFs 让它原样穿透，而不是包装成 PathSecurityError。
  it("guardFs 只转换带 errno 风格 .code 的错误——非 fs 错误（如 TypeError）原样穿透，不被伪装成 PathSecurityError（round 2 C）", () => {
    expect.assertions(2);
    // 只打桩这一次调用：resolveInRepo(repo, "src/a.ts") 命中 realpathSync 恰好
    // 一次（src/a.ts 已存在，realpathAllowingMissing 的循环不执行，直接调用一次
    // realpathSync；异常在这里就终止了函数，第二处 realpathSync(repoRoot) 调用
    // 不会发生），mockImplementationOnce 用完这一次就自动恢复成 actual 透传，
    // 不需要、也不应该手动 restore（对 vi.fn 调 mockRestore 等价于
    // mockReset，会连 vi.mock 工厂里设的透传实现一起清空，波及本文件其它测试）。
    vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      throw new TypeError("boom - not an fs error");
    });
    try {
      resolveInRepo(repo, "src/a.ts");
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      expect(e).not.toBeInstanceOf(PathSecurityError);
    }
  });
});
