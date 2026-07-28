import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccessGate } from "../src/accessGate.ts";

const TEAM = "https://team.example.test";
const AUD = "a".repeat(64);
let priv: CryptoKey, jwksBody: string, restore: () => void;

beforeEach(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  jwksBody = JSON.stringify({ keys: [{ ...(await exportJWK(kp.publicKey)), alg: "RS256", kid: "k1" }] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) =>
    String(u).includes("/cdn-cgi/access/certs")
      ? new Response(jwksBody, { headers: { "content-type": "application/json" } })
      : realFetch(u as never)) as typeof fetch;
  restore = () => { globalThis.fetch = realFetch; };
});
afterEach(() => restore());

const sign = (over: Record<string, unknown> = {}) =>
  new SignJWT({ email: "u@example.test", ...over })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(String(over.iss ?? TEAM))
    .setAudience(String(over.aud ?? AUD))
    .setSubject("sub-1")
    .setExpirationTime("5m")
    .sign(priv);

describe("createAccessGate()", () => {
  it("合法断言通过并返回身份", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const id = await gate(new Headers({ "Cf-Access-Jwt-Assertion": await sign() }));
    expect(id.email).toBe("u@example.test");
  });

  it("【没有头】就拒绝——这是 Access 被绕过或被删掉时的形态", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    await expect(gate(new Headers())).rejects.toThrow(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
  });

  it("同团队【别的应用】签发的 JWT 被拒（不钉 audience 就是跨应用提权）", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const other = await sign({ aud: "b".repeat(64) });
    await expect(gate(new Headers({ "Cf-Access-Jwt-Assertion": other }))).rejects.toThrow();
  });

  it("别的团队签发的 JWT 被拒", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const other = await sign({ iss: "https://evil.cloudflareaccess.com" });
    await expect(gate(new Headers({ "Cf-Access-Jwt-Assertion": other }))).rejects.toThrow();
  });

  it("过期的断言被拒", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const expired = await new SignJWT({ email: "u@example.test" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(TEAM).setAudience(AUD).setSubject("s")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(priv);
    await expect(gate(new Headers({ "Cf-Access-Jwt-Assertion": expired }))).rejects.toThrow();
  });

  it("篡改过的断言被拒", async () => {
    const gate = createAccessGate({ teamDomain: TEAM, aud: AUD });
    const t = await sign();
    const [h, p, s] = t.split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ email: "evil@x.test", iss: TEAM, aud: AUD, exp: 9e9 })).toString("base64url")}.${s}`;
    await expect(gate(new Headers({ "Cf-Access-Jwt-Assertion": tampered }))).rejects.toThrow();
  });
});
