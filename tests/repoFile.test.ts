import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DenyRules } from "../src/policy.ts";
import { repoEdit, repoRead, type EditOp } from "../src/repoFile.ts";

let root: string;
const RULES: DenyRules = { prefixes: [".git/"] };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
function file(rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rf-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("repoRead()", () => {
  it("返回内容、字节数、行数与 sha256，且 sha256 与内容真实对应", () => {
    file("a.ts", "hello\nworld\n");
    const r = repoRead(root, "a.ts");
    expect(r.content).toBe("hello\nworld\n");
    expect(r.bytes).toBe(12);
    expect(r.totalLines).toBe(3); // 末尾换行产生一个空行
    expect(r.sha256).toBe(sha("hello\nworld\n"));
    expect(r.truncated).toBe(false);
  });

  it("超过 maxBytes 时截断并标记，但 sha256 仍是【完整文件】的哈希", () => {
    // 这一条是设计要点：sha256 用于 staleness 校验，必须代表磁盘上的完整文件。
    // 若返回截断内容的哈希，模型拿它回来改文件会永远对不上。
    const big = "x".repeat(200);
    file("big.ts", big);
    const r = repoRead(root, "big.ts", { maxBytes: 50 });
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(50);
    expect(r.sha256).toBe(sha(big));
  });

  it("lineRange 取指定行区间（1 基、闭区间）", () => {
    file("a.ts", "l1\nl2\nl3\nl4\nl5\n");
    const r = repoRead(root, "a.ts", { lineRange: [2, 4] });
    expect(r.content).toBe("l2\nl3\nl4");
    expect(r.sha256).toBe(sha("l1\nl2\nl3\nl4\nl5\n"));
  });

  it("lineRange 覆盖到文件真实末尾（含末尾换行）时不误标 truncated", () => {
    // full.split("\n") 对以换行结尾的文件会多出一个幻影空行；lineRange 取到「真实
    // 最后一行」时，若拿幻影行的下标去比较，会把「已经给了整份文件」误判成截断。
    file("a.ts", "l1\nl2\nl3\n");
    const r = repoRead(root, "a.ts", { lineRange: [1, 3] });
    expect(r.content).toBe("l1\nl2\nl3");
    expect(r.truncated).toBe(false);
  });

  it("文件不存在时抛带码的错误", () => {
    expect(() => repoRead(root, "nope.ts")).toThrow(expect.objectContaining({ code: "FILE_NOT_FOUND" }));
  });

  it("路径逃逸被 resolveInRepo 挡住", () => {
    expect(() => repoRead(root, "../outside.ts")).toThrow(expect.objectContaining({ code: "PATH_ESCAPE" }));
  });

  it("拒绝读取二进制文件（含 NUL 字节）：不产出可被 repoEdit 复用的 sha256", () => {
    // 直接按 utf8 解码二进制内容会产出 U+FFFD 乱码；若照旧返回一个 sha256，
    // repoEdit 的 staleness 校验会「对上」这个乱码的哈希，modify 就能用文本内容
    // 覆盖掉二进制文件——这一步在 S0（无 Checkpoint）不可逆。
    const p = join(root, "img.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
    expect(() => repoRead(root, "img.png")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("拒绝读取超过 8MB 的文件，不整份读入内存", () => {
    const p = join(root, "huge.txt");
    writeFileSync(p, Buffer.alloc(8 * 1024 * 1024 + 1, "a"));
    expect(() => repoRead(root, "huge.txt")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("字段声明顺序：truncated 必须排在 content 之前", () => {
    file("a.ts", "x");
    const keys = Object.keys(repoRead(root, "a.ts"));
    expect(keys.indexOf("truncated")).toBeLessThan(keys.indexOf("content"));
  });
});

describe("repoEdit()", () => {
  it("create 新建文件并返回新 sha256", () => {
    const r = repoEdit(root, [{ op: "create", path: "src/new.ts", content: "hi" }], RULES);
    expect(read("src/new.ts")).toBe("hi");
    expect(r.applied[0]!.sha256).toBe(sha("hi"));
  });

  it("create 不覆盖已存在的文件", () => {
    file("a.ts", "original");
    expect(() => repoEdit(root, [{ op: "create", path: "a.ts", content: "new" }], RULES)).toThrow(
      expect.objectContaining({ code: "FILE_EXISTS" }),
    );
    expect(read("a.ts")).toBe("original");
  });

  it("modify 在 expectedSha256 匹配时写入", () => {
    file("a.ts", "v1");
    repoEdit(root, [{ op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("v1") }], RULES);
    expect(read("a.ts")).toBe("v2");
  });

  it("modify 在 expectedSha256 不匹配时抛 STALE_FILE 且不写入", () => {
    file("a.ts", "v1");
    expect(() =>
      repoEdit(root, [{ op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("WRONG") }], RULES),
    ).toThrow(expect.objectContaining({ code: "STALE_FILE" }));
    expect(read("a.ts")).toBe("v1");
  });

  it("move 移动文件，源消失目标出现", () => {
    file("a.ts", "content");
    repoEdit(root, [{ op: "move", from: "a.ts", to: "src/b.ts" }], RULES);
    expect(existsSync(join(root, "a.ts"))).toBe(false);
    expect(read("src/b.ts")).toBe("content");
  });

  it("命中拒绝表的路径被拒，且【两个方向】都查：move 的 from 与 to", () => {
    file("a.ts", "x");
    expect(() => repoEdit(root, [{ op: "create", path: ".git/hooks/pre-commit", content: "#!/bin/sh" }], RULES))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() => repoEdit(root, [{ op: "move", from: "a.ts", to: ".git/x" }], RULES))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    file(".git/config", "x");
    expect(() => repoEdit(root, [{ op: "move", from: ".git/config", to: "leaked.txt" }], RULES))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("拒绝表用【解析后】的路径判定：仓内符号链接不能绕过 AC-14", () => {
    // resolveInRepo 的契约只有「解析后仍在仓库之内」，vendor -> .git 完全满足这一条。
    // 用模型给的原始字符串判拒绝表，这一条就直接写穿到 .git/hooks/pre-commit。
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    symlinkSync(join(root, ".git"), join(root, "vendor"));
    expect(() =>
      repoEdit(root, [{ op: "create", path: "vendor/hooks/pre-commit", content: "#!/bin/sh\n" }], RULES),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("拒绝表大小写不敏感：macOS APFS 上 .GIT/ 就是 .git/", () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    expect(() =>
      repoEdit(root, [{ op: "create", path: ".GIT/hooks/pre-commit", content: "#!/bin/sh\n" }], RULES),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("内置拒绝项不可由调用方参数放宽（铁律三：硬门禁不接受调用方自觉）", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(() =>
      repoEdit(root, [{ op: "create", path: ".git/config", content: "x" }], { prefixes: [] }),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("同一批里对同一路径的不同写法也被拒（./x.ts 与 x.ts 是同一个文件）", () => {
    expect(() =>
      repoEdit(
        root,
        [
          { op: "create", path: "x.ts", content: "a" },
          { op: "create", path: "./x.ts", content: "b" },
        ],
        RULES,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(existsSync(join(root, "x.ts"))).toBe(false);
  });

  it("先全量校验再落盘：一批里有一个非法 op，则【整批都不写】", () => {
    // 这是本任务最重要的性质。S0 没有事务性 patch（留 S1），但「校验全部通过才开始写」
    // 是免费的，而且它决定了失败时仓库处于可理解的状态而不是改了一半。
    file("a.ts", "v1");
    expect(() =>
      repoEdit(
        root,
        [
          { op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("v1") }, // 合法
          { op: "create", path: ".git/evil", content: "x" },                        // 非法
        ],
        RULES,
      ),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(read("a.ts")).toBe("v1"); // 第一个合法 op 也没有被应用
  });

  it("同一批里对同一路径重复操作被拒（顺序依赖会让 sha256 契约失效）", () => {
    expect(() =>
      repoEdit(
        root,
        [
          { op: "create", path: "x.ts", content: "a" },
          { op: "create", path: "x.ts", content: "b" },
        ],
        RULES,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("空 ops 数组被拒，而不是静默成功", () => {
    expect(() => repoEdit(root, [], RULES)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("不提供删除能力：运行时拒绝任何未知 op，包括 delete（规格 §5.3）", () => {
    // 规格 §5.3：S0 没有 Checkpoint，删除不可撤销。若支持删除就必须标
    // destructiveHint: true，导致每次弹框且无法「记住」。
    // 类型层挡不住 S0-D 那边解出来的 JSON —— 所以运行时也要挡。
    file("a.ts", "v1");
    expect(() =>
      repoEdit(root, [{ op: "delete", path: "a.ts" } as unknown as EditOp], RULES),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(read("a.ts")).toBe("v1");
  });
});
