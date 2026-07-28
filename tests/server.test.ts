import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { createJob, getJob } from "../src/jobs.ts";
import { createTask } from "../src/tasks.ts";
import { loadRegistry, saveRegistry } from "../src/registry.ts";
import type { AppConfig } from "../src/server.ts";
import { createApp, startGateway } from "../src/server.ts";

let ws: string, ctrl: string, layout: Layout, app: Hono;
let savedWs: string | undefined, savedCtrl: string | undefined;
const ISSUER = "https://grande.example.test";
const REPO = "demo";
const TASK = "task_abcd";

const g = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function unregister(l: Layout, id: string) {
  const m = loadRegistry(l);
  const e = m.get(id);
  if (e) {
    e.registered = false;
    m.set(id, e);
    saveRegistry(l, m.values());
  }
}

async function mintToken(a: Hono, repoId: string): Promise<string> {
  const reg = await (await a.request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test", redirect_uris: ["https://chatgpt.com/connector/oauth/x"],
      grant_types: ["authorization_code"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  })).json() as { client_id: string; redirect_uris: string[] };
  const redirectUri = reg.redirect_uris[0]!;
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: reg.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", response_type: "code",
    resource: `${ISSUER}/mcp/${repoId}`, scope: `grande:repo:${repoId}`,
  });
  const authRes = await a.request(`/authorize?${q}`, { redirect: "manual" });
  const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
  const tok = await (await a.request("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: redirectUri, resource: `${ISSUER}/mcp/${repoId}`,
    }),
  })).json() as { access_token: string };
  return tok.access_token;
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "srv-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "srv-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  const db = openDb(layout);

  const repo = join(layout.workspaceRoot, "demo");
  mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  g(repo, "config", "user.email", "t@example.com");
  g(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "a.ts"), "v1\n", "utf8");
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");

  const other = join(layout.workspaceRoot, "other");
  mkdirSync(other, { recursive: true });
  g(other, "init", "-q", "-b", "main");
  g(other, "config", "user.email", "t@example.com");
  g(other, "config", "user.name", "T");
  writeFileSync(join(other, "b.ts"), "v2\n", "utf8");
  g(other, "add", ".");
  g(other, "commit", "-q", "-m", "init");

  writeFileSync(layout.reposConfig,
    `repos:\n  - repoId: demo\n    registered: true\n  - repoId: other\n    registered: true\n`, "utf8");

  const wt = join(layout.worktreesRoot, "demo", TASK);
  mkdirSync(wt, { recursive: true });
  g(repo, "worktree", "add", "-b", "grande/x-abcd", wt, g(repo, "rev-parse", "HEAD").trim());

  createTask(db, {
    taskId: TASK, repoId: "demo", branch: "grande/x-abcd",
    baseCommit: g(repo, "rev-parse", "HEAD").trim(), worktreePath: wt, state: "READY",
  });
  writeFileSync(
    join(layout.configDir, "profiles.yaml"),
    "repos:\n  demo:\n    unit: { argv: [\"/bin/sh\", \"-c\", \"echo ok; exit 0\"], timeoutSeconds: 30 }\n",
    "utf8",
  );

  const cfg: AppConfig = { issuer: ISSUER, layout, db };
  app = createApp(cfg);
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

describe("每-repo 端点与认证", () => {
  it("已注册 repoId 无 Bearer 的 POST 返回 401，且 WWW-Authenticate 指向【每-repo】元数据", async () => {
    const res = await app.request("/mcp/demo", { method: "POST" });
    expect(res.status).toBe(401);
    const h = res.headers.get("WWW-Authenticate") ?? "";
    expect(h).toContain("resource_metadata=");
    expect(h).toContain("/.well-known/oauth-protected-resource/mcp/demo");
  });

  it("未注册与已注册的 repoId 在【未认证】时响应完全一致（不可匿名枚举）", async () => {
    const a = await app.request("/mcp/demo", { method: "POST" });
    const b = await app.request("/mcp/not-registered", { method: "POST" });
    expect(b.status).toBe(a.status);
    expect(b.status).toBe(401);
    expect(b.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("已认证但 repoId 已被撤销注册时返回 404，且【不】泄漏工作区里还有哪些目录", async () => {
    const token = await mintToken(app, "demo");
    unregister(layout, "demo");
    const res = await app.request("/mcp/demo", {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("grande-gpt");
  });

  it("用 demo 的令牌打 other 端点被拒（D5）", async () => {
    const token = await mintToken(app, "demo");
    const res = await app.request("/mcp/other", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("每-repo 的发现文档可取，且 resource 是该 repo 自己的端点", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource/mcp/demo");
    expect(res.status).toBe(200);
    const body = await res.json() as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(`${ISSUER}/mcp/demo`);
    expect(body.authorization_servers).toContain(ISSUER);
  });

  it("形状异常的 repoId 段（可能是响应头注入）返回 404 而不是让响应构造抛出", async () => {
    const res = await app.request(
      `/mcp/${encodeURIComponent('a" error="x')}`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});

describe("启动流程", () => {
  it("startGateway 在接受第一次工具调用之前已经完成对账（观察效果，不观察回调）", async () => {
    const db = openDb(layout);
    const dead = createJob(db, { jobId: "job_dead", taskId: TASK, profile: "unit", argv: ["x"], pgid: 999999 });
    expect(getJob(db, dead.jobId)!.state).toBe("running");
    const cfg: AppConfig = { issuer: ISSUER, layout, db };
    process.env.PORT = "0";
    const gw = await startGateway(cfg);
    delete process.env.PORT;
    try {
      expect(getJob(db, dead.jobId)!.state).not.toBe("running");
      const token = await mintToken(gw.app, REPO);
      const res = await gw.app.request(`/mcp/${REPO}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
    } finally { await gw.close(); db.close(); }
  });
});
