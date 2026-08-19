import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("ChatGPT connector compatibility operational contract", () => {
  it("README separates GrandeGPT Dev from the stable Production App and records the onboarding tool-contract release", () => {
    const text = read("README.md");
    expect(text).toContain("GrandeGPT Dev");
    expect(text).toContain("Production App");
    expect(text).toContain("tool-contract release");
    expect(text).toContain("频繁");
    expect(text).toContain("25 tools");
    expect(text).toContain("toolsetEpoch=2");
    expect(text).toContain("grande_repo_add_propose");
    expect(text).toContain("grande_repo_add_apply");
  });

  it("runbook encodes current 25-tool/epoch-2 baseline plus refresh/bump/recovery rules without bypassing the Gateway", () => {
    const text = read("docs/chatgpt-connector-compatibility-runbook.md");
    expect(text).toContain("toolsetEpoch");
    expect(text).toContain("toolsDigest");
    expect(text).toContain("25");
    expect(text).toContain("epoch 2");
    expect(text).toContain("grande_repo_add_propose");
    expect(text).toContain("grande_repo_add_apply");
    expect(text).toContain("patch release");
    expect(text).toContain("不 Refresh App");
    expect(text).toContain("Scan/Refresh Tools");
    expect(text).toContain("新聊天");
    expect(text).toContain("read probe");
    expect(text).toContain("grande_task_status");
    expect(text).toContain("Resource not found");
    expect(text).toContain("tool disabled");
    expect(text).toContain("禁止绕过 Gateway merge");
    expect(text).toContain("保留 task");
    expect(text).toContain("ChatGPT session binding");
    expect(text).toContain("server-side");
  });
});
