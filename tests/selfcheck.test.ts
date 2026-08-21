import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import type { Layout } from "../src/layout.ts";
import { renderSelfCheck, selfCheck, type SelfCheckResult } from "../src/selfcheck.ts";

/**
 * 遗留 #4 下半的渲染层。
 *
 * `selfCheck()` 本身要起真实 HTTP 请求（那是它存在的理由，见模块 JSDoc），
 * 它的端到端证据在 `tests/server.test.ts` —— 那里有一个真实监听端口的网关。
 * 这个文件只测渲染：**输出必须能让人一眼比对出 2026-07-29 那次故障的变量**。
 */

const base = {
  url: "http://127.0.0.1:8787/mcp",
  httpStatus: 200,
  bytes: 11326,
  gatewayBuild: "build-test-abc",
  toolsetEpoch: 1,
  toolsCount: 4,
  toolsDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tools: [
    { name: "grande_repo_read", readOnly: true, destructive: false, openWorld: false, requiredParams: ["path"] },
    { name: "grande_task_open", readOnly: false, destructive: false, openWorld: false, requiredParams: ["taskId"] },
    { name: "grande_task_close", readOnly: false, destructive: true, openWorld: false, requiredParams: ["taskId"] },
    { name: "grande_push", readOnly: false, destructive: false, openWorld: true, requiredParams: ["taskId"] },
  ],
} as SelfCheckResult;

const text = (r: SelfCheckResult) => renderSelfCheck(r).join("\n");

const identity = {
  ok: true,
  data: {
    gatewayBuild: "build-from-wire",
    toolsetEpoch: 2,
    toolsCount: 1,
    toolsDigest: "sha256:wire",
  },
};

const toolsList = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [{
      name: "grande_task_status",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { type: "object", properties: {}, required: [] },
    }],
  },
};

const cleanup: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (cleanup.length > 0) cleanup.pop()!();
});

async function runSelfCheckWith(callResult: Record<string, unknown>): Promise<SelfCheckResult> {
  const root = mkdtempSync(join(tmpdir(), "selfcheck-wire-"));
  const controlRoot = join(root, "control");
  const secrets = join(controlRoot, "secrets");
  mkdirSync(secrets, { recursive: true });
  const derivedRoot = join(root, "workspace", ".grande-work");
  const layout: Layout = {
    workspaceRoot: join(root, "workspace"),
    controlRoot,
    stateDb: join(controlRoot, "state", "grande.db"),
    configDir: join(controlRoot, "config"),
    reposConfig: join(controlRoot, "config", "repos.yaml"),
    artifactsDir: join(controlRoot, "artifacts"),
    derivedRoot,
    worktreesRoot: join(derivedRoot, "worktrees"),
  };
  const db = openDb(layout);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }), () => db.close());

  const responses = [toolsList, { jsonrpc: "2.0", id: 2, result: callResult }];
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ authorization: expect.stringMatching(/^Bearer /) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected selfcheck request");
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));

  return await selfCheck({
    issuer: "https://grande.example.test",
    baseUrl: "https://gateway.example.test",
    db,
    keyPath: join(secrets, "oauth-key"),
  });
}

describe("selfcheck tool-result compatibility", () => {
  it("prefers the canonical text-content envelope when structuredContent is absent", async () => {
    const result = await runSelfCheckWith({
      content: [{ type: "text", text: JSON.stringify(identity) }],
    });

    expect(result.gatewayBuild).toBe("build-from-wire");
    expect(result.toolsetEpoch).toBe(2);
    expect(result.toolsCount).toBe(1);
    expect(result.toolsDigest).toBe("sha256:wire");
    expect(result.identityError).toBeUndefined();
  });

  it("falls back to a legacy structuredContent envelope", async () => {
    const result = await runSelfCheckWith({ structuredContent: identity });

    expect(result.gatewayBuild).toBe("build-from-wire");
    expect(result.identityError).toBeUndefined();
  });

  it.each([
    ["malformed", "{not-json"],
    ["non-envelope", JSON.stringify({ data: identity.data })],
  ])("fails closed on %s text instead of falling back to legacy structuredContent", async (_case, wireText) => {
    const result = await runSelfCheckWith({
      content: [{ type: "text", text: wireText }],
      structuredContent: identity,
    });

    expect(result.gatewayBuild).toBeNull();
    expect(result.toolsetEpoch).toBeNull();
    expect(result.toolsDigest).toBeNull();
    expect(result.identityError).toBeTruthy();
  });
});

