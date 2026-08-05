import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 审计句柄调用模式的**结构性检查**。
 *
 * 这不是风格检查，它防的是一个已实测的真实故障：模式 B（把句柄传给领域函数）
 * 的调用点看起来像「漏了 executing() 守卫」，顺手补上之后领域函数内部的
 * `executing()` 会因为 CAS 谓词失败而返回 false，于是抛
 * `POLICY_DENIED：审计句柄推进失败`——**一个正常操作被中止，而错误消息
 * 指向完全错误的方向**。
 *
 * 光写 JSDoc 挡不住这个（软约束）。这条测试是硬的：混用就红。
 */

const SRC = join(import.meta.dirname, "..", "src");

interface Site { file: string; line: number; snippet: string; inline: boolean; delegated: boolean }

/**
 * 扫描每一处 `= beginAudit(` 并判断它属于哪种模式。
 *
 * 三个坑（前两版各踩了一个，都产生了假阳性/假阴性）：
 *
 * ① **必须先剥注释**——否则 `audit.ts` 里那段讲解两种模式的 JSDoc 示例会被当成
 *    真实调用点，而它同时"包含"两种模式的代码。
 * ② **窗口不能是固定行数**——看后 40 行会从 `grande_repo_edit` 滑进下一个工具，
 *    把别人的 `executing()` 算到它头上。
 * ③ **也不能按大括号配平**——`beginAudit(db, { … })` 的参数对象自带 `{}`，
 *    从它开始配平会在第 3 行就"收尾"，于是所有多行调用都被判成"两种模式都不是"。
 *
 * 最后用的判据：**从声明处扫到该变量名最后一次出现的那一行**。
 * 句柄的生命周期就是它被引用的范围，这个定义不依赖任何语法结构。
 */
function scan(): Site[] {
  const out: Site[] = [];
  for (const f of readdirSync(SRC).filter((x) => x.endsWith(".ts"))) {
    // ① 剥注释，用等长空白填回去以保住行号
    const raw = readFileSync(join(SRC, f), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
    const lines = code.split("\n");
    const rawLines = raw.split("\n");

    lines.forEach((l, i) => {
      const m = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*beginAudit\(/.exec(l);
      if (!m) return;
      const name = m[1]!;
      const ref = new RegExp(`\\b${name}\\b`);

      // ②③ 生命周期 = 从声明到该变量名最后一次出现
      let end = i;
      for (let k = i + 1; k < lines.length; k++) {
        if (ref.test(lines[k]!)) end = k;
        // 遇到下一个 beginAudit 声明就停——那是另一个句柄的地盘
        if (k > i && /=\s*beginAudit\(/.test(lines[k]!)) break;
      }
      const body = lines.slice(i, end + 1).join("\n");

      const inline = new RegExp(`\\b${name}\\.executing\\(\\)`).test(body);
      const delegated = new RegExp(`[(,]\\s*${name}\\s*[),]`).test(body);
      out.push({ file: f, line: i + 1, snippet: rawLines[i]!.trim().slice(0, 70), inline, delegated });
    });
  }
  return out;
}

describe("审计句柄的两种调用模式", () => {
  const sites = scan();

  it("扫描到了调用点——扫不到说明正则失效，这条测试会变成空转", () => {
    // 防空转：真实代码里有 8 处左右，一个都扫不到必然是我的正则坏了
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it("**每处只能属于一种模式**：内联推进，或交给领域函数，不能两者都做", () => {
    const mixed = sites.filter((s) => s.inline && s.delegated);
    expect(
      mixed.map((s) => `${s.file}:${s.line}  ${s.snippet}`),
      "同时自己 executing() 又把句柄传出去 —— 领域函数内部会拿到 false 并中止一个正常的操作",
    ).toEqual([]);
  });

  it("每处至少属于一种模式——两种都不是意味着句柄永远停在 INTENT", () => {
    const orphan = sites.filter((s) => !s.inline && !s.delegated);
    expect(
      orphan.map((s) => `${s.file}:${s.line}  ${s.snippet}`),
      "既不自己推进也不交给别人 —— 这条审计行会永远卡在中间态，并在控制台首屏报警",
    ).toEqual([]);
  });
});
