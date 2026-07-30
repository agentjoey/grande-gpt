import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { bumpEpoch, currentEpoch, isEpochCurrent } from "../src/tokenEpoch.ts";

let ws: string, ctrl: string, layout: Layout, db: ReturnType<typeof openDb>;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "ep-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "ep-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  db = openDb(layout);
});

afterEach(() => {
  db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("epoch 存取", () => {
  it("空库返回 1（不是 0）—— 0 是 falsy，会让「缺失」和「合法最小值」撞在一起", () => {
    expect(currentEpoch(db)).toBe(1);
  });

  it("bump 递增并返回新值，可重复", () => {
    expect(bumpEpoch(db)).toBe(2);
    expect(bumpEpoch(db)).toBe(3);
    expect(currentEpoch(db)).toBe(3);
  });

  it("并发 bump 不丢递增 —— 用 ON CONFLICT 而不是先读再写", () => {
    // 「先读再写」的实现下，两次都读到 1、都写 2，最终是 2 而不是 3。
    // 这是本项目已经犯过两次的 CAS 形状。
    const a = openDb(layout);
    const b = openDb(layout);
    bumpEpoch(a);
    bumpEpoch(b);
    expect(currentEpoch(db)).toBe(3);
    a.close();
    b.close();
  });
});

describe("isEpochCurrent", () => {
  it("claim 缺失一律拒绝 —— 不当作「老 token，放行吧」", () => {
    // 放行才是危险的方向：本特性上线【之前】签发的 token 恰恰是最该切断的一批，
    // 它们诞生于「无法吊销」的时代。代价是上线时要重新授权一次，可接受。
    expect(isEpochCurrent(undefined, 1)).toBe(false);
    expect(isEpochCurrent(null, 1)).toBe(false);
    expect(isEpochCurrent("2", 1)).toBe(false);   // 字符串不算
    expect(isEpochCurrent(1.5, 1)).toBe(false);   // 非整数不算
    expect(isEpochCurrent(Number.NaN, 1)).toBe(false);
  });

  it("等于或大于当前值才通过", () => {
    expect(isEpochCurrent(1, 1)).toBe(true);
    expect(isEpochCurrent(2, 1)).toBe(true);   // 签发晚于本次读取，仍有效
    expect(isEpochCurrent(0, 1)).toBe(false);
    expect(isEpochCurrent(1, 2)).toBe(false);  // 被吊销
  });
});

describe("跨进程可见性 —— 整个特性成立的前提", () => {
  it("另一个进程 bump 之后，长期持有连接的本进程【下一次读】立刻看到新值", () => {
    // 网关是个长跑进程，`grande revoke` 是另一个进程。如果这里看不见，
    // revoke 就得等网关重启才生效——那等于没做这个特性。
    // WAL 模式 + 每次新建 statement，实测立即可见。
    expect(currentEpoch(db)).toBe(1);

    execFileSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "-e",
       `import("${new URL("../src/tokenEpoch.ts", import.meta.url).pathname}").then(async (m) => {
          const { openDb } = await import("${new URL("../src/db.ts", import.meta.url).pathname}");
          const { loadLayout } = await import("${new URL("../src/layout.ts", import.meta.url).pathname}");
          const d = openDb(loadLayout()); m.bumpEpoch(d); d.close();
        })`],
      { env: { ...process.env, GRANDE_WORKSPACE: ws, GRANDE_CONTROL: ctrl }, stdio: "pipe" },
    );

    // 【关键】用的是 beforeEach 里那个【没有重新打开过】的连接
    expect(currentEpoch(db)).toBe(2);
  });
});
