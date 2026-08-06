import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAudit, beginAudit, type AuditHandle } from "../src/audit.ts";
import { restoreCheckpoint } from "../src/checkpoint.ts";
import { openDb } from "../src/db.ts";
import { loadLayout, type Layout } from "../src/layout.ts";
import type { DenyRules } from "../src/policy.ts";
import { repoEdit, repoRead, type EditOp } from "../src/repoFile.ts";
import { buildTools } from "../src/tools.ts";
import { allowedHandle } from "./_audit.ts";

let root: string;
let testRoot: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
let previousWorkspace: string | undefined;
let previousControl: string | undefined;
const TASK_ID = "task-1";
const RULES: DenyRules = { prefixes: [".git/"] };

// 遗留 #6/#7：repoEdit 的控制平面上下文现在是【显式实参】。
// 此前它自己 loadLayout() 并 basename(root) 取 taskId——后者是一条签名上
// 看不见的前置条件（「root 的最后一段必须是合法 taskId」），编译器不会提醒
// 任何想复用这个函数的人。这里的 layout 由 beforeEach 赋值，取值时才读。
const CTX = { get layout() { return layout; }, taskId: TASK_ID };

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
  testRoot = mkdtempSync(join(tmpdir(), "rf-"));
  const workspaceRoot = join(testRoot, "workspace");
  const controlRoot = join(testRoot, "control");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  previousWorkspace = process.env.GRANDE_WORKSPACE;
  previousControl = process.env.GRANDE_CONTROL;
  process.env.GRANDE_WORKSPACE = workspaceRoot;
  process.env.GRANDE_CONTROL = controlRoot;
  layout = loadLayout();
  root = join(layout.worktreesRoot, "demo", TASK_ID);
  mkdirSync(root, { recursive: true });
  db = openDb({ stateDb: ":memory:" } as Layout);
});
afterEach(() => {
  db.close();
  if (previousWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = previousWorkspace;
  if (previousControl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = previousControl;
  rmSync(testRoot, { recursive: true, force: true });
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
    const r = repoEdit(root, [{ op: "create", path: "src/new.ts", content: "hi" }], RULES, allowedHandle(db, "grande_repo_edit"), CTX);
    expect(read("src/new.ts")).toBe("hi");
    expect(r.applied[0]!.sha256).toBe(sha("hi"));
  });

  it("create 不覆盖已存在的文件", () => {
    file("a.ts", "original");
    expect(() => repoEdit(root, [{ op: "create", path: "a.ts", content: "new" }], RULES, allowedHandle(db, "grande_repo_edit"), CTX)).toThrow(
      expect.objectContaining({ code: "FILE_EXISTS" }),
    );
    expect(read("a.ts")).toBe("original");
  });

  it("modify 在 expectedSha256 匹配时写入", () => {
    file("a.ts", "v1");
    repoEdit(root, [{ op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("v1") }], RULES, allowedHandle(db, "grande_repo_edit"), CTX);
    expect(read("a.ts")).toBe("v2");
  });

  it("modify 在 expectedSha256 不匹配时抛 STALE_FILE 且不写入", () => {
    file("a.ts", "v1");
    expect(() =>
      repoEdit(root, [{ op: "modify", path: "a.ts", content: "v2", expectedSha256: sha("WRONG") }], RULES, allowedHandle(db, "grande_repo_edit"), CTX),
    ).toThrow(expect.objectContaining({ code: "STALE_FILE" }));
    expect(read("a.ts")).toBe("v1");
  });

  it("modify 拒绝二进制文件（Latin-1，非法 UTF-8，无 NUL）：即使提供的 sha256 恰好对得上，" +
     "也不放行——这不是 staleness 校验能不能过的问题（I1）", () => {
    const raw = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9, 0xe8, 0x0a]); // "Hello éè\n"（Latin-1）
    writeFileSync(join(root, "latin1.txt"), raw);
    const expectedSha256 = sha256(raw); // 对原始字节算出的、真正「正确」的哈希
    expect(() =>
      repoEdit(root, [{ op: "modify", path: "latin1.txt", content: "REPLACED\n", expectedSha256 }], RULES, allowedHandle(db, "grande_repo_edit"), CTX),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(readFileSync(join(root, "latin1.txt"))).toEqual(raw); // 原始字节完好无损
  });

  it("modify 拒绝含 NUL 字节的文件，即使提供的 sha256 恰好对得上（I1：repoRead 会拒绝读它，" +
     "modify 此前完全没有独立的二进制守卫，只要哈希对得上就会用文本内容整份覆盖）", () => {
    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]); // PNG 魔数，含 NUL
    writeFileSync(join(root, "img.png"), raw);
    const expectedSha256 = sha256(raw);
    expect(() =>
      repoEdit(root, [{ op: "modify", path: "img.png", content: "REPLACED\n", expectedSha256 }], RULES, allowedHandle(db, "grande_repo_edit"), CTX),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(readFileSync(join(root, "img.png"))).toEqual(raw);
  });

  it("move 移动文件，源消失目标出现", () => {
    file("a.ts", "content");
    repoEdit(root, [{ op: "move", from: "a.ts", to: "src/b.ts" }], RULES, allowedHandle(db, "grande_repo_edit"), CTX);
    expect(existsSync(join(root, "a.ts"))).toBe(false);
    expect(read("src/b.ts")).toBe("content");
  });

  it("命中拒绝表的路径被拒，且【两个方向】都查：move 的 from 与 to", () => {
    file("a.ts", "x");
    expect(() => repoEdit(root, [{ op: "create", path: ".git/hooks/pre-commit", content: "#!/bin/sh" }], RULES, allowedHandle(db, "grande_repo_edit"), CTX))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() => repoEdit(root, [{ op: "move", from: "a.ts", to: ".git/x" }], RULES, allowedHandle(db, "grande_repo_edit"), CTX))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    file(".git/config", "x");
    expect(() => repoEdit(root, [{ op: "move", from: ".git/config", to: "leaked.txt" }], RULES, allowedHandle(db, "grande_repo_edit"), CTX))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
  });

  it("拒绝表用【解析后】的路径判定：仓内符号链接不能绕过 AC-14", () => {
    // resolveInRepo 的契约只有「解析后仍在仓库之内」，vendor -> .git 完全满足这一条。
    // 用模型给的原始字符串判拒绝表，这一条就直接写穿到 .git/hooks/pre-commit。
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    symlinkSync(join(root, ".git"), join(root, "vendor"));
    expect(() =>
      repoEdit(root, [{ op: "create", path: "vendor/hooks/pre-commit", content: "#!/bin/sh\n" }], RULES, allowedHandle(db, "grande_repo_edit"), CTX),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("拒绝表大小写不敏感：macOS APFS 上 .GIT/ 就是 .git/", () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    expect(() =>
      repoEdit(root, [{ op: "create", path: ".GIT/hooks/pre-commit", content: "#!/bin/sh\n" }], RULES, allowedHandle(db, "grande_repo_edit"), CTX),
    ).toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("内置拒绝项不可由调用方参数放宽（铁律三：硬门禁不接受调用方自觉）", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(() =>
      repoEdit(root, [{ op: "create", path: ".git/config", content: "x" }], { prefixes: [] }, allowedHandle(db, "grande_repo_edit"), CTX),
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
        RULES, allowedHandle(db, "grande_repo_edit"), CTX,
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
        RULES, allowedHandle(db, "grande_repo_edit"), CTX,
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
        RULES, allowedHandle(db, "grande_repo_edit"), CTX,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("空 ops 数组被拒，而不是静默成功", () => {
    expect(() => repoEdit(root, [], RULES, allowedHandle(db, "grande_repo_edit"), CTX)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("delete 把文件移进 Trash，worktree 中消失且副本内容逐字节相同", () => {
    file("delete-me.txt", "delete me\n");

    const result = repoEdit(
      root,
      [{ op: "delete", path: "delete-me.txt", expectedSha256: sha("delete me\n") }],
      RULES,
      allowedHandle(db, "grande_repo_edit"), CTX,
    );

    expect(existsSync(join(root, "delete-me.txt"))).toBe(false);
    expect(result.applied).toEqual([{ op: "delete", path: "delete-me.txt", sha256: null }]);
    const trashRoot = join(layout.controlRoot, "trash", TASK_ID);
    const batches = readdirSync(trashRoot);
    expect(batches).toHaveLength(1);
    expect(readFileSync(join(trashRoot, batches[0]!, "delete-me.txt"), "utf8")).toBe("delete me\n");
  });

  it("delete 缺少 expectedSha256 → INVALID_INPUT；哈希错误 → STALE_FILE；两次拒绝都无副作用", () => {
    file("safe.txt", "safe\n");
    const trashRoot = join(layout.controlRoot, "trash", TASK_ID);

    expect(() =>
      repoEdit(
        root,
        [{ op: "delete", path: "safe.txt" } as unknown as EditOp],
        RULES,
        allowedHandle(db, "grande_repo_edit"), CTX,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(read("safe.txt")).toBe("safe\n");
    expect(existsSync(trashRoot)).toBe(false);

    expect(() =>
      repoEdit(
        root,
        [{ op: "delete", path: "safe.txt", expectedSha256: sha("wrong\n") }],
        RULES,
        allowedHandle(db, "grande_repo_edit"), CTX,
      ),
    ).toThrow(expect.objectContaining({ code: "STALE_FILE" }));
    expect(read("safe.txt")).toBe("safe\n");
    expect(existsSync(trashRoot)).toBe(false);
  });

  it("delete 不存在的文件 → FILE_NOT_FOUND，且不创建 Trash 或 checkpoint 副作用", () => {
    expect(() =>
      repoEdit(
        root,
        [{ op: "delete", path: "missing.txt", expectedSha256: sha("missing") }],
        RULES,
        allowedHandle(db, "grande_repo_edit"), CTX,
      ),
    ).toThrow(expect.objectContaining({ code: "FILE_NOT_FOUND" }));
    expect(existsSync(join(root, "missing.txt"))).toBe(false);
    expect(existsSync(join(layout.controlRoot, "trash", TASK_ID))).toBe(false);
    expect(existsSync(join(layout.controlRoot, "checkpoints", TASK_ID))).toBe(false);
  });

  it("delete 可与 create/modify 混在同一批，三种操作全部落盘", () => {
    file("modify.txt", "before\n");
    file("delete.txt", "gone\n");

    const result = repoEdit(
      root,
      [
        { op: "create", path: "created.txt", content: "created\n" },
        { op: "modify", path: "modify.txt", content: "after\n", expectedSha256: sha("before\n") },
        { op: "delete", path: "delete.txt", expectedSha256: sha("gone\n") },
      ],
      RULES,
      allowedHandle(db, "grande_repo_edit"), CTX,
    );

    expect(read("created.txt")).toBe("created\n");
    expect(read("modify.txt")).toBe("after\n");
    expect(existsSync(join(root, "delete.txt"))).toBe(false);
    expect(result.applied.map((a) => a.op)).toEqual(["create", "modify", "delete"]);
  });

  it("写阶段第 2 个 op 失败时自动回滚整批，并保留原始 I/O 错误", () => {
    file("a.ts", "a1");
    file("b.ts", "b1");
    file("c.ts", "c1");
    file("blocked", "not a directory");

    let thrown: unknown;
    try {
      repoEdit(
        root,
        [
          { op: "modify", path: "a.ts", content: "a2", expectedSha256: sha("a1") },
          { op: "move", from: "b.ts", to: "blocked/b.ts" },
          { op: "modify", path: "c.ts", content: "c2", expectedSha256: sha("c1") },
        ],
        RULES,
        allowedHandle(db, "grande_repo_edit"), CTX,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "EEXIST" });
    expect(read("a.ts")).toBe("a1");
    expect(read("b.ts")).toBe("b1");
    expect(read("c.ts")).toBe("c1");
    expect(read("blocked")).toBe("not a directory");
    expect(existsSync(join(root, "blocked", "b.ts"))).toBe(false);
  });

  it("全部成功时返回 checkpointId，且 move 的 from/to 都能用它完整回滚", () => {
    file("a.ts", "content");

    const result = repoEdit(
      root,
      [{ op: "move", from: "a.ts", to: "src/b.ts" }],
      RULES,
      allowedHandle(db, "grande_repo_edit"), CTX,
    );

    expect(result.checkpointId).toEqual(expect.any(String));
    expect(result.checkpointId.length).toBeGreaterThan(0);
    expect(existsSync(join(root, "a.ts"))).toBe(false);
    expect(read("src/b.ts")).toBe("content");

    expect(restoreCheckpoint(layout, TASK_ID, root, result.checkpointId)).toEqual(["a.ts", "src/b.ts"]);
    expect(read("a.ts")).toBe("content");
    expect(existsSync(join(root, "src", "b.ts"))).toBe(false);
  });

  it("repoEdit 在写盘【之前】把句柄推进到 EXECUTING", () => {
    const target = join(root, "a.ts");
    const handle = allowedHandle(db, "grande_repo_edit");
    let fileExistedAtAdvance: boolean | null = null;
    const spy: AuditHandle = { ...handle, executing: () => {
      fileExistedAtAdvance = existsSync(target);
      return handle.executing();
    } };
    repoEdit(root, [{ op: "create", path: "a.ts", content: "x" }], RULES, spy, CTX);
    expect(fileExistedAtAdvance).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(getAudit(db, handle.opId)!.state).toBe("SUCCEEDED");
  });

  it("句柄推进失败时【不写盘】", () => {
    const h = beginAudit(db, { taskId: null, tool: "grande_repo_edit", input: {} });
    // 故意不调用 allowed()，executing() 因此返回 false
    expect(() => repoEdit(root, [{ op: "create", path: "a.ts", content: "x" }], RULES, h, CTX))
      .toThrow(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(existsSync(join(root, "a.ts"))).toBe(false);
  });

  it("失败时句柄落到 FAILED 且带 reason", () => {
    mkdirSync(join(root, "locked"), { recursive: true });
    chmodSync(join(root, "locked"), 0o500); // r-x：目录可进入不可写
    const h = allowedHandle(db, "grande_repo_edit");
    try {
      expect(() =>
        repoEdit(root, [{ op: "create", path: "locked/a.ts", content: "x" }], RULES, h, CTX),
      ).toThrow();
    } finally {
      chmodSync(join(root, "locked"), 0o700); // afterEach 的 rmSync 需要能删掉它
    }
    const row = getAudit(db, h.opId)!;
    expect(row.state).toBe("FAILED");
    expect(row.reason).toBeTruthy();
  });

  it("repoEdit 的形参数量是 5（tsc 才是真正拦住漏传实参的那道关卡）", () => {
    expect(repoEdit.length).toBe(5);
  });

  it("五个形参【没有一个是可选的】——这条只能扫源码，运行时看不见", () => {
    // 遗留 #6/#7 之后多了第五个 `ctx`。**它必须是必填**：做成
    // `ctx?: EditContext` 再在缺省时 fallback 回 loadLayout()+basename(root)，
    // 等于把那条看不见的前置条件原样留着，还多出一条新路径，比修之前更糟。
    //
    // ⚠️ **`Function.length` 管不了这件事。** 我第一版的注释写着「length 只数到
    // 第一个可选/默认参数为止」——那对 `x = 1` 成立，对 TS 的 `x?: T` **不成立**：
    // 类型层的 `?` 在 strip-types 之后被整个抹掉，形参还是五个。
    // 实测：把签名改成 `ctx?: EditContext` 之后 `repoEdit.length` 仍是 5，
    // 整个文件 37 条测试全绿。所以这里改成扫源码。
    const src = new URL("../src/repoFile.ts", import.meta.url).pathname;
    const sig = readFileSync(src, "utf8").match(/export function repoEdit\(([\s\S]*?)\): EditResult/);
    expect(sig).not.toBeNull();
    expect(sig![1]).not.toMatch(/\?\s*:/);      // 没有可选形参
    expect(sig![1]).not.toMatch(/=\s*[^,)]/);   // 也没有默认值
  });

  it("checkpoint 归属由 ctx.taskId 决定，【不再】由 root 的最后一段决定（遗留 #6）", () => {
    // 这是 #6 的行为证据。此前 taskId = basename(root)，所以 checkpoint 必然
    // 落在以 root 目录名命名的位置——那条约定在签名上完全看不见。
    //
    // 这里故意让两者【不一致】：root 的最后一段是 fixture 的临时目录名，
    // 而 ctx.taskId 传另一个值。checkpoint 必须跟着 ctx 走。
    const other = "task-elsewhere";
    expect(basename(root)).not.toBe(other);

    const r = repoEdit(
      root,
      [{ op: "create", path: "traced.ts", content: "x" }],
      RULES,
      allowedHandle(db, "grande_repo_edit"),
      { layout, taskId: other },
    );

    // checkpoint 落在 ctx.taskId 名下，而不是 basename(root) 名下。
    const cp = join(layout.controlRoot, "checkpoints");
    expect(existsSync(join(cp, other, r.checkpointId))).toBe(true);
    expect(existsSync(join(cp, basename(root)))).toBe(false);
  });
});

describe("grande_repo_edit tool metadata", () => {
  it("description 与 JSON Schema 暴露 delete，且 delete 的 expectedSha256 必填", () => {
    const tool = buildTools({ db, layout }).find((t) => t.name === "grande_repo_edit")!;
    const ops = tool.inputSchema.properties.ops as {
      description?: string;
      items?: { oneOf?: { properties?: { op?: { const?: string } }; required?: string[] }[] };
    };
    const haystack = `${tool.description} ${ops.description ?? ""}`;
    expect(haystack).toContain("delete");
    expect(haystack).toContain("expectedSha256");

    const deleteVariant = (ops.items?.oneOf ?? []).find((v) => v.properties?.op?.const === "delete");
    expect(deleteVariant).toBeDefined();
    expect(deleteVariant!.required).toEqual(expect.arrayContaining(["op", "path", "expectedSha256"]));
  });
});
