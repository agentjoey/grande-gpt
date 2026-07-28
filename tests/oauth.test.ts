import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import type { Layout } from "../src/layout.ts";
import { createOAuth } from "../src/oauth.ts";

const ISSUER = "https://grande.example.test";
const SCOPE = "grande:workspace";

/**
 * openDb() 只用得到 `layout.stateDb`（建目录 + 打开文件），其余字段在这里
 * 用不上——不走 loadLayout()/真实的 GRANDE_WORKSPACE 环境变量，是为了让每个
 * 测试能各自拿到一个独立、互不干扰的库文件，也让"关掉再用同一个路径重新
 * openDb()"（模拟重启）这个动作不必绕道 process.env。
 */
function tempLayout(): Layout {
  const stateDb = join(mkdtempSync(join(tmpdir(), "oauth-db-")), "grande.db");
  return {
    workspaceRoot: "/unused",
    controlRoot: "/unused",
    stateDb,
    configDir: "/unused",
    reposConfig: "/unused",
    artifactsDir: "/unused",
    derivedRoot: "/unused",
    worktreesRoot: "/unused",
  };
}

const oauth = (db?: DatabaseSync) =>
  createOAuth({
    issuer: ISSUER,
    endpointFor: () => `${ISSUER}/mcp`,
    keyPath: join(mkdtempSync(join(tmpdir(), "oauth-key-")), "oauth-key"),
    db: db ?? openDb(tempLayout()),
  });

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

async function fullFlow(o: ReturnType<typeof createOAuth>, resource = `${ISSUER}/mcp`) {
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
    resource,
    scope: SCOPE,
  });
  const tok = await o.token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: reg.client_id,
    redirect_uri: reg.redirect_uris[0]!,
    resource,
  });
  return { reg, verifier, tok };
}

describe("发现文档（D18：单一端点）", () => {
  it("受保护资源元数据指向单一端点，且 scope 是单一的 grande:workspace", () => {
    const m = oauth().protectedResourceMetadata();
    expect(m.resource).toBe(`${ISSUER}/mcp`);
    expect(m.authorization_servers).toContain(ISSUER);
    expect(m.scopes_supported).toEqual([SCOPE]);
  });

  it("AS 元数据【如实】声明 grant_types_supported 含 refresh_token，且发现端点三件套齐全", () => {
    const m = oauth().authServerMetadata();
    expect(m.grant_types_supported).toContain("authorization_code");
    expect(m.grant_types_supported).toContain("refresh_token");
    expect(m.code_challenge_methods_supported).toContain("S256");
    expect(m.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(m.token_endpoint).toBe(`${ISSUER}/token`);
    expect(m.jwks_uri).toBe(`${ISSUER}/jwks`);
    expect(m.scopes_supported).toEqual([SCOPE]);
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
  it("正确的 verifier 换得到 access_token 与 refresh_token，scope 是单一的 grande:workspace", async () => {
    const { tok } = await fullFlow(oauth());
    expect(tok.token_type).toBe("Bearer");
    expect(typeof tok.access_token).toBe("string");
    expect(typeof tok.refresh_token).toBe("string");
    expect(tok.expires_in).toBeGreaterThan(0);
    expect(tok.scope).toBe(SCOPE);
  });

  it("错误的 verifier 被拒（PKCE 校验无条件生效）", async () => {
    const o = oauth();
    const { reg } = await fullFlow(o);
    const verifier = randomBytes(48).toString("base64url");
    const code = await o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource: `${ISSUER}/mcp`, scope: SCOPE,
    });
    await expect(o.token({
      grant_type: "authorization_code", code,
      code_verifier: "完全错误的 verifier", client_id: reg.client_id,
      redirect_uri: reg.redirect_uris[0]!, resource: `${ISSUER}/mcp`,
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
      resource: `${ISSUER}/mcp`, scope: SCOPE,
    } as never)).rejects.toThrow(/code_challenge/);
  });

  it("授权码是一次性的：同一个 code 换第二次被拒", async () => {
    const o = oauth();
    const { reg, verifier } = await fullFlow(o);
    const code = await o.authorize({
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource: `${ISSUER}/mcp`, scope: SCOPE,
    });
    const args = {
      grant_type: "authorization_code" as const, code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp`,
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
      resource: `${ISSUER}/mcp`, scope: SCOPE,
    } as never);
    const args = {
      grant_type: "authorization_code" as const, code, code_verifier: verifier,
      client_id: reg.client_id, redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp`,
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
        resource: `${ISSUER}/mcp`, scope: SCOPE,
      } as never)).rejects.toThrow(/redirect_uri/);
    }
  });

  /**
   * D18：resource 不再嵌 repoId，但 `isValidResource` 的校验形状（origin 相等
   * + 往返相等）原样保留——这张表换成会撞在「单一端点」这个更窄的形状上的
   * 输入，而不是删掉整组测试。
   */
  it.each([
    ["跨 origin 的 resource", "https://evil.test/mcp"],
    ["带额外路径段（D5 时代的每-repo 形态）", `${ISSUER}/mcp/demo`],
    ["末尾多一个斜杠", `${ISSUER}/mcp/`],
    ["带查询串", `${ISSUER}/mcp?x=1`],
    ["大小写不同的路径", `${ISSUER}/MCP`],
    ["完全不相关的路径", `${ISSUER}/other`],
  ])("%s 无法换到令牌", async (_label, resource) => {
    const o = oauth();
    const verifier = randomBytes(48).toString("base64url");
    await expect(o.authorize({
      client_id: "c", redirect_uri: "https://chatgpt.com/connector/oauth/x",
      code_challenge: s256(verifier), code_challenge_method: "S256",
      resource, scope: SCOPE,
    } as never)).rejects.toThrow(/resource|invalid_target/);
  });
});

