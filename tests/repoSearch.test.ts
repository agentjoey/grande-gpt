import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoSearch } from "../src/repoSearch.ts";

let root: string;
function file(rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "srch-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repoSearch()", () => {
  it("找到字面量匹配，带行号与上下文", () => {
    file("src/a.ts", "line1\nline2\nNEEDLE here\nline4\nline5\n");
    const r = repoSearch(root, "NEEDLE");
    expect(r.matches).toHaveLength(1);
    const m = r.matches[0]!;
    expect(m.path).toBe("src/a.ts");
    expect(m.line).toBe(3);
    expect(m.text).toBe("NEEDLE here");
    expect(m.before).toEqual(["line2"]);
    expect(m.after).toEqual(["line4"]);
  });

  it("pattern 恒按字面量处理，特殊字符不被当成正则元字符；调用方传 regex 选项直接拒绝", () => {
    // S0 不支持调用方提供的正则：进程内跑调用方给的正则是无界 CPU 逃生舱
    // （见 repoSearch 顶部 JSDoc 的实测数据），违反铁律二。
    file("src/a.ts", "a.b\naxb\n");
    expect(repoSearch(root, "a.b").matches.map((m) => m.text)).toEqual(["a.b"]);
    expect(() =>
      repoSearch(root, "a.b", { regex: true } as unknown as Parameters<typeof repoSearch>[2]),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("跳过 .git、node_modules 与二进制文件", () => {
    file(".git/config", "NEEDLE\n");
    file("node_modules/p/i.js", "NEEDLE\n");
    file("bin.dat", "NEEDLE\0binary\n");
    file("src/ok.ts", "NEEDLE\n");
    const paths = repoSearch(root, "NEEDLE").matches.map((m) => m.path);
    expect(paths).toEqual(["src/ok.ts"]);
  });

  it("超过 maxMatches 时截断并给 nextCursor，续取不重不漏", () => {
    for (let i = 0; i < 10; i++) file(`src/f${String(i).padStart(2, "0")}.ts`, "NEEDLE\n");
    const first = repoSearch(root, "NEEDLE", { maxMatches: 4 });
    expect(first.truncated).toBe(true);
    expect(first.matches).toHaveLength(4);
    const second = repoSearch(root, "NEEDLE", { maxMatches: 100, cursor: first.nextCursor });
    expect(second.truncated).toBe(false);
    const allPaths = [...first.matches, ...second.matches].map((m) => m.path);
    expect(new Set(allPaths).size).toBe(10);
  });

  it("顺序确定且是全局字典序（跨目录也成立）", () => {
    // 只在一个目录里放文件的话，DFS 顺序碰巧等于全局字典序，这条断言就抓不到东西。
    // src/ 与 src.ts 才是分水岭："." (0x2E) < "/" (0x2F)。
    for (const n of ["z.ts", "a.ts", "m.ts"]) file(`src/${n}`, "NEEDLE\n");
    file("src.ts", "NEEDLE\n");
    const a = repoSearch(root, "NEEDLE").matches.map((m) => m.path);
    expect(a).toEqual(repoSearch(root, "NEEDLE").matches.map((m) => m.path));
    expect(a).toEqual([...a].sort());
  });

  it("时间预算到点即返回，标记 timedOut，且【已找到的结果不丢】、仍可续取", () => {
    // budgetMs=0 保证第一次检查就超预算。关键断言是 timedOut 为 true 而不是抛错——
    // 撞上 ChatGPT 那个不可配置的 ~60s 超时的后果，比返回部分结果糟糕得多。
    for (let i = 0; i < 50; i++) file(`src/f${String(i).padStart(2, "0")}.ts`, "NEEDLE\n");
    const r = repoSearch(root, "NEEDLE", { budgetMs: 0 });
    expect(r.timedOut).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.matches).toHaveLength(1); // 已找到的不丢
    expect(r.matches[0]!.path).toBe("src/f00.ts");
    expect(r.nextCursor).toBe("1"); // 可续取

    const rest = repoSearch(root, "NEEDLE", { cursor: r.nextCursor, maxMatches: 100 });
    expect(rest.matches.map((m) => m.path)).not.toContain("src/f00.ts");
  });

  it("超过大小上限的文件被跳过，但计数体现在 skippedOversized 里而不是静默消失", () => {
    file("src/ok.ts", "NEEDLE\n");
    file("src/huge.ts", `NEEDLE\n${"x".repeat(2 * 1024 * 1024)}`);
    const r = repoSearch(root, "NEEDLE");
    expect(r.matches.map((m) => m.path)).toEqual(["src/ok.ts"]);
    expect(r.skippedOversized).toBe(1);
  });

  it("字段声明顺序：truncated/nextCursor/timedOut/skippedOversized 必须排在 matches 之前", () => {
    file("a.ts", "NEEDLE\n");
    const keys = Object.keys(repoSearch(root, "NEEDLE"));
    for (const k of ["truncated", "nextCursor", "timedOut", "skippedOversized"]) {
      expect(keys.indexOf(k)).toBeLessThan(keys.indexOf("matches"));
    }
  });
});
