import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { getAudit, beginAudit, type AuditHandle } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import type { Layout } from "../src/layout.ts";
import type { DenyRules } from "../src/policy.ts";
import { repoEdit, repoRead, type EditOp } from "../src/repoFile.ts";
import { allowedHandle } from "./_audit.ts";

let root: string;
let db: ReturnType<typeof openDb>;
const RULES: DenyRules = { prefixes: [".git/"] };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
// I1：原始字节的哈希——用于「即使 sha256 恰好算对了，二进制守卫也必须独立拒绝」
// 这类测试，故意不经过任何字符串解码（跟 repoRead/repoEdit 内部 sha256OfBuffer
// 的算法保持一致）。
const sha256 = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
function file(rel: string, content: string) {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rf-"));
  db = openDb({ stateDb: ":memory:" } as Layout);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

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

  it("拒绝读取非法 UTF-8 但不含 NUL 的文件（如 Latin-1 编码，I1：纯 NUL 检查漏掉了这类编码）", () => {
    // 0xE9 0xE8：Latin-1 下是两个普通高位字符，但不是合法 UTF-8（0xE9 是 3 字节
    // 序列引导字节，要求两个 0x80-0xBF 的延续字节，0xE8 不满足）。没有 NUL。
    const raw = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9, 0xe8, 0x0a]);
    writeFileSync(join(root, "latin1.txt"), raw);
    expect(() => repoRead(root, "latin1.txt")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
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
    const r = repoEdit(root, [{ op: "create", path: "src/new.ts", content: "hi" }], RULES, allowedHandle(db, "grande_repo_edit"));
    expect(read("src/new.ts")).toBe("hi");
    expect(r.applied[0]!.sha256).toBe(sha("hi"));
  });

  it("create 不覆盖已存在的文件", () => {
    file("a.ts", "original");
    expect(() => repoEdit(root, [{ op: "create", path: "a.ts", content: "new" }], RULES, allowedHandle(db, "grande_repo_edit"))).toThrow(
      expect.objectContaining({ code: "FILE_EXISTS" }),
    );
    expect(read("a.ts")).toBe("original");
  });

  it("modify 在 expectedSha256 匹配时写入", () => {
    file("a.ts", "v1");
    repoEdit(root, [{ op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("v1") }], RULES, allowedHandle(db, "grande_repo_edit"));
    expect(read("a.ts")).toBe("v2");
  });

  it("modify 在 expectedSha256 不匹配时抛 STALE_FILE 且不写入", () => {
    file("a.ts", "v1");
    expect(() =>
      repoEdit(root, [{ op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("WRONG") }], RULES, allowedHandle(db, "grande_repo_edit")),
    ).toThrow(expect.objectContaining({ code: "STALE_FILE" }));
    expect(read("a.ts")).toBe("v1");
  });

  it("modify 拒绝二进制文件（Latin-1，非法 UTF-8，无 NUL）：即使提供的 sha256 恰好对得上，" +
     "也不放行——这不是 staleness 校验能不能过的问题（I1）", () => {
    const raw = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9, 0xe8, 0x0a]); // "Hello éè\n"（Latin-1）
    writeFileSync(join(root, "latin1.txt"), raw);
    const expectedSha256 = sha256(raw); // 对原始字节算出的、真正「正确」的哈希
    expect(() =>
      repoEdit(root, [{ op: "modify", path: "latin1.txt", content: "REPLACED\n", expectedSha256 }], RULES, allowedHandle(db, "grande_repo_edit")),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(readFileSync(join(root, "latin1.txt"))).toEqual(raw); // 原始字节完好无损
  });

  it("modify 拒绝含 NUL 字节的文件，即使提供的 sha256 恰好对得上（I1：repoRead 会拒绝读它，" +
     "modify 此前完全没有独立的二进制守卫，只要哈希对得上就会用文本内容整份覆盖）", () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]); // PNG 魔数，含 NUL
    writeFileSync(join(root, "img.png"), raw);
    const expectedSha256 = sha256(raw);
    expect(() =>
      repoEdit(root, [{ op: "modify", path: "img.png", content: "REPLACED\n", expectedSha256 }], RULES, allowedHandle(db, "grande_repo_edit")),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(readFileSync(join(root, "img.png"))).toEqual(raw);
  });

  it("move 移动文件，源消失目标出现", () => {
    file("a.ts", "content");
    repoEdit(root, [{ op: "move", from: "a.ts", to: "src/b.ts" }], RULES, allowedHandle(db, "grande_repo_edit"));
    expect(existsSync(join(root, "a.ts"))).toBe(false);
    expect(read("src/b.ts")).toBe("content");
  });

  it("命中拒绝表的路径被拒，且【两个方向】都查：move 的 from 与 to", () => {
    file("a.ts", "x");
    expect(() => repoEdit(root, [{ op: "create", path: ".git/hooks/pre-commit", content: "#!/bin/sh" }], RULES, allowedHandle(db, "grande_repo_edit")))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() => repoEdit(root, [{ op: "move", from: "a.ts", to: ".git/x" }], RULES, allowedHandle(db, "grande_repo_edit")))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    file(".git/config", "x");
    expect(() => repoEdit(root, [{ op: "move", from: ".git/config", to: "leaked.txt" }], RULES, allowedHandle(db, "grande_repo_edit")))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("拒绝表用【解析后】的路径判定：仓内符号链接不能绕过 AC-14", () => {
    // resolveInRepo 的契约只有「解析后仍在仓库之内」，vendor -> .git 完全满足这一条。
    // 用模型给的原始字符串判拒绝表，这一条就直接写穿到 .git/hooks/pre-commit。
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    symlinkSync(join(root, ".git"), join(root, "vendor"));
    expect(() =>
      repoEdit(root, [{ op: "create", path: "vendor/hooks/pre-commit", content: "#!/bin/sh\n" }], RULES, allowedHandle(db, "grande_repo_edit")),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("拒绝表大小写不敏感：macOS APFS 上 .GIT/ 就是 .git/", () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    expect(() =>
      repoEdit(root, [{ op: "create", path: ".GIT/hooks/pre-commit", content: "#!/bin/sh\n" }], RULES, allowedHandle(db, "grande_repo_edit")),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("内置拒绝项不可由调用方参数放宽（铁律三：硬门禁不接受调用方自觉）", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(() =>
      repoEdit(root, [{ op: "create", path: ".git/config", content: "x" }], { prefixes: [] }, allowedHandle(db, "grande_repo_edit")),
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
        RULES, allowedHandle(db, "grande_repo_edit"),
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
        RULES, allowedHandle(db, "grande_repo_edit"),
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
        RULES, allowedHandle(db, "grande_repo_edit"),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("空 ops 数组被拒，而不是静默成功", () => {
    expect(() => repoEdit(root, [], RULES, allowedHandle(db, "grande_repo_edit"))).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("不提供删除能力：运行时拒绝任何未知 op，包括 delete（规格 §5.3）", () => {
    // 规格 §5.3：S0 没有 Checkpoint，删除不可撤销。若支持删除就必须标
    // destructiveHint: true，导致每次弹框且无法「记住」。
    // 类型层挡不住 S0-D 那边解出来的 JSON —— 所以运行时也要挡。
    file("a.ts", "v1");
    expect(() =>
      repoEdit(root, [{ op: "delete", path: "a.ts" } as unknown as EditOp], RULES, allowedHandle(db, "grande_repo_edit")),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(read("a.ts")).toBe("v1");
  });

  it("repoEdit 在写盘【之前】把句柄推进到 EXECUTING", () => {
    const target = join(root, "a.ts");
    const handle = allowedHandle(db, "grande_repo_edit");
    let fileExistedAtAdvance: boolean | null = null;
    const spy: AuditHandle = { ...handle, executing: () => {
      fileExistedAtAdvance = existsSync(target);
      return handle.executing();
    } };
    repoEdit(root, [{ op: "create", path: "a.ts", content: "x" }], RULES, spy);
    expect(fileExistedAtAdvance).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(getAudit(db, handle.opId)!.state).toBe("SUCCEEDED");
  });

  it("句柄推进失败时【不写盘】", () => {
    const h = beginAudit(db, { taskId: null, tool: "grande_repo_edit", input: {} });
    // 故意不调用 allowed()，executing() 因此返回 false
    expect(() => repoEdit(root, [{ op: "create", path: "a.ts", content: "x" }], RULES, h))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, "a.ts"))).toBe(false);
  });

  it("失败时句柄落到 FAILED 且带 reason", () => {
    mkdirSync(join(root, "locked"), { recursive: true });
    chmodSync(join(root, "locked"), 0o500); // r-x：目录可进入不可写
    const h = allowedHandle(db, "grande_repo_edit");
    try {
      expect(() =>
        repoEdit(root, [{ op: "create", path: "locked/a.ts", content: "x" }], RULES, h),
      ).toThrow();
    } finally {
      chmodSync(join(root, "locked"), 0o700); // afterEach 的 rmSync 需要能删掉它
    }
    const row = getAudit(db, h.opId)!;
    expect(row.state).toBe("FAILED");
    expect(row.reason).toBeTruthy();
  });

  it("repoEdit 的形参数量仍是 4（tsc 才是真正拦住漏传 audit 的那道关卡）", () => {
    expect(repoEdit.length).toBe(4);
  });
});
