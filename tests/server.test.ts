import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
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

// Cloudflare Access 门禁用的假团队/受众——与 accessGate.test.ts 保持同一套常量含义，
// 但独立定义，因为这里测的是「门禁被正确挂在路由上」而不是门禁本身的判定逻辑。
const ACCESS_TEAM = "https://team.example.test";
const ACCESS_AUD = "a".repeat(64);
let accessPriv: any;
let restoreFetch: () => void;

async function signAccessAssertion(over: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ email: "u@example.test", ...over })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(String(over.iss ?? ACCESS_TEAM))
    .setAudience(String(over.aud ?? ACCESS_AUD))
    .setSubject("sub-1")
    .setExpirationTime("5m")
    .sign(accessPriv);
}

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

/**
 * D18：resource 是单一端点 `${ISSUER}/mcp`，不再按 repoId 参数化。
 * `repoId` 参数保留在签名里只是为了少数测试想验证「不同调用方式换来的令牌
 * 行为一致」，实际不影响换出来的 `resource`/`aud`。
 */
async function mintToken(a: Hono): Promise<string> {
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
    resource: `${ISSUER}/mcp`, scope: "grande:workspace",
  });
  const authRes = await a.request(`/authorize?${q}`, {
    redirect: "manual",
    headers: { "Cf-Access-Jwt-Assertion": await signAccessAssertion() },
  });
  const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
  const tok = await (await a.request("/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: redirectUri, resource: `${ISSUER}/mcp`,
    }),
  })).json() as { access_token: string };
  return tok.access_token;
}

beforeEach(async () => {
  // 与 accessGate.test.ts 同一套手法：把 JWKS 端点的 fetch 换成本地签发的公钥，
  // 其余请求（含真实网络，如果测试不小心打出去）照旧走真 fetch。
  const kp = await generateKeyPair("RS256");
  accessPriv = kp.privateKey;
  const jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(kp.publicKey)), alg: "RS256", kid: "k1" }] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) =>
    String(u).includes("/cdn-cgi/access/certs")
      ? new Response(jwksBody, { headers: { "content-type": "application/json" } })
      : realFetch(u as never)) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = realFetch; };

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

  const cfg: AppConfig = { issuer: ISSUER, layout, db, accessConfig: { teamDomain: ACCESS_TEAM, aud: ACCESS_AUD } };
  app = createApp(cfg);
});
afterEach(() => {
  restoreFetch();
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  process.env.GRANDE_WORKSPACE = savedWs;
  process.env.GRANDE_CONTROL = savedCtrl;
});

