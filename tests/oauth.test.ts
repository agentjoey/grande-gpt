import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOAuth } from "../src/oauth.ts";

const ISSUER = "https://grande.example.test";

const oauth = (registered: ReadonlySet<string> = new Set(["demo"])) =>
  createOAuth({
    issuer: ISSUER,
    endpointFor: (r) => `${ISSUER}/mcp/${r}`,
    isRegistered: (r) => registered.has(r),
    keyPath: join(mkdtempSync(join(tmpdir(), "oauth-key-")), "oauth-key"),
  });

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

async function fullFlow(o: ReturnType<typeof createOAuth>, repoId = "demo") {
  const reg = await o.register({
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/opaque"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  const verifier = randomBytes(48).toString("base64url");
  const code = await o.authorize({
    client_id: reg.client_id,
    redirect_uri: reg.redirect_uris[0]!,
    code_challenge: s256(verifier),
    code_challenge_method: "S256",
    resource: `${ISSUER}/mcp/${repoId}`,
    scope: `grande:repo:${repoId}`,
  });
  const tok = await o.token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: reg.client_id,
    redirect_uri: reg.redirect_uris[0]!,
    resource: `${ISSUER}/mcp/${repoId}`,
  });
  return { reg, verifier, tok };
}

describe("发现文档", () => {
  it("每-repo 的受保护资源元数据指向该 repo 自己的端点", () => {
    const m = oauth().protectedResourceMetadata("demo");
    expect(m.resource).toBe(`${ISSUER}/mcp/demo`);
    expect(m.authorization_servers).toContain(ISSUER);
  });

  it("AS 元数据【如实】声明 grant_types_supported 含 refresh_token，且发现端点三件套齐全", () => {
    const m = oauth().authServerMetadata();
    expect(m.grant_types_supported).toContain("authorization_code");
    expect(m.grant_types_supported).toContain("refresh_token");
    expect(m.code_challenge_methods_supported).toContain("S256");
    expect(m.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(m.token_endpoint).toBe(`${ISSUER}/token`);
    expect(m.jwks_uri).toBe(`${ISSUER}/jwks`);
  });
});

describe("动态注册（DCR）", () => {
  it("回传的 grant_types 是【实际支持的】，不是照单全收", async () => {
    const reg = await oauth().register({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/x"],
      grant_types: ["authorization_code", "refresh_token", "password", "implicit"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(reg.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(reg.grant_types).not.toContain("password");
    expect(reg.grant_types).not.toContain("implicit");
  });

  it("非 https 的 redirect_uri 被拒", async () => {
    await expect(oauth().register({
      client_name: "x", redirect_uris: ["http://evil.test/cb"],
      grant_types: ["authorization_code"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    })).rejects.toThrow(/redirect_uri/);
  });
});

describe("授权码流 + PKCE", () => {
  it("正确的 verifier 换得到 access_token 与 refresh_token", async () => {
    const { tok } = await fullFlow(oauth());
    expect(tok.token_type).toBe("Bearer");
    expect(typeof tok.access_token).toBe("string");
    expect(typeof tok.refresh_token).toBe("string");
    expect(tok.expires_in).toBeGreaterThan(0);
  });

  it("错误的 verifier 被拒（PKCE 校验无条件生效）", async () => {
    const o = oauth();
    const { reg } = await fullFlow(o);
    const verifier = randomBytes(48).toString("base64url");
    const code = await o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
    });
    await expect(o.token({
      grant_type: "authorization_code", code,
      code_verifier: "完全错误的 verifier", client_id: reg.client_id,
      redirect_uri: reg.redirect_uris[0]!, resource: `${ISSUER}/mcp/demo`,
    })).rejects.toThrow(/PKCE|code_verifier/);
  });

  it("【不带】code_challenge 的授权请求被拒，而不是跳过 PKCE 校验", async () => {
    const o = oauth();
    const reg = await o.register({
      client_name: "x", redirect_uris: ["https://chatgpt.com/connector/oauth/x"],
      grant_types: ["authorization_code"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    await expect(o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
    } as never)).rejects.toThrow(/code_challenge/);
  });

  it("授权码是一次性的：同一个 code 换第二次被拒", async () => {
    const o = oauth();
    const { reg, verifier } = await fullFlow(o);
    const code = await o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
    });
    const args = {
      grant_type: "authorization_code" as const, code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp/demo`,
    };
    await o.token(args);
    await expect(o.token(args)).rejects.toThrow();
  });

  it("同一个 code 被并发兑换时只有一个成功（顺序测试抓不到这条）", async () => {
    const o = oauth();
    const { reg, verifier } = await fullFlow(o);
    const code = await o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
    } as never);
    const args = {
      grant_type: "authorization_code" as const, code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp/demo`,
    };
    const rs = await Promise.allSettled([o.token(args), o.token(args), o.token(args)]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("redirect_uri 必须与注册值【精确】相等，前缀相同也不行", async () => {
    const o = oauth();
    const reg = await o.register({
      client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector/oauth/abc"],
      grant_types: ["authorization_code"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const verifier = randomBytes(48).toString("base64url");
    for (const evil of [
      "https://chatgpt.com/connector/oauth/abc.evil.test/cb",
      "https://chatgpt.com/connector/oauth/abc/../../evil",
      "https://evil.test/cb",
    ]) {
      await expect(o.authorize({
        client_id: reg.client_id, redirect_uri: evil,
        code_challenge: s256(verifier), code_challenge_method: "S256",
        resource: `${ISSUER}/mcp/demo`, scope: "grande:repo:demo",
      } as never)).rejects.toThrow(/redirect_uri/);
    }
  });

  it.each([
    ["跨 origin 的 resource", "https://evil.test/mcp/demo"],
    ["未注册的 repoId",        `${ISSUER}/mcp/nonexistent`],
    ["用 .. 绕行",             `${ISSUER}/mcp/demo/../other`],
    ["百分号编码的 ..",        `${ISSUER}/mcp/%2e%2e%2fother`],
    ["编码过的分隔符",         `${ISSUER}/mcp/demo%2Fother`],
  ])("%s 无法换到令牌", async (_label, resource) => {
    const o = oauth();
    const verifier = randomBytes(48).toString("base64url");
    await expect(o.authorize({
      client_id: "c", redirect_uri: "https://chatgpt.com/connector/oauth/x",
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource, scope: "grande:repo:demo",
    } as never)).rejects.toThrow(/resource|invalid_target/);
  });
});

describe("refresh_token（U1 实测缺口，本切片核心）", () => {
  it("refresh 换得到新的 access_token", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp/demo`,
    });
    expect(typeof next.access_token).toBe("string");
    expect(next.access_token).not.toBe(tok.access_token);
  });

  it("refresh 得到的令牌 aud 仍精确绑定同一端点", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp/demo`,
    });
    await expect(o.verifyBearer(next.access_token, `${ISSUER}/mcp/demo`)).resolves.toBeTruthy();
    await expect(o.verifyBearer(next.access_token, `${ISSUER}/mcp/other`)).rejects.toThrow();
  });

  it("refresh 不能跨端点提权：拿 demo 的 refresh 去要 other 的令牌被拒", async () => {
    const o = oauth(new Set(["demo", "other"]));
    const { tok } = await fullFlow(o, "demo");
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp/other`,
    })).rejects.toThrow();
  });

  it("伪造的 refresh_token 被拒", async () => {
    await expect(oauth().token({
      grant_type: "refresh_token", refresh_token: "伪造的",
      resource: `${ISSUER}/mcp/demo`,
    })).rejects.toThrow();
  });

  it("refresh 一次性并轮换；旧的再用一次会连带吊销整条链", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token, resource: `${ISSUER}/mcp/demo`,
    });
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(tok.refresh_token);
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token, resource: `${ISSUER}/mcp/demo`,
    })).rejects.toThrow();
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: next.refresh_token, resource: `${ISSUER}/mcp/demo`,
    })).rejects.toThrow();
  });
});

describe("verifyBearer —— D5 每-repo 隔离", () => {
  it("aud 匹配的令牌通过", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    await expect(o.verifyBearer(tok.access_token, `${ISSUER}/mcp/demo`)).resolves.toBeTruthy();
  });

  it("用 demo 的令牌打 other 端点被拒（D5 由协议层强制）", async () => {
    const o = oauth(new Set(["demo", "other"]));
    const { tok } = await fullFlow(o, "demo");
    await expect(o.verifyBearer(tok.access_token, `${ISSUER}/mcp/other`)).rejects.toThrow();
  });

  it("篡改过的令牌被拒", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o, "demo");
    const parts = tok.access_token.split(".");
    const payload = Buffer.from(parts[1]!, "base64url");
    payload[0] = payload[0]! ^ 0xff;
    const bad = [parts[0], payload.toString("base64url"), parts[2]].join(".");
    await expect(o.verifyBearer(bad, `${ISSUER}/mcp/demo`)).rejects.toThrow();
  });

  it("空串与非 JWT 被拒，而不是抛出未分类的异常", async () => {
    const o = oauth();
    for (const t of ["", "not-a-jwt", "a.b.c"]) {
      await expect(o.verifyBearer(t, `${ISSUER}/mcp/demo`)).rejects.toThrow();
    }
  });

  it("用【另一把】密钥签发的令牌被拒（模拟密钥轮换）", async () => {
    const o1 = oauth();
    const o2 = oauth();
    const { tok } = await fullFlow(o1, "demo");
    await expect(o2.verifyBearer(tok.access_token, `${ISSUER}/mcp/demo`)).rejects.toThrow();
  });
});
