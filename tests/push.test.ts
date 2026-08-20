import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { basicCredential, redactToken } from "../src/githubAuth.ts";
import { githubGitArgv } from "../src/push.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, type ToolDeps } from "../src/tools.ts";

const safeGit = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const rawGit = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  args,
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

let ws: string;
let ctrl: string;
let layout: Layout;
let canonical: string;
let worktree: string;
let remote: string;
let deps: ToolDeps;
const taskId = "task_push";
const branch = "grande/push-test";
const token = "github_pat_push_test_abcdefghijklmnopqrstuvwxyz";

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "push-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "push-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(join(layout.controlRoot, "secrets", "github-token"), `${token}\n`, { mode: 0o600 });

  canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  safeGit(canonical, "init", "-q", "-b", "main");
  safeGit(canonical, "-c", "user.name=Human", "-c", "user.email=human@example.com", "commit", "--allow-empty", "-q", "-m", "init");
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");

  remote = join(rootOf(ws), "fake-remote.git");
  mkdirSync(remote, { recursive: true });
  safeGit(remote, "init", "--bare", "-q", "-b", "main");
  safeGit(canonical, "remote", "add", "origin", remote);
  safeGit(canonical, "push", "-q", "origin", "main:main");

  worktree = join(layout.worktreesRoot, "demo", taskId);
  mkdirSync(join(layout.worktreesRoot, "demo"), { recursive: true });
  safeGit(canonical, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");
  const db = openDb(layout);
  createTask(db, {
    taskId,
    repoId: "demo",
    branch,
    baseCommit: safeGit(canonical, "rev-parse", "HEAD").trim(),
    worktreePath: worktree,
    state: "READY",
  });
  deps = { db, layout, defaultRepoId: "demo" };
});

afterEach(() => {
  deps.db.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  rmSync(remote, { recursive: true, force: true });
});

function rootOf(path: string): string {
  return join(path, "..");
}

function commitTaskChange(): string {
  writeFileSync(join(worktree, "change.txt"), `${Date.now()}\n`, "utf8");
  safeGit(worktree, "add", "change.txt");
  safeGit(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "task change");
  return safeGit(worktree, "rev-parse", "HEAD").trim();
}

async function callPush(id = taskId): Promise<Record<string, unknown>> {
  const tool = buildTools(deps).find((candidate) => candidate.name === "grande_push");
  if (!tool) throw new Error("grande_push 未注册");
  return (await tool.handler({ taskId: id })).structuredContent as Record<string, unknown>;
}

function remoteBranches(): string[] {
  const text = safeGit(remote, "for-each-ref", "--format=%(refname)", "refs/heads").trim();
  return text ? text.split("\n") : [];
}

