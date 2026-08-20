import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { openDb } from "../src/db.ts";
import { bumpEpoch, currentEpoch } from "../src/tokenEpoch.ts";
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
  return (await mintTokenFull(a)).access_token;
}

/** 与 `mintToken` 同一条真实流程，但把 refresh_token 与 client_id 也带出来。 */
async function mintTokenFull(a: Hono): Promise<{
  access_token: string; refresh_token?: string; client_id: string;
}> {
  const reg = await (await a.request("/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "test", redirect_uris: ["https://chatgpt.com/connector/oauth/x"],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  })).json() as { client_id: string; redirect_uris: string[] };
  const redirectUri = reg.redirect_uris[0]!;
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({
    client_id: reg.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: "S256", response_type: "code",
    resource: `${ISSUER}/mcp`, scope: "grande:workspace offline_access",
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
  })).json() as { access_token: string; refresh_token?: string };
  return { ...tok, client_id: reg.client_id };
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

  it("无效 Bearer 仍只返回 401，但服务端留下不含凭据的拒绝类别", async () => {
    const secretBearer = "must-not-appear-in-logs";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
    try {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${secretBearer}` },
      });
      expect(res.status).toBe(401);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual(["[auth] /mcp denied reason=invalid_bearer"]);
    expect(warnings.join("\n")).not.toContain(secretBearer);
  });

  it("无效 refresh_token 返回原有 OAuth 错误，并记录不含凭据的拒绝类别", async () => {
    const secretRefreshToken = "must-not-appear-in-token-log";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
    try {
      const res = await app.request("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: secretRefreshToken,
        }).toString(),
      });
      expect(res.status).toBe(400);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual(["[auth] /token denied grant=refresh_token error=invalid_grant"]);
    expect(warnings.join("\n")).not.toContain(secretRefreshToken);
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

  it("现代 ChatGPT 的 server/discover 得到可确定性降级的协议错误，而不是 SDK 的通用 400", async () => {
    // ChatGPT 当前会先用 MCP 2026-07-28 的标准 discover 请求探测端点。Gateway
    // 仍是 2025-era server 时，正确行为不是把这条请求交给旧 SDK 产生 -32000，
    // 而是明确告诉客户端可回退到哪个 legacy protocol version。
    const token = await mintToken(app);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "openai-mcp-discover",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "ChatGPT", version: "test" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as {
      jsonrpc?: string;
      id?: unknown;
      error?: { code?: number; message?: string; data?: { requested?: string; supported?: string[] } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe("openai-mcp-discover");
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.message).toBe("Unsupported protocol version");
    expect(body.error?.data?.requested).toBe("2026-07-28");
    expect(body.error?.data?.supported).toContain("2025-11-25");
  });

  it("modern discover 明示回退版本后，legacy initialize → tools/list 可完整继续", async () => {
    const token = await mintToken(app);
    const discovery = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-then-legacy",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const discovered = await discovery.json() as { error?: { data?: { supported?: string[] } } };
    expect(discovery.status).toBe(400);
    expect(discovered.error?.data?.supported).toContain("2025-11-25");

    const legacyHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    };
    const initialized = await app.request("/mcp", {
      method: "POST",
      headers: legacyHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "ChatGPT", version: "test" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain("2025-11-25");

    const listed = await app.request("/mcp", {
      method: "POST",
      headers: legacyHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain("grande_task_status");
  });

  it("现代 discover 的 Mcp-Method 与 body 不一致时返回 HeaderMismatch，而不进入 legacy fallback", async () => {
    const token = await mintToken(app);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mismatch-method",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { id?: unknown; error?: { code?: number } };
    expect(body.id).toBe("mismatch-method");
    expect(body.error?.code).toBe(-32020);
  });

  it("现代 discover 缺少必需 Mcp-Method 时返回 HeaderMismatch，而不进入 legacy fallback", async () => {
    const token = await mintToken(app);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "missing-method",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { id?: unknown; error?: { code?: number } };
    expect(body.id).toBe("missing-method");
    expect(body.error?.code).toBe(-32020);
  });

  it("现代 discover 的 protocol header 与 _meta 不一致时返回 HeaderMismatch，而不进入 legacy fallback", async () => {
    const token = await mintToken(app);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "mismatch-version",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2025-11-25",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { id?: unknown; error?: { code?: number } };
    expect(body.id).toBe("mismatch-version");
    expect(body.error?.code).toBe(-32020);
  });

  it("现代 discover 缺少必需 clientCapabilities 时返回 Invalid params，而不进入 legacy fallback", async () => {
    const token = await mintToken(app);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "missing-capabilities",
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { id?: unknown; error?: { code?: number } };
    expect(body.id).toBe("missing-capabilities");
    expect(body.error?.code).toBe(-32602);
  });

  it("现代 discover 缺少必需 protocolVersion metadata 时返回 Invalid params，而不进入 legacy fallback", async () => {
    const token = await mintToken(app);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "missing-version",
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { id?: unknown; error?: { code?: number } };
    expect(body.id).toBe("missing-version");
    expect(body.error?.code).toBe(-32602);
  });

  it("现代 discover 保留合法的数值和 null JSON-RPC id", async () => {
    const token = await mintToken(app);
    for (const id of [42, null]) {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { id?: unknown; error?: { code?: number } };
      expect(body.id).toBe(id);
      expect(body.error?.code).toBe(-32022);
    }
  });

  it("现代 discover 的降级会留下不含 bearer 的协议追踪日志", async () => {
    const token = await mintToken(app);
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(" "));
    try {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "openai-mcp-discover",
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "ChatGPT", version: "test" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      console.log = originalLog;
    }

    const text = lines.join("\n");
    expect(text).toMatch(/\[rpc\].*server\/discover #openai-mcp-discover protocol=2026-07-28 outcome=legacy_fallback/);
    expect(text).not.toContain(token);
  });

  it("revoke 之后同一枚令牌立刻被拒 —— 这是整个 tokenEpoch 特性的判据", async () => {
    // 只证明 epoch 整数会递增是不够的：真正要证的是 /mcp 【真的会拒】。
    // 用一枚【合法签发】的令牌（走完整 OAuth 流程），先确认它能用，
    // 再从【另一个 db 连接】递增 epoch（模拟 `grande revoke` 是独立进程），
    // 然后用【同一枚令牌】再打一次。
    const token = await mintToken(app);
    const call = () => app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect((await call()).status).toBe(200);

    const cli = openDb(layout);            // 另一个连接 = 另一个进程的模拟
    expect(bumpEpoch(cli)).toBe(2);
    cli.close();

    const after = await call();
    expect(after.status).toBe(401);
    // 401 必须带 WWW-Authenticate，否则客户端不知道去哪重新授权，
    // 只会看到一个不明所以的失败。
    expect(after.headers.get("WWW-Authenticate") ?? "").toContain("resource_metadata=");

    // 而重新走一次授权必须能恢复——否则 revoke 就成了永久砖化。
    const fresh = await mintToken(app);
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${fresh}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
  });

  it("revoke 之后旧 refresh_token 换来的新令牌【可以】用 —— 这是有意的边界", async () => {
    // refresh token 是库里的 handle，不受 epoch 影响；它换出来的 access token
    // 带的是【换取时】的 epoch，所以是新的。`grande revoke` 的预演输出必须
    // 说清这一点，否则会让人以为一条命令就断干净了。
    const issued = await mintTokenFull(app);
    const rt = issued.refresh_token;
    expect(rt).toBeDefined();   // 防空转：拿不到 refresh_token 这条测试就没意义

    const cli = openDb(layout);
    bumpEpoch(cli);
    cli.close();

    const refreshed = await (await app.request("/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: rt!,
        client_id: issued.client_id, resource: `${ISSUER}/mcp`,
      }).toString(),
    })).json() as { access_token?: string };

    expect(refreshed.access_token).toBeDefined();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${refreshed.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
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
    expect(body.scopes_supported).toEqual(["grande:workspace", "offline_access"]);
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

describe("遗留 #4：JSON-RPC 方法级日志", () => {
  /** 捕获 console.log，返回 [取文本, 还原]。 */
  function captureLog(): [() => string, () => void] {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    return [() => lines.join("\n"), () => { console.log = orig; }];
  }

  it("tools/list 进日志，并带上工具数——此前这一层完全没有痕迹", async () => {
    // 2026-07-29：模型能列出写工具却调不动，而服务端只有 `POST /mcp → 200`。
    // tools/list 由 MCP SDK 内部应答，registerTool 的回调只在 tools/call 时触发，
    // 所以 [tool] 那行天然看不到它。这条日志是唯一能回答
    // 「客户端取过几次工具表、每次拿走几个工具」的地方。
    const token = await mintToken(app);
    const [text, restore] = captureLog();
    try {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      });
      // ① 日志确实出现了，且带方法名、id 与工具数
      expect(text()).toMatch(/\[rpc\].*tools\/list #7 \(\d+ 个工具\)/);
      // ② 【关键】body 被读过一次又重建，请求本身必须毫发无损。
      //    只断言日志的话，一个把 body 吃掉的实现照样"通过"。
      expect(res.status).toBe(200);
      const body = await res.text();
      // ③ 顺带钉住一个实测事实：SDK 在 accept 里同时给 json 与 SSE 时，
      //    回的是 **SSE**（`event: message` + `data: {...}`），不是裸 JSON。
      //    `src/selfcheck.ts` 的 extractJsonRpc 因此必须认这两种——只认 JSON 的话，
      //    自检会报「没有工具」，那比没有自检更糟。
      expect(body).toContain("event: message");
      const data = body.split("\n").filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim()).join("");
      const parsed = JSON.parse(data) as { result?: { tools?: unknown[] } };
      expect((parsed.result?.tools ?? []).length).toBeGreaterThan(0);
    } finally { restore(); }
  });

  it("日志【不记参数】——tools/call 的参数已由 [tool] 那行记过", async () => {
    // 在这里再记一遍等于把同一份内容（可能含整个文件的内容）写进日志两次。
    const token = await mintToken(app);
    const [text, restore] = captureLog();
    try {
      await app.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 8, method: "tools/call",
          params: { name: "grande_repo_read", arguments: { path: "SECRET_MARKER_ONLY_IN_PARAMS" } },
        }),
      });
      const rpcLines = text().split("\n").filter((l) => l.includes("[rpc]"));
      expect(rpcLines.join("\n")).toContain("tools/call #8");
      expect(rpcLines.join("\n")).not.toContain("SECRET_MARKER_ONLY_IN_PARAMS");
      // tools/list 之外的方法不带工具数——那个数字只对 tools/list 有意义
      expect(rpcLines.join("\n")).not.toMatch(/tools\/call #8 \(/);
    } finally { restore(); }
  });

  it("通知（无 id）标成 notif，不渲染成 #undefined", async () => {
    const token = await mintToken(app);
    const [text, restore] = captureLog();
    try {
      await app.request("/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      expect(text()).toContain("notifications/initialized notif");
      expect(text()).not.toContain("#undefined");
    } finally { restore(); }
  });
});

describe("网关只绑 loopback（纵深防御的前提）", () => {
  /** 本机第一个非环回 IPv4。拿不到就跳过——CI/无网环境下这条无从验证。 */
  function lanIp(): string | null {
    const nets = networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const n of list ?? []) {
        if (n.family === "IPv4" && !n.internal) return n.address;
      }
    }
    return null;
  }

  function reachable(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect({ host, port });
      const done = (v: boolean) => { sock.destroy(); resolve(v); };
      sock.setTimeout(1500);
      sock.once("connect", () => done(true));
      sock.once("timeout", () => done(false));
      sock.once("error", () => done(false));
    });
  }

  it("从本机 LAN IP 连不上，从 127.0.0.1 连得上", async () => {
    const ip = lanIp();
    // 防空转：拿不到 LAN IP 这条测试就没有意义，必须显式说出来而不是静默通过。
    if (!ip) {
      console.warn("[skip] 拿不到非环回 IPv4，本条无法验证");
      return;
    }
    const port = 8791;
    const savedPort = process.env.PORT;
    process.env.PORT = String(port);   // startGateway 从 env 读端口
    const cfg: AppConfig = { issuer: ISSUER, layout, db: openDb(layout),
                             accessConfig: { teamDomain: ACCESS_TEAM, aud: ACCESS_AUD } };
    const gw = await startGateway(cfg);
    try {
      // 正向：loopback 必须连得上，否则下面那条「连不上」可能只是服务没起来
      expect(await reachable("127.0.0.1", port)).toBe(true);
      // 反向：这才是本条要守的东西
      expect(await reachable(ip, port)).toBe(false);
    } finally {
      await gw.close();
      if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
    }
  });
});

describe("控制台写端点：aud 隔离（S2.5 方案 A）", () => {
  const CONSOLE_AUD = "b".repeat(64);

  function consoleCfg(): AppConfig {
    return {
      issuer: ISSUER, layout, db: openDb(layout),
      accessConfig: { teamDomain: ACCESS_TEAM, aud: ACCESS_AUD },
      consoleAccessConfig: { teamDomain: ACCESS_TEAM, aud: CONSOLE_AUD },
    };
  }

  it("两个 aud 相同时【拒绝启动】——静默失效的隔离比没有隔离更糟", () => {
    expect(() => createApp({
      issuer: ISSUER, layout, db: openDb(layout),
      accessConfig: { teamDomain: ACCESS_TEAM, aud: ACCESS_AUD },
      consoleAccessConfig: { teamDomain: ACCESS_TEAM, aud: ACCESS_AUD },  // 同一个
    })).toThrow(/aud 相同/);
  });

  it("没给控制台配置时，写端点【整组不挂载】——不挂一组没门禁的路由", async () => {
    const a = createApp({
      issuer: ISSUER, layout, db: openDb(layout),
      accessConfig: { teamDomain: ACCESS_TEAM, aud: ACCESS_AUD },
    });
    const res = await a.request("/console/revoke-all", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("无 Access header → 403，且【不产生任何副作用】", async () => {
    const a = createApp(consoleCfg());
    const before = currentEpoch(openDb(layout));
    const res = await a.request("/console/revoke-all", { method: "POST" });
    expect(res.status).toBe(403);
    expect(currentEpoch(openDb(layout))).toBe(before);   // epoch 没被动过
  });

  it("**拿 /mcp 的 Access 令牌调控制台写端点 → 403**（隔离的正向证明）", async () => {
    const a = createApp(consoleCfg());
    const mcpToken = await signAccessAssertion({ aud: ACCESS_AUD });   // /mcp 那个 aud
    const res = await a.request("/console/revoke-all", {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": mcpToken },
    });
    expect(res.status).toBe(403);
  });

  it("**拿控制台的 Access 令牌调 /authorize → 403**（隔离的反向证明）", async () => {
    const a = createApp(consoleCfg());
    const consoleToken = await signAccessAssertion({ aud: CONSOLE_AUD });
    const res = await a.request("/authorize?client_id=x&redirect_uri=https://chatgpt.com/connector/oauth/x&response_type=code&code_challenge=x&code_challenge_method=S256&resource=" + encodeURIComponent(`${ISSUER}/mcp`), {
      headers: { "Cf-Access-Jwt-Assertion": consoleToken },
    });
    expect(res.status).toBe(403);
  });

  it("带正确的控制台令牌 → 真的执行，并且【进审计账本】", async () => {
    const a = createApp(consoleCfg());
    const token = await signAccessAssertion({ aud: CONSOLE_AUD });
    const res = await a.request("/console/revoke-all", {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": token },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { epochAfter: number } };
    expect(body.ok).toBe(true);
    expect(body.data.epochAfter).toBeGreaterThan(1);

    // 走 Gateway 的全部意义就在这一条：控制台做的事必须留痕。
    const db = openDb(layout);
    const row = db.prepare(
      "SELECT tool, decision, state FROM audit WHERE tool='console_revoke_all' ORDER BY at DESC LIMIT 1",
    ).get() as { tool: string; decision: string; state: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.decision).toBe("ALLOWED");
    expect(row!.state).toBe("SUCCEEDED");
  });
});
