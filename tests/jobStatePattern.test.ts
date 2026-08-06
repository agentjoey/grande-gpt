import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_STATES, TERMINAL_JOB_STATES } from "../src/contract.ts";
import { TERMINAL } from "../src/jobs.ts";

/**
 * 遗留 #1 的机械探针。
 *
 * ## 为什么是扫源码而不是测行为
 *
 * `state === "running"` 与 `!TERMINAL.has(state)` 在**今天**完全等价——六个
 * JobState 里终态占五个。任何行为测试都无法区分它们，因为区分它们需要一个
 * 第七种状态，而那个状态还不存在。
 *
 * 这类缺陷单元测试天然抓不到，跟 P-A「模块写好但没接上线」是同一类：
 * 检查的是**代码写成了什么形状**，不是它算得对不对。本项目已经为此付过两次
 * 代价（遗留表里记着「同源漏改」出现 2 次），所以这里就用机械扫描。
 */

const SRC = new URL("../src/", import.meta.url).pathname;

function sources(): { file: string; text: string }[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(join(SRC, f), "utf8") }));
}

/** 去掉注释——注释里出现 `state === "running"` 是在解释这条规则，不是违反它。 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("遗留 #1：job 终态判定必须走单一集合", () => {
  it("src/ 里【不存在】拿 job 状态与字面量 \"running\" 直接比较的地方", () => {
    // 允许出现的例外只有两处，且都不是「判定终态」：
    //   - contract.ts / jobs.ts 里 JOB_STATES 自身的定义
    //   - runner.ts 的 StartedJob.state 字面量类型（那是刚起的 job，恒为 running）
    const ALLOW = new Set(["contract.ts"]);
    const offenders: string[] = [];

    for (const { file, text } of sources()) {
      if (ALLOW.has(file)) continue;
      code(text).split("\n").forEach((line, i) => {
        // 只找【比较】，不找类型标注（`state: "running"`）与赋值
        if (/\.state\s*(===|!==)\s*"running"/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("jobs.ts 的 TERMINAL 与 contract.ts 同步，且【不是】手写的第二份名单", () => {
    expect([...TERMINAL].sort()).toEqual([...TERMINAL_JOB_STATES].sort());
    // 分母正确：终态 + running == 全集。少一个就说明有状态无处归类。
    expect(TERMINAL.size + 1).toBe(JOB_STATES.length);
    expect(TERMINAL.has("running" as never)).toBe(false);

    // 名单是推导来的：jobs.ts 里不该再出现一串写死的状态字面量。
    const jobsSrc = code(readFileSync(join(SRC, "jobs.ts"), "utf8"));
    expect(jobsSrc).not.toMatch(/new Set\(\s*\[\s*"passed"/);
  });
});
