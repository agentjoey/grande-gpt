import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";

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

export class AccessConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    // 与 PolicyError/ProfileError 保持同一形状：码存 .code，name 带码，message 干净。
    super(message);
    this.name = `AccessConfigError [${code}]`;
    this.code = code;
  }
}

const AUD_RE = /^[0-9a-f]{64}$/i;

/**
 * 从**控制平面**读 Access 门禁配置（铁律一：绝不从仓库读，规格 §7.0⓪）。
 *
 * 缺失或格式错误一律拒绝启动——**不默认为开放，也不默认到硬编码值**。缺失配置的
 * 含义是「门禁从未安装」，不是「门禁不适用」：Cloudflare Access 本身是一个仪表盘
 * 设置，能被删除、误配置范围，或者被绕过（直接暴露端口）；代码侧这道检查存在的
 * 意义就是把它从软约束变成硬约束（铁律三）。因此宁可启动失败，也不能悄悄放行。
 */
export function loadAccessConfig(layout: Layout): AccessConfig {
  const file = join(layout.configDir, "access.yaml");
  if (!existsSync(file)) {
    throw new AccessConfigError(
      "MISSING_CONFIG",
      `${file} 不存在。这意味着 /authorize 的 Cloudflare Access 门禁从未安装，而不是` +
        `「本环境不需要门禁」——Access 仪表盘设置可被删除或误配置范围，代码侧检查正是为了` +
        `不依赖它。请创建该文件，包含 teamDomain（团队域名）与 aud（应用 Audience）两个字段` +
        `后再启动 gateway。`,
    );
  }

  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new AccessConfigError("BAD_CONFIG", `无法解析 ${file}：${(e as Error).message}`);
  }
  if (doc === null || doc === undefined || typeof doc !== "object" || Array.isArray(doc)) {
    throw new AccessConfigError("BAD_CONFIG", `${file} 顶层必须是映射`);
  }

  const { teamDomain, aud } = doc as Record<string, unknown>;

  if (typeof teamDomain !== "string" || teamDomain.length === 0) {
    throw new AccessConfigError("BAD_CONFIG", `${file} 的 teamDomain 必须是非空字符串`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(teamDomain);
  } catch {
    throw new AccessConfigError("BAD_CONFIG", `${file} 的 teamDomain 必须是绝对 URL，实际是 ${JSON.stringify(teamDomain)}`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new AccessConfigError("BAD_CONFIG", `${file} 的 teamDomain 必须是 https URL，实际是 ${JSON.stringify(teamDomain)}`);
  }

  if (typeof aud !== "string" || !AUD_RE.test(aud)) {
    throw new AccessConfigError("BAD_CONFIG", `${file} 的 aud 必须是 64 位十六进制字符串，实际是 ${JSON.stringify(aud)}`);
  }

  return { teamDomain, aud };
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
