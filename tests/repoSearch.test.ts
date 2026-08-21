import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("跳过指向仓库外的符号链接，不跟随、不搜索链接目标里的内容（C2）", () => {
    const outside = mkdtempSync(join(tmpdir(), "srch-outside-"));
    try {
      writeFileSync(join(outside, "id_rsa"), "PRIVATE-KEY-MATERIAL-NEEDLE", "utf8");
      symlinkSync(outside, join(root, "vendor"));
      const r = repoSearch(root, "NEEDLE");
      expect(r.matches).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("跳过给 .git 起别名的符号链接，即使目录名不叫 .git（C2）：SKIP_DIRS 只按名字过滤，" +
     "一个叫别的名字的链接会绕过它，除非改成不跟随符号链接", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(
      join(root, ".git", "config"),
      "url = https://x-token:ghp_SECRETTOKEN@example.com/a/b.git\n",
      "utf8",
    );
    symlinkSync(join(root, ".git"), join(root, "gitalias"));
    const r = repoSearch(root, "ghp_");
    expect(r.matches).toEqual([]);
  });

  it("普通文件不受符号链接修复影响，仍然正常被搜索到（不过度拒绝）", () => {
    file("src/ok.ts", "NEEDLE\n");
    const r = repoSearch(root, "NEEDLE");
    expect(r.matches.map((m) => m.path)).toEqual(["src/ok.ts"]);
  });

  it("步骤三复核：指向仓库内一个普通文件的合法符号链接被跳过（不报错、不崩溃）——" +
     "这是本次选择的 skip-symlinks 策略的自然代价，不是过度拒绝的 bug", () => {
    file("real.ts", "NEEDLE\n");
    symlinkSync(join(root, "real.ts"), join(root, "alias.ts"));
    const r = repoSearch(root, "NEEDLE");
    expect(r.matches.map((m) => m.path)).toEqual(["real.ts"]); // 只有真实文件命中一次，链接不重复命中
  });

  it("超过 maxMatches 时截断并给 nextCursor，续取不重不漏", () => {
    for (let i = 0; i < 10; i++) file(`src/f${String(i).padStart(2, "0")}.ts`, "NEEDLE\n");
    const first = repoSearch(root, "NEEDLE", { maxMatches: 4 });
    expect(first.truncated).toBe(true);
    expect(first.matches).toHaveLength(4);
    const second = repoSearch(root, "NEEDLE", { maxMatches: 25, cursor: first.nextCursor });
    expect(second.truncated).toBe(false);
    const allPaths = [...first.matches, ...second.matches].map((m) => m.path);
    expect(new Set(allPaths).size).toBe(10);
  });

  it("默认返回 20 条，显式硬上限 25 条可用，游标按实际返回数稳定推进", () => {
    for (let i = 0; i < 30; i++) file(`src/f${String(i).padStart(2, "0")}.ts`, "NEEDLE\n");

    const defaultPage = repoSearch(root, "NEEDLE");
    expect(defaultPage.matches).toHaveLength(20);
    expect(defaultPage.truncated).toBe(true);
    expect(defaultPage.nextCursor).toBe("20");

    const maxPage = repoSearch(root, "NEEDLE", { maxMatches: 25 });
    expect(maxPage.matches).toHaveLength(25);
    expect(maxPage.truncated).toBe(true);
    expect(maxPage.nextCursor).toBe("25");
  });

  it.each([0, -1, 1.5, 26, Number.NaN])(
    "maxMatches=%s 不是 1..25 内的正整数时返回 INVALID_INPUT，而不是钳制",
    (maxMatches) => {
      file("src/a.ts", "NEEDLE\n");
      expect(() => repoSearch(root, "NEEDLE", { maxMatches }))
        .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    },
  );

  it("按实际序列化后的 SearchResult 强制 16 KiB 上限，移除尾部匹配后游标只推进已返回数", () => {
    for (let i = 0; i < 8; i++) {
      file(
        `src/large-${i}.ts`,
        `before-${i}\nNEEDLE-${i}-${"界".repeat(1_600)}\nafter-${i}\n`,
      );
    }

    const first = repoSearch(root, "NEEDLE", { maxMatches: 25 });
    const firstBytes = Buffer.byteLength(JSON.stringify(first), "utf8");

    expect(firstBytes).toBeLessThanOrEqual(16 * 1024);
    expect(first.matches.length).toBeGreaterThan(0);
    expect(first.matches.length).toBeLessThan(8);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe(String(first.matches.length));

    const second = repoSearch(root, "NEEDLE", {
      maxMatches: 25,
      cursor: first.nextCursor,
    });
    expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(second.matches[0]!.path).toBe(`src/large-${first.matches.length}.ts`);
  });

  it("单个匹配本身超过 16 KiB 时返回有损标记的有界表示，游标不会停在空页原地循环", () => {
    const sourceLine = `NEEDLE-${"界".repeat(20_000)}`;
    file("src/one-huge-match.ts", `${sourceLine}\n`);

    const result = repoSearch(root, "NEEDLE");

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.path).toBe("src/one-huge-match.ts");
    expect(result.matches[0]!.text).toContain("NEEDLE");
    expect(result.matches[0]!.text).not.toBe(sourceLine);
    expect(result.matches[0]!.contentTruncated).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeNull();
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

  it("时间预算到点后用版本化游标从下一文件继续，连续页面有进展且不重不漏", () => {
    // budgetMs=0 保证第一次检查就超预算。关键断言是 timedOut 为 true 而不是抛错——
    // 撞上 ChatGPT 那个不可配置的 ~60s 超时的后果，比返回部分结果糟糕得多。
    for (let i = 0; i < 50; i++) file(`src/f${String(i).padStart(2, "0")}.ts`, "NEEDLE\n");
    const first = repoSearch(root, "NEEDLE", { budgetMs: 0 });
    const second = repoSearch(root, "NEEDLE", { budgetMs: 0, cursor: first.nextCursor });
    const third = repoSearch(root, "NEEDLE", { budgetMs: 0, cursor: second.nextCursor });

    for (const page of [first, second, third]) {
      expect(page.timedOut).toBe(true);
      expect(page.truncated).toBe(true);
      expect(page.matches).toHaveLength(1);
    }
    expect([first, second, third].flatMap((page) => page.matches.map((m) => m.path)))
      .toEqual(["src/f00.ts", "src/f01.ts", "src/f02.ts"]);
    expect(first.nextCursor).toMatch(/^v1:/);
    expect(new Set([first.nextCursor, second.nextCursor, third.nextCursor]).size).toBe(3);
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
