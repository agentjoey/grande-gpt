import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoMap } from "../src/repoMap.ts";

let root: string;

function file(rel: string, content = "x") {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "map-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repoMap()", () => {
  it("列出文件与目录，路径是仓库内相对路径且用 / 分隔", () => {
    file("src/index.ts");
    file("README.md");
    const r = repoMap(root);
    const paths = r.entries.map((e) => e.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src");
    expect(paths.every((p) => !p.startsWith("/"))).toBe(true);
  });

  it("跳过 .git、node_modules 与 .grande-work，不把它们的内容铺开", () => {
    file(".git/config");
    file("node_modules/pkg/index.js");
    file(".grande-work/worktrees/x/a.ts");
    file("src/a.ts");
    const paths = repoMap(root).entries.map((e) => e.path);
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".grande-work"))).toBe(false);
    expect(paths).toContain("src/a.ts");
  });

  it("顺序确定且是全局字典序：同一棵树跑两次结果逐字节相同", () => {
    // 目录遍历顺序不是保证的（readdir 依赖文件系统），不显式排序就会出现「同样的仓库
    // 两次调用给模型看到不同顺序」——在长会话里这是隐蔽的困惑源。
    // 注意 src.ts：只在 src/ 一个目录里放文件的话，DFS 顺序碰巧就等于全局字典序，
    // 去掉 all.sort() 这条测试也不会变红，承重性验证就是空转。
    for (const n of ["z.ts", "a.ts", "m.ts", "B.ts"]) file(`src/${n}`);
    file("src.ts");
    const a = repoMap(root).entries.map((e) => e.path);
    const b = repoMap(root).entries.map((e) => e.path);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });

  it("识别关键文件：package.json、测试目录、入口", () => {
    file("package.json", '{"name":"x"}');
    file("src/index.ts");
    file("tests/a.test.ts");
    file("src/noise.ts");
    const r = repoMap(root);
    expect(r.keyFiles).toContain("package.json");
    expect(r.keyFiles).toContain("src/index.ts");
    expect(r.keyFiles).toContain("tests");
    expect(r.keyFiles).not.toContain("src/noise.ts");
  });

  it("超过 maxEntries 时截断并给出 nextCursor，用它能取到剩下的且不重不漏", () => {
    for (let i = 0; i < 10; i++) file(`src/f${String(i).padStart(2, "0")}.ts`);
    const first = repoMap(root, { maxEntries: 4 });
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.entries).toHaveLength(4);

    const second = repoMap(root, { maxEntries: 100, cursor: first.nextCursor });
    expect(second.truncated).toBe(false);
    // 不重
    const overlap = second.entries.filter((e) => first.entries.some((f) => f.path === e.path));
    expect(overlap).toEqual([]);
    // 不漏
    const all = repoMap(root, { maxEntries: 1000 });
    expect([...first.entries, ...second.entries].map((e) => e.path)).toEqual(all.entries.map((e) => e.path));
  });

  it("翻页时不重复给 keyFiles：只在 cursor 缺省的首页给出", () => {
    // keyFiles 描述的是整棵树，与「这一页有哪些条目」无关；翻页时重复发送同一份
    // 数据纯粹浪费 ChatGPT 那个会静默截断的响应预算。
    file("package.json", '{"name":"x"}');
    for (let i = 0; i < 5; i++) file(`src/f${i}.ts`);
    const first = repoMap(root, { maxEntries: 2 });
    expect(first.truncated).toBe(true);
    expect(first.keyFiles).toContain("package.json");
    const second = repoMap(root, { maxEntries: 2, cursor: first.nextCursor });
    expect(second.keyFiles).toEqual([]);
  });

  it("字段声明顺序：truncated/nextCursor 必须排在 entries 之前", () => {
    file("a.ts");
    const keys = Object.keys(repoMap(root));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("entries"));
    expect(keys.indexOf("nextCursor")).toBeLessThan(keys.indexOf("entries"));
  });

  it("文件给出字节数，目录为 null", () => {
    file("a.ts", "hello");
    const r = repoMap(root);
    expect(r.entries.find((e) => e.path === "a.ts")?.bytes).toBe(5);
    file("d/b.ts");
    expect(repoMap(root).entries.find((e) => e.path === "d")?.bytes).toBeNull();
  });
});
