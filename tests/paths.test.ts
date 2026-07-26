import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import { loadLayout } from "../src/layout.ts";
import { resolveInRepo, resolveRepoPath } from "../src/paths.ts";

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
    expect(() => resolveRepoPath(layout, "unregistered", REGISTERED)).toThrow(/REPO_NOT_REGISTERED/);
  });

  it.each([
    ["..", "上级目录"],
    ["../escape", "相对穿越"],
    ["demo/nested", "非直接子目录"],
    ["/etc", "绝对路径"],
    [".", "当前目录"],
    ["", "空串"],
  ])("拒绝 %s（%s）", (bad) => {
    expect(() => resolveRepoPath(layout, bad, REGISTERED)).toThrow();
  });

  it("拒绝含分隔符的 repoId，即使它已被注册", () => {
    expect(() => resolveRepoPath(layout, "a/b", new Set(["a/b"]))).toThrow(/INVALID_INPUT/);
  });

  it("符号链接逃逸：repoId 指向工作区外的目录时必须被拒", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    symlinkSync(outside, join(ws, "escape"));
    expect(() => resolveRepoPath(layout, "escape", new Set(["escape"]))).toThrow(/PATH_ESCAPE/);
    rmSync(outside, { recursive: true, force: true });
  });

  it("目录不存在时报 REPO_NOT_FOUND，而不是返回一个不存在的路径", () => {
    expect(() => resolveRepoPath(layout, "ghost", new Set(["ghost"]))).toThrow(/REPO_NOT_FOUND/);
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

  it.each(["../outside", "../../etc/passwd", "/etc/passwd", "src/../../escape"])(
    "拒绝越界路径 %s",
    (bad) => {
      expect(() => resolveInRepo(repo, bad)).toThrow(/PATH_ESCAPE|INVALID_INPUT/);
    },
  );

  it("允许尚不存在的路径——创建新文件时目标本就不存在", () => {
    expect(resolveInRepo(repo, "src/new.ts")).toBe(join(repo, "src", "new.ts"));
  });

  it("符号链接逃逸：仓库内的链接指向仓库外时被拒", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside2-"));
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET");
    symlinkSync(outside, join(repo, "link"));
    expect(() => resolveInRepo(repo, "link/secret.txt")).toThrow(/PATH_ESCAPE/);
    rmSync(outside, { recursive: true, force: true });
  });
});
