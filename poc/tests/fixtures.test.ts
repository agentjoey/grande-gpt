import { beforeEach, describe, expect, it } from "vitest";
import { getRepo, REPO_IDS, sha256 } from "../src/fixtures.ts";

describe("getRepo()", () => {
  it("已注册的 repoId 返回实例", () => {
    expect(getRepo("demo-app")).toBeDefined();
  });

  it("未注册的 repoId 返回 undefined", () => {
    expect(getRepo("no-such-repo")).toBeUndefined();
  });

  it("REPO_IDS 至少含 demo-app", () => {
    expect(REPO_IDS).toContain("demo-app");
  });

  it("同一 repoId 返回同一实例（状态需跨调用保持）", () => {
    expect(getRepo("demo-app")).toBe(getRepo("demo-app"));
  });
});

describe("FakeRepo", () => {
  beforeEach(() => {
    getRepo("demo-app")!.reset();
  });

  it("readFile 返回内容与 sha256", () => {
    const f = getRepo("demo-app")!.readFile("src/parser.ts");
    expect(f).toBeDefined();
    expect(f!.content).toContain("export function parse");
    expect(f!.sha256).toBe(sha256(f!.content));
  });

  it("readFile 对不存在的路径返回 undefined", () => {
    expect(getRepo("demo-app")!.readFile("src/nope.ts")).toBeUndefined();
  });

  it("初始状态未修复", () => {
    expect(getRepo("demo-app")!.isFixed()).toBe(false);
  });

  it("写入含空输入判断的 parser 后视为已修复", () => {
    const repo = getRepo("demo-app")!;
    repo.writeFile("src/parser.ts", "export function parse(s: string) {\n  if (s.length === 0) return [];\n  return s.split(',');\n}\n");
    expect(repo.isFixed()).toBe(true);
  });

  it("writeFile 后 sha256 变化", () => {
    const repo = getRepo("demo-app")!;
    const before = repo.readFile("src/parser.ts")!.sha256;
    repo.writeFile("src/parser.ts", "changed");
    expect(repo.readFile("src/parser.ts")!.sha256).not.toBe(before);
  });

  it("changedPaths 只列出被写过的文件", () => {
    const repo = getRepo("demo-app")!;
    expect(repo.changedPaths()).toEqual([]);
    repo.writeFile("src/parser.ts", "x");
    expect(repo.changedPaths()).toEqual(["src/parser.ts"]);
  });

  it("reset 清空修改", () => {
    const repo = getRepo("demo-app")!;
    repo.writeFile("src/parser.ts", "x");
    repo.reset();
    expect(repo.changedPaths()).toEqual([]);
    expect(repo.isFixed()).toBe(false);
  });

  it("listPaths 含全部 fixture 文件", () => {
    const paths = getRepo("demo-app")!.listPaths();
    expect(paths).toContain("src/parser.ts");
    expect(paths).toContain("tests/parser.test.ts");
    expect(paths).toContain("src/big-config.ts");
    expect(paths).toContain("src/generated-constants.ts");
  });

  it("big-config.ts 超过 64 KB —— 用于触发 P-5 读取截断", () => {
    const f = getRepo("demo-app")!.readFile("src/big-config.ts")!;
    expect(Buffer.byteLength(f.content, "utf8")).toBeGreaterThan(64 * 1024);
  });

  it("搜索 'export const' 命中超过 50 处 —— 用于触发 P-5 搜索截断", () => {
    expect(getRepo("demo-app")!.search("export const").length).toBeGreaterThan(50);
  });

  it("search 返回路径、行号与行文本", () => {
    const hits = getRepo("demo-app")!.search("export function parse");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ path: "src/parser.ts" });
    expect(hits[0]!.line).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("parse");
  });

  it("diff 在无修改时为空、有修改时含文件名", () => {
    const repo = getRepo("demo-app")!;
    expect(repo.diff()).toEqual([]);
    repo.writeFile("src/parser.ts", "x");
    expect(repo.diff().join("\n")).toContain("src/parser.ts");
  });
});
