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

  it("records exact candidate host evidence while keeping the remaining cross-client gate explicit", () => {
    const backlog = read("docs/BACKLOG.md");
    const runbook = read("docs/chatgpt-connector-compatibility-runbook.md");
    const candidateCommit = "7b98f7dce2f0b10723b29be64ca28e1438f1a779";

    for (const text of [backlog, runbook]) {
      expect(text).toContain(candidateCommit);
      expect(text).toMatch(/5 files\s*\/\s*160 tests/i);
    }

    expect(runbook).toMatch(/切换代码前[\s\S]{0,500}gatewayBuild[\s\S]{0,300}toolsetEpoch[\s\S]{0,300}toolsCount[\s\S]{0,300}toolsDigest/);
    expect(runbook).toContain("candidate-on-production-state");
    expect(runbook).toMatch(/candidate[\s\S]{0,240}production[\s\S]{0,240}(?:toolsetEpoch|toolsCount|toolsDigest)/i);
    expect(runbook).not.toMatch(/只有 production `toolsDigest` 精确等于/);
    expect(runbook).toMatch(/不一致[\s\S]{0,300}(?:停止|abort)[\s\S]{0,300}(?:reconcile|对账|授权)/i);
    expect(runbook).toContain("JSON.stringify(toMcpTextResult(envelope))");
    expect(runbook).toMatch(/SDK-generated[\s\S]{0,160}outputBytes=unknown/i);

    const incident = backlog.match(/### GG-BL-010[\s\S]*?(?=\n### |\s*$)/)?.[0] ?? "";
    expect(incident).toMatch(/\*\*Status\*\*: MITIGATED/);
    expect(incident).toMatch(/\*\*Remaining\*\*:[\s\S]*(Web|跨客户端)[\s\S]*(iOS|fresh-Web|两任务)/i);
    expect(incident).toMatch(/\*\*Done when\*\*:[\s\S]*(跨客户端|cross-client)[\s\S]*(两任务|two-task|两个.*用户任务)/i);
  });
});
