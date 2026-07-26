import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Layout } from "../src/layout.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { discoverRepos, loadRegistry, registeredIds, saveRegistry } from "../src/registry.ts";

let ws: string;
let ctrl: string;
let layout: Layout;

function makeRepo(name: string, isGit = true): void {
  mkdirSync(join(ws, name), { recursive: true });
  if (isGit) mkdirSync(join(ws, name, ".git"), { recursive: true });
}

// 保存/恢复：避免这两个变量的赋值泄漏到本文件之外的测试（同一套件里的其它 .test.ts）。
// tests/layout.test.ts 已建立此模式；Task 1 的一处真实教训（测试在开发机上建出了
// 真的 ~/.grande-control）促成了它。
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = saved.ctrl;
});

describe("discoverRepos()", () => {
  it("发现工作区下的 git 仓库", () => {
    makeRepo("alpha");
    makeRepo("beta");
    expect(discoverRepos(layout).sort()).toEqual(["alpha", "beta"]);
  });

  it("跳过非 git 目录", () => {
    makeRepo("alpha");
    makeRepo("notarepo", false);
    expect(discoverRepos(layout)).toEqual(["alpha"]);
  });

  it("跳过派生数据目录 .grande-work——它不是仓库", () => {
    makeRepo("alpha");
    mkdirSync(join(ws, ".grande-work", "worktrees"), { recursive: true });
    mkdirSync(join(ws, ".grande-work", ".git"), { recursive: true });
    expect(discoverRepos(layout)).toEqual(["alpha"]);
  });

  it("跳过其它点开头的目录", () => {
    makeRepo("alpha");
    makeRepo(".hidden");
    expect(discoverRepos(layout)).toEqual(["alpha"]);
  });
});

describe("loadRegistry() / saveRegistry()", () => {
  it("配置不存在时返回空注册表，而不是报错", () => {
    expect(loadRegistry(layout).size).toBe(0);
  });

  it("写入后能读回", () => {
    makeRepo("alpha");
    saveRegistry(layout, [{ repoId: "alpha", path: join(ws, "alpha"), registered: true }]);
    const reg = loadRegistry(layout);
    expect(reg.get("alpha")?.registered).toBe(true);
  });

  it("写出的是带注释的 YAML，便于人手编辑（配置是可信输入，D8）", () => {
    saveRegistry(layout, [{ repoId: "alpha", path: join(ws, "alpha"), registered: true }]);
    const text = readFileSync(layout.reposConfig, "utf8");
    expect(text).toContain("repos:");
    expect(text).toContain("#");
  });

  it("registeredIds 只返回 registered 为 true 的", () => {
    saveRegistry(layout, [
      { repoId: "yes", path: join(ws, "yes"), registered: true },
      { repoId: "no", path: join(ws, "no"), registered: false },
    ]);
    expect([...registeredIds(layout)]).toEqual(["yes"]);
  });

  it("配置文件损坏时抛出可操作的错误，而不是静默当成空注册表", () => {
    writeFileSync(layout.reposConfig, "repos: [ this is : not valid yaml", "utf8");
    expect(() => loadRegistry(layout)).toThrow(/repos\.yaml/);
  });

  it("拒绝含路径分隔符的 repoId——它必须是目录名", () => {
    writeFileSync(layout.reposConfig, "repos:\n  - repoId: a/b\n    registered: true\n", "utf8");
    expect(() => loadRegistry(layout)).toThrow(/a\/b/);
  });
});
