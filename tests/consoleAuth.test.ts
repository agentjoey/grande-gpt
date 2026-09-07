import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { AccessConfigError, AccessDeniedError } from "../src/accessGate.ts";
import {
  assertConsoleOrigin,
  assertDistinctAudience,
  loadConsoleAccessConfig,
} from "../src/consoleAuth.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

const TEAM = "https://team.example.test";
const AUD = "c".repeat(64);
const ORIGIN = "https://console.example.test";

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "console-auth-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "console-auth-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
  writeFileSync(join(layout.configDir, "access-console.yaml"), yaml, "utf8");
}

function expectBadConfig(yaml: string, match: RegExp): void {
  writeConfig(yaml);
  try {
    loadConsoleAccessConfig(layout);
    expect.unreachable("应当拒绝启动，实际却通过了");
  } catch (e) {
    expect(e).toBeInstanceOf(AccessConfigError);
    expect((e as AccessConfigError).code).toBe("BAD_CONFIG");
    expect((e as AccessConfigError).message).toMatch(match);
  }
}

describe("loadConsoleAccessConfig：origin 必填、https、归一化", () => {
  it("缺文件仍是 MISSING_CONFIG（语义不变：门禁从未安装）", () => {
    try {
      loadConsoleAccessConfig(layout);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AccessConfigError);
      expect((e as AccessConfigError).code).toBe("MISSING_CONFIG");
    }
  });

  it("完整合法配置返回 teamDomain/aud/origin", () => {
    writeConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: ${ORIGIN}\n`);
    expect(loadConsoleAccessConfig(layout)).toEqual({ teamDomain: TEAM, aud: AUD, origin: ORIGIN });
  });

  it("origin 归一化：大写主机名、显式默认端口、尾斜杠都收敛到规范 origin", () => {
    writeConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: https://CONSOLE.example.test:443/\n`);
    expect(loadConsoleAccessConfig(layout).origin).toBe(ORIGIN);
  });

  it("origin 保留非默认端口", () => {
    writeConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: https://console.example.test:8443\n`);
    expect(loadConsoleAccessConfig(layout).origin).toBe("https://console.example.test:8443");
  });

  it("origin 缺失 → BAD_CONFIG（旧配置不静默升级：缺 origin 的审批面等于没装 CSRF 边界）", () => {
    expectBadConfig(`teamDomain: ${TEAM}\naud: ${AUD}\n`, /origin/);
  });

  it("origin 不是字符串 → BAD_CONFIG", () => {
    expectBadConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: 42\n`, /origin/);
  });

  it("origin 不是绝对 URL → BAD_CONFIG", () => {
    expectBadConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: console.example.test\n`, /origin/);
  });

  it("http origin → BAD_CONFIG（审批面只在 https 上有意义）", () => {
    expectBadConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: http://console.example.test\n`, /https/);
  });

  it("origin 带路径/query/hash → BAD_CONFIG（origin 是源，不是页面 URL）", () => {
    expectBadConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: ${ORIGIN}/console\n`, /origin/);
    expectBadConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: ${ORIGIN}?x=1\n`, /origin/);
    expectBadConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: "${ORIGIN}#frag"\n`, /origin/);
  });

  it("origin 带用户名密码 → BAD_CONFIG", () => {
    expectBadConfig(`teamDomain: ${TEAM}\naud: ${AUD}\norigin: https://u:p@console.example.test\n`, /origin/);
  });

  it("既有校验不回归：aud 非 64 位十六进制 → BAD_CONFIG", () => {
    expectBadConfig(`teamDomain: ${TEAM}\naud: not-hex\norigin: ${ORIGIN}\n`, /aud/);
  });

  it("既有校验不回归：teamDomain 不是绝对 URL → BAD_CONFIG", () => {
    expectBadConfig(`teamDomain: not-a-url\naud: ${AUD}\norigin: ${ORIGIN}\n`, /teamDomain/);
  });
});

describe("assertDistinctAudience（回归）", () => {
  // 用变量而不是调用点字面量：ConsoleAccessConfig 比 AccessConfig 多一个 origin 字段，
  // 字面量直传会撞 TS 的 excess property check。
  const mcpCfg = { teamDomain: TEAM, aud: "a".repeat(64) };
  const consoleCfg = { teamDomain: TEAM, aud: AUD, origin: ORIGIN };

  it("两个 aud 相同 → 拒绝启动", () => {
    expect(() =>
      assertDistinctAudience({ ...consoleCfg }, { ...consoleCfg }),
    ).toThrow(/aud 相同/);
  });

  it("aud 不同 → 通过", () => {
    expect(() => assertDistinctAudience(mcpCfg, consoleCfg)).not.toThrow();
  });
});

describe("assertConsoleOrigin：精确相等是唯一判据", () => {
  const headers = (origin?: string): Headers => {
    const h = new Headers();
    if (origin !== undefined) h.set("Origin", origin);
    return h;
  };

  it("Origin 与配置逐字节相等 → 通过", () => {
    expect(() => assertConsoleOrigin(headers(ORIGIN), ORIGIN)).not.toThrow();
  });

  it("缺 Origin header → AccessDeniedError", () => {
    expect(() => assertConsoleOrigin(headers(), ORIGIN)).toThrow(AccessDeniedError);
  });

  it("Origin 是字面量 \"null\"（不透明来源）→ 拒绝", () => {
    expect(() => assertConsoleOrigin(headers("null"), ORIGIN)).toThrow(AccessDeniedError);
  });

  it("别的 origin → 拒绝（不做前缀/后缀匹配）", () => {
    expect(() => assertConsoleOrigin(headers("https://evil.example.test"), ORIGIN)).toThrow(AccessDeniedError);
    expect(() => assertConsoleOrigin(headers(`https://evil.example.test/?${ORIGIN}`), ORIGIN)).toThrow(AccessDeniedError);
  });

  it("尾斜杠变体、不同端口、不同协议都拒绝——归一化只发生在配置侧，请求侧不宽容", () => {
    expect(() => assertConsoleOrigin(headers(`${ORIGIN}/`), ORIGIN)).toThrow(AccessDeniedError);
    expect(() => assertConsoleOrigin(headers(`${ORIGIN}:443`), ORIGIN)).toThrow(AccessDeniedError);
    expect(() => assertConsoleOrigin(headers("http://console.example.test"), ORIGIN)).toThrow(AccessDeniedError);
  });
});
