import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toToolError, redact, StateError } from "../src/errors.ts";
import { PathSecurityError } from "../src/paths.ts";
import { PolicyError } from "../src/policy.ts";
import { ProfileError, getProfile } from "../src/profiles.ts";
import { EditError } from "../src/repoFile.ts";
import { GitError } from "../src/worktree.ts";
import { SbplError } from "../src/sbpl.ts";
import { SandboxError } from "../src/sandbox.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";

describe("toToolError()", () => {
  it.each([
    [new PathSecurityError("PATH_ESCAPE", "x"), "POLICY_DENIED", false],
    [new PathSecurityError("INVALID_INPUT", "x"), "INVALID_INPUT", false],
    [new PathSecurityError("REPO_NOT_REGISTERED", "x"), "REPO_NOT_REGISTERED", false],
    [new PolicyError("POLICY_DENIED", "x"), "POLICY_DENIED", false],
    [new PolicyError("BAD_CONFIG", "x"), "POLICY_DENIED", false],
    [new EditError("STALE_FILE", "x"), "STALE_FILE", true],
    [new EditError("FILE_NOT_FOUND", "x"), "INVALID_INPUT", false],
    [new EditError("FILE_EXISTS", "x"), "INVALID_INPUT", false],
    [new ProfileError("PROFILE_NOT_FOUND", "x"), "PROFILE_NOT_FOUND", false],
    [new GitError("CANONICAL_BUSY", "x"), "CANONICAL_BUSY", true],
    [new GitError("GIT_FAILED", "x"), "INVALID_INPUT", false],
    [new GitError("WORKTREE_EXISTS", "x"), "INVALID_INPUT", false],
    // I-1a：KNOWN 此前没有 SbplError/SandboxError，两者均经由
    // startJob → runSandboxed 可达 grande_run，实测都降级成了 INTERNAL。
    [new SbplError("INVALID_INPUT", "x"), "INVALID_INPUT", false],
    [new SandboxError("PATH_SPELLING_MISMATCH", "x"), "POLICY_DENIED", false],
    // C-5：tasks.ts/jobs.ts 从裸 Error 迁到 StateError 之后新增的三行。
    [new StateError("TASK_NOT_FOUND", "x"), "TASK_NOT_FOUND", true],
    [new StateError("STALE_STATE", "x"), "INVALID_INPUT", true],
    [new StateError("JOB_NOT_FOUND", "x"), "INVALID_INPUT", false],
  ])("映射 %s", (err, code, retryable) => {
    const t = toToolError(err);
    expect(t.code).toBe(code);
    expect(t.retryable).toBe(retryable);
  });

  it("映射【不】靠解析 message：同一个码、message 完全不同，结果一致", () => {
    // 字符串会被改写、被本地化、被截断——契约必须建立在 .code 上
    const a = toToolError(new PathSecurityError("PATH_ESCAPE", "路径逃逸"));
    const b = toToolError(new PathSecurityError("PATH_ESCAPE", "完全不同的措辞 xyz"));
    expect(a.code).toBe(b.code);
  });

  it("message 里含另一个码的字样也不会串味", () => {
    const t = toToolError(new EditError("STALE_FILE", "这条消息里提到了 POLICY_DENIED 三个字"));
    expect(t.code).toBe("STALE_FILE");
  });

  it("未知异常降级为 INTERNAL 且【不】把原始 message 透给模型", () => {
    // 内部错误可能含路径、堆栈、配置片段——那些不该进对话
    const t = toToolError(new Error("ENOENT: /Users/someone/.ssh/id_rsa"));
    expect(t.code).toBe("INTERNAL");
    expect(t.message).not.toContain("id_rsa");
    expect(t.retryable).toBe(false);
  });

  it("非 Error 值也能安全处理", () => {
    for (const v of [undefined, null, "字符串", 42, { code: "POLICY_DENIED" }]) {
      expect(() => toToolError(v)).not.toThrow();
    }
    expect(toToolError({ code: "POLICY_DENIED" }).code).toBe("INTERNAL");
  });

  // C-5 的规格意义所在：§7.1 那张映射表是从 src/ 逐模块清点出来的。一行映射
  // 如果没有任何模块真的会抛，它就是在给一个不存在的契约做背书——
  // TASK_NOT_FOUND/JOB_NOT_FOUND 正是这么进来的：tasks.ts/jobs.ts 抛的是裸
  // Error，两行永远命不中，直到 Step 0 把它们迁到 StateError。
  it("MAP 里的每一行都有真实抛出方（没有到不了的表格行）", async () => {
    const { StateError } = await import("../src/errors.ts");
    for (const [code, e] of [
      ["TASK_NOT_FOUND", new StateError("TASK_NOT_FOUND", "x")],
      ["STALE_STATE",    new StateError("STALE_STATE", "x")],
      ["JOB_NOT_FOUND",  new StateError("JOB_NOT_FOUND", "x")],
    ] as const) {
      expect(toToolError(e).code, code).not.toBe("INTERNAL");
    }
  });

  // I-1c：redact() 是纯函数，脱离 toToolError() 单独可测——它不关心错误码，
  // 只做字符串替换。真正"哪些前缀算敏感"的决定权在调用方（Task 3 传
  // [layout.workspaceRoot, layout.controlRoot]）。
  it("redact() 替换掉给定的绝对路径前缀，不触碰其余内容", () => {
    const msg = redact(
      "仓库 /Users/x/ws/secret-project 不是工作区下的真实目录（名字合法不等于位置安全）",
      ["/Users/x/ws"],
    );
    expect(msg).not.toContain("/Users/x/ws");
    expect(msg).toContain("<workspace>/secret-project");
    expect(msg).toContain("名字合法不等于位置安全"); // 其余内容原样保留
  });

  describe("BUG 4：PROFILE_NOT_FOUND 里的可选 profile 列表必须完整穿过 toToolError", () => {
    let ws: string, ctrl: string, savedWs: string | undefined, savedCtrl: string | undefined;

    beforeEach(() => {
      savedWs = process.env.GRANDE_WORKSPACE;
      savedCtrl = process.env.GRANDE_CONTROL;
      ws = mkdtempSync(join(tmpdir(), "err-ws-"));
      ctrl = mkdtempSync(join(tmpdir(), "err-ctl-"));
      process.env.GRANDE_WORKSPACE = ws;
      process.env.GRANDE_CONTROL = ctrl;
    });
    afterEach(() => {
      if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
      if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
      rmSync(ws, { recursive: true, force: true });
      rmSync(ctrl, { recursive: true, force: true });
    });

    it("真实 getProfile() 抛出的 PROFILE_NOT_FOUND，其可用列表在 toToolError() 之后原样保留", () => {
      const l = loadLayout();
      ensureLayout(l);
      writeFileSync(
        join(l.configDir, "profiles.yaml"),
        'repos:\n  demo:\n    unit: { argv: ["a"], timeoutSeconds: 10 }\n    lint: { argv: ["b"], timeoutSeconds: 10 }\n',
        "utf8",
      );
      let caught: unknown;
      try {
        getProfile(l, "demo", "test"); // 模拟 BUG 4 的真实场景：模型猜错了名字
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      const t = toToolError(caught);
      expect(t.code).toBe("PROFILE_NOT_FOUND");
      // toToolError 只做 .code 映射、原样传递 message（不解析、不脱敏字符串内容）——
      // 脱敏是 tools.ts 的 wrap() 在拿到这个结果之后才做的下一步，且只替换
      // workspaceRoot/controlRoot 两个绝对路径前缀，不会动到 profile 名字。
      expect(t.message).toContain("unit");
      expect(t.message).toContain("lint");
    });
  });
});