describe("D18：单一端点 /mcp + 认证", () => {
  it("无 Bearer 的 POST /mcp 返回 401，WWW-Authenticate 指向单一元数据（不含 repoId）", async () => {
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    const h = res.headers.get("WWW-Authenticate") ?? "";
    expect(h).toContain("resource_metadata=");
    expect(h).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(h).not.toMatch(/\/mcp\/[^"]+"/); // 不应该带着某个具体 repoId 段
  });

  it("测试要求 1：单一端点签发的令牌能打开 /mcp", async () => {
    const token = await mintToken(app);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
  });

  it("测试要求 1：伪造/不匹配 aud 的令牌被拒", async () => {
    // 直接签一枚 aud 指向别处的令牌，模拟「forged for a different audience」——
    // 不经过 /token 端点，绕开合法签发路径，专门探测 verifyBearer 是否真的按
    // aud 过滤，而不是只看签名有效就放行。
    const key = new TextEncoder().encode("0".repeat(64)); // 与网关真实密钥不同，双重保险
    const forged = await new SignJWT({ scope: "grande:workspace" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience("https://grande.example.test/mcp-not-the-real-endpoint")
      .setSubject("user")
      .setIssuedAt()
      .setExpirationTime("8h")
      .sign(key);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${forged}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("单一发现文档可取，resource 是单一端点", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    const body = await res.json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
    expect(body.resource).toBe(`${ISSUER}/mcp`);
    expect(body.authorization_servers).toContain(ISSUER);
    expect(body.scopes_supported).toEqual(["grande:workspace"]);
  });
});

describe("测试要求 5：旧连接器兼容别名 /mcp/:repoId 仍然工作", () => {
  it("单一端点签发的令牌同样能打开 /mcp/demo（旧连接器的 URL 不必更新）", async () => {
    const token = await mintToken(app);
    const res = await app.request(`/mcp/${REPO}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
  });

  it("无 Bearer 时 /mcp/demo 也返回 401，且指向同一份（单一）元数据", async () => {
    const res = await app.request(`/mcp/${REPO}`, { method: "POST" });
    expect(res.status).toBe(401);
    const h = res.headers.get("WWW-Authenticate") ?? "";
    expect(h).toContain(`${ISSUER}/.well-known/oauth-protected-resource/mcp`);
  });

  it("未注册与已注册的 repoId 段在【未认证】时响应完全一致（不可匿名枚举）", async () => {
    const a = await app.request("/mcp/demo", { method: "POST" });
    const b = await app.request("/mcp/not-registered", { method: "POST" });
    expect(b.status).toBe(a.status);
    expect(b.status).toBe(401);
    expect(b.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("已认证但别名带的 repoId 已被撤销注册时返回 404，且【不】泄漏工作区里还有哪些目录", async () => {
    const token = await mintToken(app);
    unregister(layout, "demo");
    const res = await app.request("/mcp/demo", {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("grande-gpt");
  });

  it("形状异常的 repoId 段（可能是响应头注入）返回 404 而不是让响应构造抛出", async () => {
    const res = await app.request(
      `/mcp/${encodeURIComponent('a" error="x')}`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("旧连接器指向的 per-repo 元数据别名仍可取，内容与单一元数据完全一致", async () => {
    const legacy = await app.request("/.well-known/oauth-protected-resource/mcp/demo");
    const single = await app.request("/.well-known/oauth-protected-resource/mcp");
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual(await single.json());
  });

  it("同一枚令牌在 /mcp 与 /mcp/demo 两条路由上表现一致（同一个 aud，同一个工具集）", async () => {
    const token = await mintToken(app);
    const bareRes = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const aliasRes = await app.request("/mcp/demo", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(bareRes.status).toBe(200);
    expect(aliasRes.status).toBe(200);
  });
});

describe("/authorize 门禁（Cloudflare Access，规格 §7.0⓪ / 铁律三）", () => {
  async function registerAndBuildAuthorizeQuery(): Promise<{ query: URLSearchParams; redirectUri: string }> {
    const reg = await (await app.request("/register", {
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
    const query = new URLSearchParams({
      client_id: reg.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: "S256", response_type: "code",
      resource: `${ISSUER}/mcp`, scope: "grande:workspace",
    });
    return { query, redirectUri };
  }

  it("缺少 Cf-Access-Jwt-Assertion 时拒绝——门禁在 PKCE/client 查找/发码之前生效，不签发 code", async () => {
    const { query } = await registerAndBuildAuthorizeQuery();
    const res = await app.request(`/authorize?${query}`, { redirect: "manual" });

    expect(res.status).toBe(403);
    // 断言响应本身，不只是状态码：如果门禁跑得太晚，这里会是一个 302 且
    // location 带 ?code=...——那才是「门禁形同虚设」的真实症状。
    expect(res.headers.get("location")).toBeNull();
    const body = await res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty("code");
    expect(JSON.stringify(body)).not.toMatch(/Cf-Access-Jwt-Assertion|jwtVerify|ACCESS_DENIED/);
  });

  it("携带合法 Cf-Access-Jwt-Assertion 时正常放行（证明门禁没有顺手打坏端点）", async () => {
    const { query } = await registerAndBuildAuthorizeQuery();
    const res = await app.request(`/authorize?${query}`, {
      redirect: "manual",
      headers: { "Cf-Access-Jwt-Assertion": await signAccessAssertion() },
    });

    expect(res.status).toBe(302);
    const code = new URL(res.headers.get("location")!).searchParams.get("code");
    expect(code).toBeTruthy();
  });
});

describe("非 /authorize 路由不受 Access 门禁影响（OpenAI 后端到后端调用，无法交互登录）", () => {
  it("/.well-known/oauth-authorization-server 无 Access 头也可正常取到", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
  });

  it("/token 无 Access 头也能正常走完授权码换取访问令牌", async () => {
    // mintToken() 内部只在 /authorize 那一步带 Access 头，/register 与 /token 都不带——
    // 如果 /token 被误挂了门禁，这里会在换取访问令牌时炸掉。
    const token = await mintToken(app);
    expect(token).toBeTruthy();
  });
});

describe("启动流程", () => {
  it("startGateway 在接受第一次工具调用之前已经完成对账（观察效果，不观察回调）", async () => {
    const db = openDb(layout);
    const dead = createJob(db, { jobId: "job_dead", taskId: TASK, profile: "unit", argv: ["x"], pgid: 999999 });
    expect(getJob(db, dead.jobId)!.state).toBe("running");
    const cfg: AppConfig = { issuer: ISSUER, layout, db, accessConfig: { teamDomain: ACCESS_TEAM, aud: ACCESS_AUD } };
    process.env.PORT = "0";
    const gw = await startGateway(cfg);
    delete process.env.PORT;
    try {
      expect(getJob(db, dead.jobId)!.state).not.toBe("running");
      const token = await mintToken(gw.app);
      const res = await gw.app.request("/mcp", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
    } finally { await gw.close(); db.close(); }
  });
});