describe("自检输出必须能直接支撑 2026-07-29 那次排查", () => {
  it("按 readOnlyHint 分两组——那正是当时唯一的变量", () => {
    // 排查绕了三个错误假设，最后靠「比对能用与不能用两组工具的结构差异」定的位：
    // 顶层键、type、required 形状完全相同，唯一差别是 readOnlyHint。
    // 输出如果不按这条轴分组，读的人得自己在一张平表里做这件事。
    const t = text(base);
    expect(t).toContain("只读工具");
    expect(t).toContain("写工具");
    expect(t.indexOf("grande_repo_read")).toBeLessThan(t.indexOf("grande_task_open"));
    expect(t).toContain("6 只读 / 9 写".replace("6", "1").replace("9", "3"));   // 1 只读 / 3 写
  });

  it("明写那条【客户端侧】的根因，而不是只摆数据", () => {
    // 光给一张表，下次撞上的人还是得重新推一遍。根因是平台行为，
    // 服务端怎么查都查不出来，所以必须写在输出里。
    const t = text(base);
    expect(t).toContain("Allow low-risk actions");
    expect(t).toContain("Allow all actions");
    expect(t).toContain("能列出、调不动");
  });

  it("暴露 server toolset identity，并明确 ChatGPT session binding 无法 server-side 验证", () => {
    const t = text(base);
    expect(t).toContain("build-test-abc");
    expect(t).toContain("toolsetEpoch  1");
    expect(t).toContain("toolsCount    4");
    expect(t).toContain("sha256:aaaaaaaa");
    expect(t).toContain("ChatGPT session binding");
    expect(t).toContain("server-side 无法直接验证");
  });

  it("响应字节数带上已知的对照基准——否则那个数字没法解读", () => {
    // 被排除的假设之一是「tools/list 响应被 ChatGPT 静默截断」。
    // 一个孤零零的 11326 无法证伪它；带上 POC 实测的 73,896 才可以。
    expect(text(base)).toContain("73,896");
    expect(text(base)).toContain("11326");
  });

  it("触网与破坏性工具单独点名——CLAUDE.md 的精确名单靠人核对", () => {
    const t = text(base);
    expect(t).toContain("触网工具  grande_push");
    expect(t).toContain("破坏性工具 grande_task_close");
  });

  it("一个工具都没有时【不能】渲染成正常——空名单要看得出是空的", () => {
    const t = text({ ...base, tools: [], toolsCount: 0 } as SelfCheckResult);
    expect(t).toContain("0 个：0 只读 / 0 写");
    expect(t).toContain("触网工具  （无）");
  });
});

describe("失败路径必须给出可照做的下一步", () => {
  it("401 时首先指向 revoke，并说明那是【正确】行为", () => {
    // 跑过 grande revoke --yes 之后自检被拒是对的——真实客户端此刻同样被拒。
    // 不说这一句的话，人会把一次成功的吊销读成自检坏了。
    const t = text({ ...base, httpStatus: 401, tools: [] } as SelfCheckResult);
    expect(t).toContain("revoke");
    expect(t).toContain("【正确】行为");
    expect(t).toContain("GRANDE_ISSUER");
    // 401 时不该再假装有工具表
    expect(t).not.toContain("只读工具");
  });

  it("非 200 非 401 时把人引回服务端日志的两行", () => {
    const t = text({ ...base, httpStatus: 500, tools: [] } as SelfCheckResult);
    expect(t).toContain("[gw]");
    expect(t).toContain("[rpc]");
  });
});
