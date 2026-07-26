import { describe, expect, it } from "vitest";
import { err, ok, truncateList, truncateText } from "../src/envelope.ts";

describe("ok()", () => {
  it("填充全部信封字段并对可选项取默认值", () => {
    const e = ok({ taskId: "task_a1", data: { n: 1 }, hint: "下一步" });
    expect(e).toEqual({
      ok: true,
      taskId: "task_a1",
      data: { n: 1 },
      truncated: false,
      nextCursor: null,
      hint: "下一步",
      taskContext: null,
    });
  });

  it("taskId 缺省时为 null", () => {
    expect(ok({ data: 1, hint: "h" }).taskId).toBeNull();
  });
});

describe("err()", () => {
  it("构造错误信封，retryable 默认 false", () => {
    const e = err({ taskId: "task_a1", code: "STALE_FILE", message: "changed" });
    expect(e).toEqual({
      ok: false,
      taskId: "task_a1",
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

  it("按字节而非字符截断，不产生半个多字节字符", () => {
    const r = truncateText("中文中文", 5);
    expect(r.truncated).toBe(true);
    expect(() => JSON.parse(JSON.stringify(r.text))).not.toThrow();
    expect(r.text).toBe("中");
  });
});

describe("truncateList()", () => {
  it("未超限时 nextCursor 为 null", () => {
    expect(truncateList([1, 2], 5)).toEqual({ items: [1, 2], truncated: false, nextCursor: null });
  });

  it("超限时截断并给出下一页游标", () => {
    const r = truncateList([1, 2, 3, 4, 5], 2);
    expect(r.items).toEqual([1, 2]);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBe("2");
  });

  it("不传 offset（默认 0）时首页行为与旧签名完全一致", () => {
    expect(truncateList([1, 2, 3, 4, 5], 2, 0)).toEqual(truncateList([1, 2, 3, 4, 5], 2));
  });

  it("C2 回归：带上一页返回的 nextCursor 作为 offset 续读时，第二页内容与第一页不同（此前 cursor 是摆设，第二次调用会拿到与第一次字节相同的结果）", () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const page1 = truncateList(items, 3);
    expect(page1.items).toEqual([1, 2, 3]);
    expect(page1.truncated).toBe(true);
    expect(page1.nextCursor).toBe("3");

    const page2 = truncateList(items, 3, Number(page1.nextCursor));
    expect(page2.items).toEqual([4, 5, 6]);
    expect(page2.items).not.toEqual(page1.items);
    expect(page2.truncated).toBe(true);
    expect(page2.nextCursor).toBe("6");
  });

  it("C2 回归：翻到最后一页时 truncated 为 false、nextCursor 为 null——续读能终止，而不是无限声称还有下一页", () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const page3 = truncateList(items, 3, 6);
    expect(page3.items).toEqual([7]);
    expect(page3.truncated).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it("offset 超出数组长度时返回空页，不抛异常", () => {
    const r = truncateList([1, 2, 3], 2, 10);
    expect(r.items).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.nextCursor).toBeNull();
  });
});