describe("refresh_token", () => {
  it("refresh 换得到新的 access_token", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp`,
    });
    expect(typeof next.access_token).toBe("string");
    expect(next.access_token).not.toBe(tok.access_token);
    expect(next.scope).toBe(SCOPE);
  });

  it("refresh 得到的令牌 aud 仍精确绑定单一端点", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp`,
    });
    await expect(o.verifyBearer(next.access_token, `${ISSUER}/mcp`)).resolves.toBeTruthy();
    await expect(o.verifyBearer(next.access_token, `${ISSUER}/mcp-forged`)).rejects.toThrow();
  });

  it("refresh 时传一个不匹配的 resource 被拒", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token,
      resource: "https://evil.test/mcp",
    })).rejects.toThrow();
  });

  it("伪造的 refresh_token 被拒", async () => {
    await expect(oauth().token({
      grant_type: "refresh_token", refresh_token: "伪造的",
      resource: `${ISSUER}/mcp`,
    })).rejects.toThrow();
  });

  it("refresh 一次性并轮换；旧的再用一次会连带吊销整条链", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    const next = await o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token, resource: `${ISSUER}/mcp`,
    });
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(tok.refresh_token);
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: tok.refresh_token, resource: `${ISSUER}/mcp`,
    })).rejects.toThrow();
    await expect(o.token({
      grant_type: "refresh_token", refresh_token: next.refresh_token, resource: `${ISSUER}/mcp`,
    })).rejects.toThrow();
  });
});

describe("verifyBearer —— D18 单一端点", () => {
  it("单一端点签发的令牌用来验证同一个端点时通过", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    await expect(o.verifyBearer(tok.access_token, `${ISSUER}/mcp`)).resolves.toBeTruthy();
  });

  it("测试 1（规格要求）：token 打在不同 aud 上被拒——不是伪造签名，是拿一枚真实签发的" +
     "令牌去验证一个它没有被签给的资源", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    await expect(o.verifyBearer(tok.access_token, "https://evil.test/mcp")).rejects.toThrow();
    await expect(o.verifyBearer(tok.access_token, `${ISSUER}/mcp-not-the-real-one`)).rejects.toThrow();
  });

  it("篡改过的令牌被拒", async () => {
    const o = oauth();
    const { tok } = await fullFlow(o);
    const parts = tok.access_token.split(".");
    const payload = Buffer.from(parts[1]!, "base64url");
    payload[0] = payload[0]! ^ 0xff;
    const bad = [parts[0], payload.toString("base64url"), parts[2]].join(".");
    await expect(o.verifyBearer(bad, `${ISSUER}/mcp`)).rejects.toThrow();
  });

  it("空串与非 JWT 被拒，而不是抛出未分类的异常", async () => {
    const o = oauth();
    for (const t of ["", "not-a-jwt", "a.b.c"]) {
      await expect(o.verifyBearer(t, `${ISSUER}/mcp`)).rejects.toThrow();
    }
  });

  it("用【另一把】密钥签发的令牌被拒（模拟密钥轮换）", async () => {
    const o1 = oauth();
    const o2 = oauth();
    const { tok } = await fullFlow(o1);
    await expect(o2.verifyBearer(tok.access_token, `${ISSUER}/mcp`)).rejects.toThrow();
  });
});

