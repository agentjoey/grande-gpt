import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

export class AccessDeniedError extends Error {
  readonly code = "ACCESS_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError [ACCESS_DENIED]";
  }
}

export function createAccessGate(cfg: AccessConfig) {
  const jwks = createRemoteJWKSet(new URL(`${cfg.teamDomain}/cdn-cgi/access/certs`));
  return async function assertApproved(headers: Headers): Promise<{ email: string; sub: string }> {
    const assertion = headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion) {
      throw new AccessDeniedError(
        "缺少 Cf-Access-Jwt-Assertion。/authorize 必须经由 Cloudflare Access 到达；" +
          "直连或 Access 未配置时一律拒绝。",
      );
    }
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer: cfg.teamDomain,
      audience: cfg.aud,
      algorithms: ["RS256"],
    });
    return { email: String(payload.email ?? ""), sub: String(payload.sub ?? "") };
  };
}
