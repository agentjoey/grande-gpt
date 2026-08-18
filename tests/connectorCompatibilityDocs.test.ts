import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("ChatGPT connector compatibility operational contract", () => {
  it("README separates GrandeGPT Dev from the stable Production App", () => {
    const text = read("README.md");
    expect(text).toContain("GrandeGPT Dev");
    expect(text).toContain("Production App");
    expect(text).toContain("tool-contract release");
    expect(text).toContain("频繁");
  });

  it("runbook encodes refresh/bump/recovery rules and forbids bypassing the Gateway", () => {
    const text = read("docs/chatgpt-connector-compatibility-runbook.md");
    expect(text).toContain("toolsetEpoch");
    expect(text).toContain("toolsDigest");
    expect(text).toContain("patch release");
    expect(text).toContain("不 Refresh App");
    expect(text).toContain("Scan/Refresh Tools");
    expect(text).toContain("新聊天");
    expect(text).toContain("read probe");
    expect(text).toContain("Resource not found");
    expect(text).toContain("tool disabled");
    expect(text).toContain("禁止绕过 Gateway merge");
    expect(text).toContain("保留 task");
    expect(text).toContain("ChatGPT session binding");
    expect(text).toContain("server-side");
  });
});