describe("持久化：重启不丢 client / refresh_token（U1 实测缺口，本切片核心）", () => {
  // 同一份 layout + keyPath 在两次 createOAuth() 之间复用，模拟"同一个网关
  // 进程重启"：DB 文件与签名密钥文件都还在磁盘上，只是内存状态（Map）被清空。
  function restartable() {
    const layout = tempLayout();
    const keyPath = join(mkdtempSync(join(tmpdir(), "oauth-key-")), "oauth-key");
    return { layout, keyPath };
  }

  function openOauth(layout: Layout, keyPath: string) {
    const db = openDb(layout);
    const o = createOAuth({
      issuer: ISSUER,
      endpointFor: () => `${ISSUER}/mcp`,
      keyPath,
      db,
    });
    return { o, db };
  }

  it("client 在网关重启后仍能完成 authorize——这正是实测复现的那条日志（invalid_client）", async () => {
    const { layout, keyPath } = restartable();
    const { o: o1, db: db1 } = openOauth(layout, keyPath);
    const reg = await o1.register({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/opaque"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    db1.close(); // 模拟网关进程退出：内存 Map 消失，DB 文件还在

    const { o: o2 } = openOauth(layout, keyPath);
    const verifier = randomBytes(48).toString("base64url");
    // 用【原始】client_id——ChatGPT 存的就是这个，不会重新走一遍 DCR
    const code = await o2.authorize({
      client_id: reg.client_id,
      redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      resource: `${ISSUER}/mcp`,
      scope: SCOPE,
    });
    expect(typeof code).toBe("string");
  });

  it("refresh_token 在重启后仍可兑换新 access_token，包括重启前已经轮换过的那一枚", async () => {
    const { layout, keyPath } = restartable();
    const { o: o1, db: db1 } = openOauth(layout, keyPath);
    const { tok } = await fullFlow(o1);
    const rotatedBeforeRestart = await o1.token({
      grant_type: "refresh_token",
      refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp`,
    });
    db1.close();

    const { o: o2 } = openOauth(layout, keyPath);
    const next = await o2.token({
      grant_type: "refresh_token",
      refresh_token: rotatedBeforeRestart.refresh_token,
      resource: `${ISSUER}/mcp`,
    });
    expect(typeof next.access_token).toBe("string");
    expect(next.access_token).not.toBe(rotatedBeforeRestart.access_token);
  });

  it("endpointFor 变更后，绑着旧 resource 的 refresh_token 被拒，而不是继续签发 aud 已失效的 access token", async () => {
    // D18 就干过这件事：endpointFor 从 `${ISSUER}/mcp/${repoId}` 改成 `${ISSUER}/mcp`。
    // isValidResource 守着 /authorize，但 refresh 是唯一一条不经过 /authorize 就能
    // 签出 access token 的路径。不补这道检查，旧 refresh_token 会一直签发 aud 没人
    // 认的 token：refresh 成功 → 拿去用 401 → 再 refresh，死循环，每步单看都「成功」。
    const { layout, keyPath } = restartable();

    // 不能用 createOAuth 造这枚旧 token——isValidResource 会在 /authorize 就把
    // `${ISSUER}/mcp/grande-gpt` 挡掉。真实情形本来也不是「旧网关现在还在跑」，
    // 而是「库里那一行是旧版代码写下的」，所以直接改库里的 resource 才是如实模拟。
    const { o: o1, db: db1 } = openOauth(layout, keyPath);
    const { tok } = await fullFlow(o1);
    expect(typeof tok.refresh_token).toBe("string");
    const changed = db1
      .prepare("UPDATE oauth_refresh SET resource = ? WHERE valid = 1")
      .run(`${ISSUER}/mcp/grande-gpt`).changes;
    expect(changed).toBe(1); // 确认真的改到了那一行，否则下面的断言是空的
    db1.close();

    // 网关重启到 D18 之后（openOauth 的 endpointFor 是 `${ISSUER}/mcp`）
    const { o: oNew } = openOauth(layout, keyPath);

    await expect(
      oNew.token({ grant_type: "refresh_token", refresh_token: tok.refresh_token }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    // 且该凭据已被吊销——客户端反复拿它来撞不会有第二种结果
    await expect(
      oNew.token({ grant_type: "refresh_token", refresh_token: tok.refresh_token }),
    ).rejects.toThrow();
  });

  it("reuse-detection 在重启后依然生效：回放重启前的旧 refresh_token 被拒，且它的后代一并被吊销", async () => {
    const { layout, keyPath } = restartable();
    const { o: o1, db: db1 } = openOauth(layout, keyPath);
    const { tok } = await fullFlow(o1);
    const rotated = await o1.token({
      grant_type: "refresh_token",
      refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp`,
    });
    db1.close();

    const { o: o2 } = openOauth(layout, keyPath);
    // 回放重启前已经被轮换掉的旧 token
    await expect(o2.token({
      grant_type: "refresh_token",
      refresh_token: tok.refresh_token,
      resource: `${ISSUER}/mcp`,
    })).rejects.toThrow();
    // 它的后代（rotated.refresh_token）必须一并被吊销——链状态没有因重启而丢失
    await expect(o2.token({
      grant_type: "refresh_token",
      refresh_token: rotated.refresh_token,
      resource: `${ISSUER}/mcp`,
    })).rejects.toThrow();
  });

  it("授权码不会在重启后存活——这是刻意的选择（见 oauth.ts codes 上的注释），不是遗漏", async () => {
    const { layout, keyPath } = restartable();
    const { o: o1, db: db1 } = openOauth(layout, keyPath);
    const reg = await o1.register({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/opaque"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const verifier = randomBytes(48).toString("base64url");
    const code = await o1.authorize({
      client_id: reg.client_id,
      redirect_uri: reg.redirect_uris[0]!,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      resource: `${ISSUER}/mcp`,
      scope: SCOPE,
    });
    db1.close();

    const { o: o2 } = openOauth(layout, keyPath);
    await expect(o2.token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: reg.client_id,
      redirect_uri: reg.redirect_uris[0]!,
      resource: `${ISSUER}/mcp`,
    })).rejects.toThrow();
  });
});
