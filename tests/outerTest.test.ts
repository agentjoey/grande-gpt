import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { planOuterTest } from "../src/outerTest.ts";

let ws: string, ctrl: string, layout: Layout;
let savedWs: string | undefined, savedCtrl: string | undefined;

/** 只写 profiles.yaml —— planOuterTest 不碰数据库，也不碰仓库。 */
function writeProfiles(body: string): void {
  writeFileSync(join(layout.configDir, "profiles.yaml"), body, "utf8");
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "ot-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "ot-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.workspaceRoot, "demo"), { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("planOuterTest()", () => {
  it("清单从 profile 的 --exclude 反推——改 profile 就自动跟上，这是本命令的全部价值", () => {
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","tests/a.test.ts","--exclude","tests/b.test.ts"], timeoutSeconds: 600 }\n',
    );
    expect(planOuterTest(layout, "demo").files).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);

    // 往 profile 里再加一个排除项 —— 无需改任何代码，本命令必须自动覆盖它。
    // 【这条就是「同源」的证明】：如果清单在 src/outerTest.ts 里硬编码，
    // 这个断言会红，而真实后果是那个文件既不在自举里跑、也不在外层里跑。
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","tests/a.test.ts","--exclude","tests/b.test.ts","--exclude","tests/c.test.ts"], timeoutSeconds: 600 }\n',
    );
    expect(planOuterTest(layout, "demo").files).toEqual([
      "tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts",
    ]);
  });

  it("只取 tests/ 下的排除项——vitest 的默认排除（node_modules/dist）不是「沙箱跑不了」", () => {
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","**/node_modules/**","--exclude","**/dist/**","--exclude","tests/a.test.ts"], timeoutSeconds: 600 }\n',
    );
    const plan = planOuterTest(layout, "demo");
    expect(plan.files).toEqual(["tests/a.test.ts"]);
    // 混进来会让命令去跑不存在的东西
    expect(plan.files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(plan.files.some((f) => f.includes("dist"))).toBe(false);
  });

  it("profile 不再排除任何测试文件时【响亮拒绝】，不是静默返回空清单", () => {
    // 静默返回空清单 = 命令报告「0 个文件，全部通过」= 一个看起来成功的谎。
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run"], timeoutSeconds: 600 }\n',
    );
    expect(() => planOuterTest(layout, "demo")).toThrow(/没有任何/);
  });

  it("profile 不存在时抛错，不猜一个默认清单", () => {
    writeProfiles("repos:\n  demo:\n    unit: { argv: [\"pnpm\",\"test\"], timeoutSeconds: 600 }\n");
    expect(() => planOuterTest(layout, "demo")).toThrow();
  });

  it("每个文件都带排除理由；未登记的理由是 undefined 而不是编一个", () => {
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run","--exclude","tests/sandbox.test.ts","--exclude","tests/unknown.test.ts"], timeoutSeconds: 600 }\n',
    );
    const plan = planOuterTest(layout, "demo");
    expect(plan.reasons.get("tests/sandbox.test.ts")).toContain("sandbox-exec");
    expect(plan.reasons.get("tests/unknown.test.ts")).toBeUndefined();
  });
});

describe("与生产 profile 的一致性", () => {
  it("生产 grande-gpt 的排除清单里每一项都在 WHY 表里登记了理由", () => {
    // 这条读【真实控制平面】，不是夹具。它守的是：有人往 profile 加了排除项却没在
    // src/outerTest.ts 的 WHY 表里登记理由——那会让 `grande outer-test` 输出
    // 「（排除理由未记录）」，一个人看不懂为什么那个文件被排除。
    //
    // **显式指向真实控制平面**，不依赖 env 残留。
    // planOuterTest 只读 `<controlRoot>/config/profiles.yaml`，与 workspaceRoot 无关，
    // 所以这里删掉 GRANDE_CONTROL 让它回落到 ~/.grande-control（真实的），
    // GRANDE_WORKSPACE 保持 beforeEach 设的临时值即可。
    //
    // ⚠️ 这里【不要】写 `if (savedWs === undefined) return`——vitest 跑时该变量本来
    // 就常常没设，那个 guard 会让整条测试静默空转。我第一次清理这段代码时就这么
    // 干了，结果注入孤项后测试照样绿。
    delete process.env.GRANDE_CONTROL;

    const plan = planOuterTest(loadLayout(), "grande-gpt");
    expect(plan.files.length).toBeGreaterThan(0);    // 防空转
    for (const f of plan.files) {
      expect(plan.reasons.get(f), `${f} 被 profile 排除，但 WHY 表里没有理由`).toBeDefined();
    }
  });
});
