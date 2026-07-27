import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { assertWritable, loadDenyRules, PolicyError } from "../src/policy.ts";

let ws: string, ctrl: string, savedWs: string | undefined, savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "pol-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "pol-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("loadDenyRules()", () => {
  it("配置文件不存在时返回内置默认值，且默认值必须含 .git", () => {
    const l = loadLayout();
    ensureLayout(l);
    const rules = loadDenyRules(l);
    expect(rules.prefixes).toContain(".git/");
  });

  it("配置格式非法时响亮地失败，而不是静默退回默认值", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes: 42\n", "utf8");
    expect(() => loadDenyRules(l)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("用户配置无法移除内置项：显式给空表也拿不掉 .git（AC-14 的底线）", () => {
    const l = loadLayout();
    ensureLayout(l);
    // 这才是真正的攻击形状：不是「忘了写 .git」，是「刻意写一张不含 .git 的表」。
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes: []\n", "utf8");
    expect(loadDenyRules(l).prefixes).toContain(".git/");
  });

  it("配置只能追加不能替换：给了别的前缀，.git 依然在表里", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes:\n  - node_modules/\n", "utf8");
    const rules = loadDenyRules(l);
    expect(rules.prefixes).toContain("node_modules/");
    expect(rules.prefixes).toContain(".git/");
  });

  it("拒绝表只从控制平面读：函数签名里根本没有仓库路径这个入口", () => {
    // 铁律一是**结构性**保证，不是运行时检查：loadDenyRules 只拿 Layout，
    // 没有任何参数能让它去看仓库。这条断言把这个形状钉住，防止以后有人
    // 「顺手」加一个 repoRoot 参数做「项目级 deny 覆盖」。
    expect(loadDenyRules.length).toBe(1);
  });

  it("拒绝以 / 开头的 prefixes 条目（响亮失败，而不是留一条永远不会命中的规则）", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes:\n  - /etc/passwd\n", "utf8");
    expect(() => loadDenyRules(l)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("拒绝包含 .. 的 prefixes 条目（拒绝表只表达仓库内相对路径，不该有向上穿越的能力）", () => {
    const l = loadLayout();
    ensureLayout(l);
    writeFileSync(join(l.configDir, "deny.yaml"), "prefixes:\n  - ../outside\n", "utf8");
    expect(() => loadDenyRules(l)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });
});

describe("assertWritable()", () => {
  const rules = { prefixes: [".git/", "node_modules/"] as const };

  it.each([
    [".git/config"],
    [".git/hooks/pre-commit"],
    ["src/../.git/config"],
    [".git"],
    ["node_modules/foo/index.js"],
  ])("拒绝敏感路径 %s", (p) => {
    expect(() => assertWritable(p, rules)).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it.each([
    ["src/index.ts"],
    ["README.md"],
    ["docs/.gitkeep"],
    ["src/git/helper.ts"],
    [".gitignore"],
  ])("放行正常路径 %s（过度拒绝也是 bug）", (p) => {
    expect(() => assertWritable(p, rules)).not.toThrow();
  });
});
