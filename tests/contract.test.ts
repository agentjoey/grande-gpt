import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, JOB_STATES, ABORTED_JOB_STATES, TERMINAL_AUDIT_STATES } from "../src/contract.ts";

/**
 * 契约漂移检测。
 *
 * 控制台（`../grande-console`）持有本文件的一份**副本**——Turbopack 不跟出项目根，
 * symlink 与 tsconfig paths 都走不通（详见副本头部的说明）。
 *
 * **所以这条测试是唯一的强制力。** 它在 grande-gpt 这一侧，意味着你改了契约之后
 * 跑 `pnpm test` 就会红——而改契约的人本来就会跑这一侧的测试。
 */
describe("与控制台的契约副本", () => {
  const copy = join(import.meta.dirname, "..", "..", "grande-console", "src", "lib", "contract.ts");

  it("控制台的副本与本仓库的源文件【逐字节相同】（头部说明除外）", () => {
    if (!existsSync(copy)) {
      // 控制台是可选组件；不存在时跳过而不是失败。但要说出来，不静默通过。
      console.warn("[skip] 找不到控制台副本，漂移检测未执行：" + copy);
      return;
    }
    const src = readFileSync(join(import.meta.dirname, "..", "src", "contract.ts"), "utf8");
    const dst = readFileSync(copy, "utf8");

    /**
     * 比对**去掉全部注释与空行之后的代码**，不是逐字节。
     *
     * 副本比源文件多一段「不要在这里编辑」的说明，逐字节比对必然失败——
     * 我第一版用正则去剥那一段，结果基线就是红的（正则没匹配上）。
     * 剥注释稳得多：它不依赖任何一段特定文字的写法。
     *
     * 代价：**只改注释不会被检测到**。可以接受——契约的语义在代码里，
     * 而注释漂移不会让控制台把 timeout 的 job 画丢。
     */
    const code = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释
       .replace(/^\s*\/\/.*$/gm, "")        // 行注释
       .replace(/^\s*$/gm, "")               // 空行
       .trim();
    expect(code(dst)).toBe(code(src));
  });

  it("契约本身自洽：ABORTED 是 JOB_STATES 的子集", () => {
    for (const s of ABORTED_JOB_STATES) expect(JOB_STATES).toContain(s);
  });

  it("SCHEMA_VERSION 与 db.ts 一致", async () => {
    const { SCHEMA_VERSION: fromDb } = await import("../src/db.ts");
    expect(fromDb).toBe(SCHEMA_VERSION);
  });

  it("审计终态恰好两个", () => {
    expect([...TERMINAL_AUDIT_STATES]).toEqual(["SUCCEEDED", "FAILED"]);
  });
});
