import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";

let ws: string;
let ctrl: string;
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL, home: process.env.HOME };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
  if (saved.home === undefined) delete process.env.HOME;
  else process.env.HOME = saved.home;
});

describe("loadLayout()", () => {
  it("从环境变量解析两个根", () => {
    const l = loadLayout();
    // 与下面「解析符号链接」用例一致地做 realpath 比较：macOS 上 tmpdir() 常年是
    // /var/... 这样指向 /private/var/... 的符号链接，loadLayout 按设计会 canonical
    // 化，因此这里比较 canonical 形式，而不是 mkdtempSync 返回的原始（可能带符号
    // 链接的）路径。
    expect(l.workspaceRoot).toBe(realpathSync(ws));
    expect(l.controlRoot).toBe(realpathSync(ctrl));
  });

  it("缺 GRANDE_WORKSPACE 时抛出可操作的错误，而不是猜一个默认值", () => {
    delete process.env.GRANDE_WORKSPACE;
    expect(() => loadLayout()).toThrow(/GRANDE_WORKSPACE/);
  });

  it("GRANDE_CONTROL 缺省时回退到 ~/.grande-control", () => {
    delete process.env.GRANDE_CONTROL;
    const tempHome = mkdtempSync(join(tmpdir(), "grande-home-"));
    try {
      process.env.HOME = tempHome;
      const l = loadLayout();
      const expected = realpathSync(join(tempHome, ".grande-control"));
      expect(l.controlRoot).toBe(expected);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("拒绝相对路径的 GRANDE_WORKSPACE", () => {
    process.env.GRANDE_WORKSPACE = "relative/dir";
    expect(() => loadLayout()).toThrow(/绝对路径/);
  });

  it("解析符号链接——SBPL 与路径比较都要求 canonical 形式", () => {
    // 在 macOS 上 tmpdir() 通常是 /var/... 这样的符号链接；loadLayout 必须返回真实路径
    const l = loadLayout();
    expect(l.workspaceRoot.startsWith("/private/") || !ws.startsWith("/var/")).toBe(true);
  });

  it("控制平面的子路径全部落在 controlRoot 之下，且不在 workspaceRoot 之下", () => {
    const l = loadLayout();
    for (const p of [l.stateDb, l.configDir, l.reposConfig, l.artifactsDir]) {
      expect(p.startsWith(l.controlRoot)).toBe(true);
      expect(p.startsWith(l.workspaceRoot)).toBe(false);
    }
  });

  it("派生数据根在工作区之下（worktree 属于代码工作区）", () => {
    const l = loadLayout();
    expect(l.derivedRoot.startsWith(l.workspaceRoot)).toBe(true);
    expect(l.worktreesRoot.startsWith(l.derivedRoot)).toBe(true);
  });

  it("不创建工作区根——那是用户的目录，不存在应当报错而不是被我们凭空造出来", () => {
    rmSync(ws, { recursive: true, force: true });
    expect(() => loadLayout()).toThrow(/不存在/);
  });

  describe("D3 硬约束：两个根不能互相包含", () => {
    // D3（CLAUDE.md「不得静默推翻的决定」）：被审计者不能拥有审计记录的写权限。
    // 在这条修复之前，loadLayout 只检查 GRANDE_CONTROL 是不是绝对路径，从不检查
    // 它落在哪里——把它设进工作区内部会被静默接受，之后 resolveInRepo 甚至能算出
    // 一条落在仓库里、指向审计库本体的合法写入目标。

    it("拒绝 GRANDE_CONTROL 落在 GRANDE_WORKSPACE 之内", () => {
      process.env.GRANDE_CONTROL = join(ws, ".grande-control-inside");
      expect(() => loadLayout()).toThrow(/控制平面不能是工作区的子目录/);
    });

    it("拒绝 GRANDE_WORKSPACE 落在 GRANDE_CONTROL 之内（反方向同样破坏两棵树互不包含的前提）", () => {
      const nestedWs = join(ctrl, "workspace-inside-control");
      mkdirSync(nestedWs, { recursive: true });
      process.env.GRANDE_WORKSPACE = nestedWs;
      expect(() => loadLayout()).toThrow(/工作区不能是控制平面的子目录/);
    });

    it("两个根正常互不包含（本文件其它所有用例的 fixture 形状）时必须照常被接受，不能为了挡越界连正常布局也一起拒了", () => {
      expect(() => loadLayout()).not.toThrow();
      const l = loadLayout();
      expect(l.workspaceRoot).toBe(realpathSync(ws));
      expect(l.controlRoot).toBe(realpathSync(ctrl));
    });
  });
});

describe("ensureLayout()", () => {
  it("创建控制平面目录", () => {
    const l = loadLayout();
    ensureLayout(l);
    expect(existsSync(join(l.controlRoot, "state"))).toBe(true);
    expect(existsSync(l.configDir)).toBe(true);
    expect(existsSync(l.artifactsDir)).toBe(true);
  });

  it("幂等：重复调用不报错", () => {
    const l = loadLayout();
    ensureLayout(l);
    expect(() => ensureLayout(l)).not.toThrow();
  });
});
