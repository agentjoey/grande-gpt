import { describe, expect, it } from "vitest";
import { renderSelfCheck, type SelfCheckResult } from "../src/selfcheck.ts";

/**
 * 遗留 #4 下半的渲染层。
 *
 * `selfCheck()` 本身要起真实 HTTP 请求（那是它存在的理由，见模块 JSDoc），
 * 它的端到端证据在 `tests/server.test.ts` —— 那里有一个真实监听端口的网关。
 * 这个文件只测渲染：**输出必须能让人一眼比对出 2026-07-29 那次故障的变量**。
 */

const base: SelfCheckResult = {
  url: "http://127.0.0.1:8787/mcp",
  httpStatus: 200,
  bytes: 11326,
  tools: [
    { name: "grande_repo_read", readOnly: true, destructive: false, openWorld: false, requiredParams: ["path"] },
    { name: "grande_task_open", readOnly: false, destructive: false, openWorld: false, requiredParams: ["taskId"] },
    { name: "grande_task_close", readOnly: false, destructive: true, openWorld: false, requiredParams: ["taskId"] },
    { name: "grande_push", readOnly: false, destructive: false, openWorld: true, requiredParams: ["taskId"] },
  ],
};

const text = (r: SelfCheckResult) => renderSelfCheck(r).join("\n");

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
    const t = text({ ...base, tools: [] });
    expect(t).toContain("0 个：0 只读 / 0 写");
    expect(t).toContain("触网工具  （无）");
  });
});

describe("失败路径必须给出可照做的下一步", () => {
  it("401 时首先指向 revoke，并说明那是【正确】行为", () => {
    // 跑过 grande revoke --yes 之后自检被拒是对的——真实客户端此刻同样被拒。
    // 不说这一句的话，人会把一次成功的吊销读成自检坏了。
    const t = text({ ...base, httpStatus: 401, tools: [] });
    expect(t).toContain("revoke");
    expect(t).toContain("【正确】行为");
    expect(t).toContain("GRANDE_ISSUER");
    // 401 时不该再假装有工具表
    expect(t).not.toContain("只读工具");
  });

  it("非 200 非 401 时把人引回服务端日志的两行", () => {
    const t = text({ ...base, httpStatus: 500, tools: [] });
    expect(t).toContain("[gw]");
    expect(t).toContain("[rpc]");
  });
});
