import { describe, expect, it } from "vitest";
import { err, ok, truncateList, truncateText } from "../src/envelope.ts";

describe("ok()", () => {
  it("填充全部字段并对可选项取默认值", () => {
    expect(ok({ taskId: "task_a", data: { n: 1 }, hint: "下一步" })).toEqual({
      ok: true,
      taskId: "task_a",
      truncated: false,
      nextCursor: null,
      hint: "下一步",
      data: { n: 1 },
      taskContext: null,
    });
  });

  it("truncated / nextCursor / hint 序列化在 data 之前", () => {
    const json = JSON.stringify(ok({ data: { big: "x".repeat(100) }, hint: "h", truncated: true }));
    expect(json.indexOf('"truncated"')).toBeLessThan(json.indexOf('"data"'));
    expect(json.indexOf('"nextCursor"')).toBeLessThan(json.indexOf('"data"'));
    expect(json.indexOf('"hint"')).toBeLessThan(json.indexOf('"data"'));
  });
});

describe("err()", () => {
  it("retryable 默认 false，details 默认空对象", () => {
    expect(err({ taskId: "t", code: "STALE_FILE", message: "changed" })).toEqual({
      ok: false,
      taskId: "t",
      error: { code: "STALE_FILE", message: "changed", retryable: false, details: {} },
    });
  });
});

describe("truncateText()", () => {
  it("未超限时原样返回", () => {
    expect(truncateText("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("超限时按字节截断并标记", () => {
    const r = truncateText("abcdefghij", 4);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(4);
  });

  it("按字节而非字符截断，且不切出半个多字节字符", () => {
    const r = truncateText("中文中文", 5);
    expect(r).toEqual({ text: "中", truncated: true });
  });

  it("maxBytes 为 0 时返回空串", () => {
    expect(truncateText("中文", 0)).toEqual({ text: "", truncated: true });
  });

  it("截断点恰好落在字符边界时不多退一个字符", () => {
    expect(truncateText("中文", 3)).toEqual({ text: "中", truncated: true });
  });
});

describe("truncateList()", () => {
  it("未超限时 nextCursor 为 null", () => {
    expect(truncateList([1, 2], 5)).toEqual({ items: [1, 2], truncated: false, nextCursor: null });
  });

  it("超限时截断并给出下一页游标", () => {
    expect(truncateList([1, 2, 3, 4, 5], 2)).toEqual({ items: [1, 2], truncated: true, nextCursor: "2" });
  });

  it("带 offset 时返回下一页，而不是重复第一页", () => {
    expect(truncateList([1, 2, 3, 4, 5], 2, 2)).toEqual({ items: [3, 4], truncated: true, nextCursor: "4" });
  });

  it("翻到最后一页时 truncated 为 false、nextCursor 为 null——续读能终止", () => {
    expect(truncateList([1, 2, 3, 4, 5], 2, 4)).toEqual({ items: [5], truncated: false, nextCursor: null });
  });

  it("offset 越界时返回空页而不是报错", () => {
    expect(truncateList([1, 2], 2, 99)).toEqual({ items: [], truncated: false, nextCursor: null });
  });
});
