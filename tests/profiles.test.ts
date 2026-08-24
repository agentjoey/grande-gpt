import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { getProfile, loadDepDirs, loadProfiles } from "../src/profiles.ts";

let ws: string, ctrl: string, savedWs: string | undefined, savedCtrl: string | undefined;

function writeConfig(body: string) {
  const l = loadLayout();
  ensureLayout(l);
  writeFileSync(join(l.configDir, "profiles.yaml"), body, "utf8");
  return l;
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "prof-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "prof-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});
afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("loadProfiles()", () => {
  it("按 repoId 加载该仓库的 profile", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300 }\n');
    const m = loadProfiles(l, "demo");
    expect(m.get("unit")?.argv).toEqual(["pnpm", "test"]);
    expect(m.get("unit")?.timeoutSeconds).toBe(300);
    expect(m.get("unit")?.name).toBe("unit");
  });

  it("maxOutputBytes 与 maxRssMb 省略时落回默认值", () => {
    // I-3：maxRssMb 此前根本不存在于 RunProfile，RSS 轮询兜底因此永远拿不到
    // 上限、RESOURCE_EXHAUSTED 这条路径不可达（实测复现）。
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300 }\n');
    const p = loadProfiles(l, "demo").get("unit")!;
    expect(p.maxOutputBytes).toBeGreaterThan(0);
    expect(p.maxRssMb).toBeGreaterThan(0);
  });

  it("只接受受控 darwin-clang toolchain 枚举，普通 profile 默认没有 toolchain 权限", () => {
    const l = writeConfig(
      'repos:\n  demo:\n' +
      '    native: { argv: ["pnpm", "test"], timeoutSeconds: 300, toolchain: "darwin-clang" }\n' +
      '    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300 }\n',
    );
    const profiles = loadProfiles(l, "demo");
    expect(profiles.get("native")?.toolchain).toBe("darwin-clang");
    expect(profiles.get("unit")?.toolchain).toBeUndefined();
  });

  it("拒绝任意/未知 toolchain 名称，避免配置退化成 generic host toolchain escape hatch", () => {
    const l = writeConfig(
      'repos:\n  demo:\n    native: { argv: ["pnpm", "test"], timeoutSeconds: 300, toolchain: "arbitrary-host" }\n',
    );
    expect(() => loadProfiles(l, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("仓库之间互不可见：demo 的 profile 不会出现在 other 里", () => {
    // 这一条不是形式主义——两个仓库共用一份配置文件，若按 repoId 过滤写错，
    // 一个仓库就能跑另一个仓库注册的命令。
    const l = writeConfig(
      'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n' +
      '  other:\n    build: { argv: ["b"], timeoutSeconds: 10 }\n',
    );
    expect([...loadProfiles(l, "demo").keys()]).toEqual(["unit"]);
    expect([...loadProfiles(l, "other").keys()]).toEqual(["build"]);
  });

  it("配置文件不存在时返回空表，而不是抛错", () => {
    const l = loadLayout();
    ensureLayout(l);
    expect(loadProfiles(l, "demo").size).toBe(0);
  });

  it.each([
    ['repos:\n  demo:\n    unit: { argv: "pnpm test", timeoutSeconds: 10 }\n', "argv 必须是数组（字符串会被当成 shell 拼接，铁律二禁止）"],
    ['repos:\n  demo:\n    unit: { argv: [], timeoutSeconds: 10 }\n', "argv 不能为空"],
    ['repos:\n  demo:\n    unit: { argv: ["a", 1], timeoutSeconds: 10 }\n', "argv 每一项必须是字符串"],
    ['repos:\n  demo:\n    unit: { argv: ["a"] }\n', "缺 timeoutSeconds"],
    ['repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 0 }\n', "timeoutSeconds 必须为正"],
    ['repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 99999 }\n', "timeoutSeconds 超过上限"],
    ['repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10, maxRssMb: -1 }\n', "maxRssMb 必须为正"],
    ['repos: 42\n', "repos 必须是映射"],
  ])("非法配置响亮地失败：%s", (body) => {
    const l = writeConfig(body);
    expect(() => loadProfiles(l, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("绝不从仓库内读（铁律一）：仓库里放同名文件不产生任何影响", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["real"], timeoutSeconds: 10 }\n');
    const repo = join(l.workspaceRoot, "demo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "profiles.yaml"), 'repos:\n  demo:\n    evil: { argv: ["curl"], timeoutSeconds: 10 }\n', "utf8");
    const m = loadProfiles(l, "demo");
    expect(m.has("evil")).toBe(false);
    expect(m.get("unit")?.argv).toEqual(["real"]);
  });
});

describe("getProfile()", () => {
  it("未注册的 profile 抛 PROFILE_NOT_FOUND，且错误信息列出可用项", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n    lint: { argv: ["b"], timeoutSeconds: 10 }\n');
    try {
      getProfile(l, "demo", "nope");
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as { code: string }).code).toBe("PROFILE_NOT_FOUND");
      // 干巴巴报错对模型没用——它需要知道能选什么
      expect((e as Error).message).toContain("unit");
      expect((e as Error).message).toContain("lint");
    }
  });

  it("已注册的 profile 正常返回", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n');
    expect(getProfile(l, "demo", "unit").argv).toEqual(["a"]);
  });
});

describe("loadDepDirs()", () => {
  it("未声明 depDirs 时返回空数组", () => {
    const l = writeConfig('repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n');
    expect(loadDepDirs(l, "demo")).toEqual([]);
  });

  it("按 repoId 返回声明的目录列表", () => {
    const l = writeConfig(
      'depDirs:\n  demo: ["node_modules"]\n' +
      'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
    );
    expect(loadDepDirs(l, "demo")).toEqual(["node_modules"]);
  });

  it("depDirs 不是字符串数组时响亮失败", () => {
    const l = writeConfig(
      'depDirs:\n  demo: "node_modules"\n' +
      'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
    );
    expect(() => loadDepDirs(l, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("depDirs 是独立命名空间，不会被 loadProfiles 当成一个 profile（否则会报一个跟真实错误无关的 BAD_CONFIG）", () => {
    const l = writeConfig(
      'depDirs:\n  demo: ["node_modules"]\n' +
      'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n',
    );
    expect([...loadProfiles(l, "demo").keys()]).toEqual(["unit"]);
  });
});