describe("grande_push", () => {
  it("AC-S3-4：push 后 bare 仓库任务分支 sha 等于 worktree HEAD，且 token 未落入 local config", async () => {
    const head = commitTaskChange();
    const result = await callPush();
    expect(result.ok).toBe(true);
    expect(safeGit(remote, "rev-parse", `refs/heads/${branch}`).trim()).toBe(head);
    const localConfig = rawGit(worktree, "config", "--local", "--list");
    expect(localConfig).not.toContain(token);
    expect(localConfig).not.toMatch(/http\.extraheader/i);
  });

  it("AC-S3-5a：非 grande/* 分支硬拒绝，bare refs 完全不变", async () => {
    deps.db.prepare("UPDATE task SET branch='production' WHERE taskId=?").run(taskId);
    safeGit(worktree, "switch", "-q", "-c", "production");
    commitTaskChange();
    const before = remoteBranches();

    const result = await callPush();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/grande\/\*/);
    expect(remoteBranches()).toEqual(before);
    expect(remoteBranches()).not.toContain("refs/heads/production");
  });

  it("AC-S3-5b：即使匹配 grande/*，等于 remote 默认分支仍拒绝", async () => {
    safeGit(remote, "symbolic-ref", "HEAD", "refs/heads/grande/main");
    safeGit(remote, "update-ref", "refs/heads/grande/main", safeGit(canonical, "rev-parse", "HEAD").trim());
    deps.db.prepare("UPDATE task SET branch='grande/main' WHERE taskId=?").run(taskId);
    safeGit(worktree, "switch", "-q", "-c", "grande/main");
    commitTaskChange();

    const before = safeGit(remote, "rev-parse", "refs/heads/grande/main").trim();
    const result = await callPush();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/默认分支/);
    expect(safeGit(remote, "rev-parse", "refs/heads/grande/main").trim()).toBe(before);
  });

  it("AC-S3-6：任务分支没有自己的 commit 时拒绝并提示先 grande_commit", async () => {
    const result = await callPush();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/grande_commit|至少一个 commit/);
  });

  it("worktree 已切到其他分支时拒绝，不能回报一个 HEAD 却推送另一个 task ref", async () => {
    commitTaskChange();
    safeGit(worktree, "switch", "-q", "-c", "grande/wrong-branch");
    writeFileSync(join(worktree, "wrong.txt"), "wrong\n", "utf8");
    safeGit(worktree, "add", "wrong.txt");
    safeGit(worktree, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", "wrong branch");

    const result = await callPush();

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/grande\/push-test|分支|branch/);
    expect(remoteBranches()).not.toContain(`refs/heads/${branch}`);
  });

  it("AC-S3-7：没有 origin remote 时拒绝并说清", async () => {
    commitTaskChange();
    safeGit(worktree, "remote", "remove", "origin");
    const result = await callPush();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toMatch(/origin|remote/);
  });

  it("AC-S3-13：统一 argv 同时禁 hooks、清空 ambient credential helper，并只临时传 token", () => {
    const argv = githubGitArgv(["ls-remote", "--symref", "origin", "HEAD"], token);
    expect(argv).toEqual([
      "-c", "core.hooksPath=/dev/null",
      "-c", "credential.helper=",
      "-c", `http.extraHeader=Authorization: Basic ${basicCredential(token)}`,
      "ls-remote", "--symref", "origin", "HEAD",
    ]);
  });

  it("AC-S3-13b：认证方案必须是 Basic —— Bearer 在 git-over-HTTPS 上一律失败", () => {
    // ⚠️ 这条**不能**证明 GitHub 接受我们的认证（本套件推的是本地 bare 仓库，
    // 无需认证、Authorization 头被完全忽略）。它只把实测判决钉住，防止有人
    // 「顺手统一成 Bearer」——REST API 那边 Bearer 确实是对的，所以这个改动
    // 看起来非常合理，而后果是 push 静默地永远失败。
    // 真实连通性判据只能在宿主上手工验，记录见 docs/research/。
    const header = githubGitArgv([], token).find((a) => a.startsWith("http.extraHeader="))!;
    expect(header).not.toContain("Bearer");
    expect(header).toContain("Basic ");
    // base64 必须解得回 GitHub 要求的 `x-access-token:<PAT>` 形态
    const b64 = header.slice(header.indexOf("Basic ") + "Basic ".length);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(`x-access-token:${token}`);
  });

  it("脱敏必须同时抹掉 base64 凭据 —— 它解一次就是明文 PAT", () => {
    const b64 = basicCredential(token);
    // 模拟 git 回显了整条 http.extraHeader（GIT_TRACE / GIT_CURL_VERBOSE 会这样）
    const leaked = `fatal: unable to access: http.extraHeader=Authorization: Basic ${b64}`;
    const cleaned = redactToken(leaked, token);
    expect(cleaned).not.toContain(b64);
    // 前缀也要抹：base64 按 3 字节一组编码，截断的前缀仍能解出 token 前半段
    expect(cleaned).not.toContain(b64.slice(0, 40));
    expect(cleaned).toContain("<redacted>");
  });

  it("AC-S3-8：pre-push hook 不执行（沙箱内为已知假阴性，需宿主复验）", async () => {
    commitTaskChange();
    const hooksDir = join(worktree, ".githooks");
    const marker = join(ctrl, "pre-push-ran");
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, "pre-push");
    writeFileSync(hook, `#!/bin/sh\nprintf escaped > ${JSON.stringify(marker)}\n`, "utf8");
    chmodSync(hook, 0o755);
    rawGit(worktree, "config", "core.hooksPath", hooksDir);

    const result = await callPush();
    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("成功 push 写入审计账本", async () => {
    commitTaskChange();
    expect((await callPush()).ok).toBe(true);
    const row = listAudit(deps.db, taskId).find((candidate) => candidate.tool === "grande_push");
    expect(row?.decision).toBe("ALLOWED");
    expect(row?.state).toBe("SUCCEEDED");
    expect(row?.pathsTouched).toContain(worktree);
  });

  it("AC-S3-12：grande_push 打开网络面，task_open fetch 计入后有 14 个本地工具禁网", () => {
    const tools = buildTools(deps);
    expect(tools.find((candidate) => candidate.name === "grande_push")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools.filter((candidate) => candidate.annotations.openWorldHint === false)).toHaveLength(14);
  });
});
