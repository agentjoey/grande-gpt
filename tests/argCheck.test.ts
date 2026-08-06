import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { buildTools, type ToolDef, type ToolDeps } from "../src/tools.ts";

/**
 * 遗留表 #13：schema 校验失败折叠成 `INTERNAL`。
 *
 * 原文：「把 `ops` 写成 `edits` 得到的是『Gateway 内部错误。详情见服务端日志。』
 * **模型看不到服务端日志，撞上这个错完全无从下手。**」
 *
 * 下面第一条测试就是那个复现，逐字钉住它现在的行为。
 */

let ws: string, ctrl: string, layout: Layout, deps: ToolDeps;
let savedWs: string | undefined, savedCtrl: string | undefined;

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "argck-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "argck-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  const db = openDb(layout);

  const repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.ts"), "export const x = 1;\n", "utf8");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");

  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
  deps = { db, layout, defaultRepoId: undefined };
});

afterEach(() => {
  deps.db.close();
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

const tool = (name: string): ToolDef => buildTools(deps).find((t) => t.name === name)!;

/** 跑一次工具，取出错误信封。 */
async function callErr(name: string, args: Record<string, unknown>) {
  const r = await tool(name).handler(args);
  const sc = r.structuredContent as { ok: boolean; error?: { code: string; message: string } };
  expect(sc.ok).toBe(false);
  return sc.error!;
}

describe("遗留 #13：参数错误必须点名字段，不能折叠成 INTERNAL", () => {
  it("把 ops 写成 edits —— 【原始复现】", async () => {
    const e = await callErr("grande_repo_edit", { taskId: "task-demo-x-001", edits: [] });

    // ① 分类正确。撞上 INTERNAL 时模型只能放弃或瞎试。
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.code).not.toBe("INTERNAL");

    // ② 【点名字段】——这是 #13 的核心诉求。两边都要说：
    //    只说「缺 ops」会让人以为是漏传，只说「不认识 edits」看不出该改成什么。
    expect(e.message).toContain("ops");
    expect(e.message).toContain("edits");

    // ③ 绝不出现那句让模型无从下手的话。
    expect(e.message).not.toContain("详情见服务端日志");
  });

  it("缺必填参数时，把该工具接受的参数【全列出来】", async () => {
    const e = await callErr("grande_repo_edit", {});
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain("taskId");
    expect(e.message).toContain("ops");
  });

  it("顶层类型不对时说清期望与实际", async () => {
    const e = await callErr("grande_repo_edit", { taskId: "t", ops: "not-an-array" });
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain("ops");
    expect(e.message).toContain("array");
    expect(e.message).toContain("string");
  });

  it("校验在【任何副作用之前】——参数错时不碰库、不建 worktree", async () => {
    // task_open 是有副作用的工具。给它一个多余字段：
    // 如果校验发生在 handler 内部而不是之前，worktree 可能已经建出来了。
    const before = deps.db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number };
    const e = await callErr("grande_task_open", { repoId: "demo", titl: "typo" });
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain("titl");
    const after = deps.db.prepare("SELECT COUNT(*) AS n FROM task").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("不能矫枉过正——合法调用必须原样通过", () => {
  it("只给必填参数（可选参数全省略）不被拒", async () => {
    // 这条是防过度拒绝的兜底：把「非必填且未提供」误判成缺失，
    // 会让绝大多数正常调用直接失效，而那比 #13 本身严重得多。
    const r = await tool("grande_task_status").handler({});
    expect((r.structuredContent as { ok: boolean }).ok).toBe(true);
  });

  it("参数错误【不】被标成可重试——重试一万次也还是同样的错", async () => {
    const e = await callErr("grande_repo_edit", { taskId: "t", edits: [] });
    const r = await tool("grande_repo_edit").handler({ taskId: "t", edits: [] });
    const sc = r.structuredContent as { error: { retryable: boolean } };
    expect(e.code).toBe("INVALID_INPUT");
    expect(sc.error.retryable).toBe(false);
  });
});

describe("覆盖面：每个工具都受校验保护", () => {
  it("全部工具对一个不存在的参数名都返回 INVALID_INPUT", async () => {
    // 这是 P-A「模块写好但没接上线」的机械探针：遍历生产工具表，
    // 而不是抽查几个。将来新增工具若绕过 buildTools 的包装，这里会红。
    const failures: string[] = [];
    for (const t of buildTools(deps)) {
      const r = await t.handler({ __definitely_not_a_real_param__: 1 });
      const sc = r.structuredContent as { ok: boolean; error?: { code: string; message: string } };
      if (sc.ok !== false || sc.error?.code !== "INVALID_INPUT" ||
          !sc.error.message.includes("__definitely_not_a_real_param__")) {
        failures.push(`${t.name} → ${sc.error?.code ?? "ok"}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
