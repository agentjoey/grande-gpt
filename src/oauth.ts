import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { SignJWT, jwtVerify } from "jose";

export interface OAuthConfig {
  issuer: string;
  endpointFor(repoId: string): string;
  isRegistered(repoId: string): boolean;
  /** 已注册的全部 repoId。仅用于 AS 元数据的 scopes_supported——
   *  客户端据此判断能请求哪些 scope，空数组会让它认为无 scope 可用。 */
  registeredRepoIds?: () => string[];
  keyPath: string;
  /**
   * client 与 refresh_token 落在这个库里（`oauth_client` / `oauth_refresh`
   * 表，schema 见 db.ts）——两者都要跨网关重启存活。调用方必须传入一个已经
   * 跑过 `openDb()` 的连接（那两张表由 openDb 建，本模块不重复建表），
   * `src/server.ts` 从 `AppConfig.db` 直接透传。授权码（code）不经过这个库，
   * 见下方 `codes` 上的注释。
   */
  db: DatabaseSync;
}

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `OAuthError [${code}]`;
    this.code = code;
  }
}

interface ClientRecord {
  redirectUris: string[];
}

interface CodeRecord {
  challenge: string;
  clientId: string;
  repoId: string;
  redirectUri: string;
  expiresAt: number;
}

interface RefreshTokenRecord {
  resource: string;
  repoId: string;
  parent?: string;
  valid: boolean;
}

/** `oauth_client` 一行的落库形态（`redirectUris` 是 JSON 字符串）。 */
interface ClientRow {
  redirectUris: string;
}

/** `oauth_refresh` 一行的落库形态（SQLite 没有 boolean，`valid` 是 0/1）。 */
interface RefreshRow {
  resource: string;
  repoId: string;
  parent: string | null;
  valid: number;
}

const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

function getOrCreateKey(keyPath: string): Uint8Array {
  try {
    const key = randomBytes(32).toString("hex");
    writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
    return new TextEncoder().encode(key);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      const content = readFileSync(keyPath, "utf-8");
      if (!/^[0-9a-f]{64}$/.test(content)) {
        throw new Error(
          `OAuth key file ${keyPath} is corrupted — delete it to regenerate.`,
        );
      }
      return new TextEncoder().encode(content);
    }
    throw e;
  }
}

function resourceToRepoId(cfg: OAuthConfig, resource: string): string | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  if (url.origin !== new URL(cfg.issuer).origin) return null;
  const repoId = /^\/mcp\/([^/]+)$/.exec(url.pathname)?.[1];
  if (repoId === undefined || !cfg.isRegistered(repoId)) return null;
  return resource === cfg.endpointFor(repoId) ? repoId : null;
}

function scopeFor(repoId: string): string {
  return `grande:repo:${repoId}`;
}

export function createOAuth(cfg: OAuthConfig) {
  const KEY = getOrCreateKey(cfg.keyPath);
  const db = cfg.db;

  // codes 故意留在内存、不落库。授权码活不过 10 分钟且只用一次，持久化它
  // 除了给"重启后一个本还没过期的 code 也会消失"这个无害的边界情况之外没有
  // 任何好处——而代价很大：计划审查抓到过，`token()` 里对 code 的
  // 「查一下还在不在、马上删掉」（claim）必须是**同步的一行**，中间不能有
  // 任何 `await`，否则三个并发请求会各自读到"还在"，都兑出令牌（同一个
  // code 被兑换三次）。只要 codes 还是内存 Map，`codes.get` / `codes.delete`
  // 天然是同步、原子的；一旦换成 DB 查询，SELECT 和 DELETE 之间就有了
  // 可以插进 await 的缝——即使当前实现凑巧还是同步调用 DatabaseSync，也会
  // 诱使未来的人在两者之间插入 await（比如加一层异步校验）。不做这个改动，
  // 就是把这条并发防线钉死在类型层面：Map 的方法根本没有 Promise 可 await。
  const codes = new Map<string, CodeRecord>();

  const insertClientStmt = db.prepare(
    "INSERT INTO oauth_client (clientId, redirectUris, createdAt) VALUES (?, ?, ?)",
  );
  const getClientStmt = db.prepare(
    "SELECT redirectUris FROM oauth_client WHERE clientId = ?",
  );

  const insertRefreshStmt = db.prepare(
    "INSERT INTO oauth_refresh (handle, resource, repoId, parent, valid, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const getRefreshStmt = db.prepare(
    "SELECT resource, repoId, parent, valid FROM oauth_refresh WHERE handle = ?",
  );
  const invalidateRefreshStmt = db.prepare(
    "UPDATE oauth_refresh SET valid = 0 WHERE handle = ?",
  );
  const validChildrenStmt = db.prepare(
    "SELECT handle FROM oauth_refresh WHERE parent = ? AND valid = 1",
  );

  function getClient(clientId: string): ClientRecord | undefined {
    const row = getClientStmt.get(clientId) as ClientRow | undefined;
    if (row === undefined) return undefined;
    return { redirectUris: JSON.parse(row.redirectUris) as string[] };
  }

  function getRefreshToken(handle: string): RefreshTokenRecord | undefined {
    const row = getRefreshStmt.get(handle) as RefreshRow | undefined;
    if (row === undefined) return undefined;
    return {
      resource: row.resource,
      repoId: row.repoId,
      parent: row.parent ?? undefined,
      valid: row.valid === 1,
    };
  }

  /**
   * 与旧版（走内存 Map）行为等价：把从 `start` 往下、当前仍 `valid` 的整条
   * 链吊销。查询本身已经用 `valid = 1` 过滤，所以不会重复吊销、也不会在
   * 已经吊销过的分支上死循环。
   */
  function invalidateChain(start: string) {
    const children = validChildrenStmt.all(start) as { handle: string }[];
    for (const { handle } of children) {
      invalidateRefreshStmt.run(handle);
      invalidateChain(handle);
    }
  }

  async function register(params: {
    client_name?: string;
    redirect_uris: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  }) {
    for (const uri of params.redirect_uris) {
      let u: URL;
      try {
        u = new URL(uri);
      } catch {
        throw new OAuthError(
          "invalid_client_metadata",
          "redirect_uri 不是合法 URL",
        );
      }
      if (u.protocol !== "https:") {
        throw new OAuthError(
          "invalid_client_metadata",
          "redirect_uri 必须用 https",
        );
      }
    }
    const clientId = `client_${randomUUID()}`;
    insertClientStmt.run(clientId, JSON.stringify(params.redirect_uris), Date.now());
    const requested = params.grant_types ?? [];
    const granted = SUPPORTED_GRANT_TYPES.filter((g) => requested.includes(g));
    return {
      client_id: clientId,
      client_name: params.client_name ?? "",
      redirect_uris: params.redirect_uris,
      grant_types: granted,
      response_types: ["code"] as const,
      token_endpoint_auth_method: params.token_endpoint_auth_method ?? "none",
    };
  }

  async function authorize(params: {
    client_id: string;
    redirect_uri: string;
    code_challenge?: string;
    code_challenge_method?: string;
    resource?: string;
    scope?: string;
  }) {
    if (!params.code_challenge) {
      throw new OAuthError("invalid_request", "code_challenge 是必填的");
    }
    if (params.code_challenge_method !== "S256") {
      throw new OAuthError(
        "invalid_request",
        "code_challenge_method 必须是 S256",
      );
    }

    if (!params.resource) {
      throw new OAuthError("invalid_request", "resource 是必填的");
    }
    const repoId = resourceToRepoId(cfg, params.resource);
    if (repoId === null) {
      throw new OAuthError(
        "invalid_target",
        `resource 不是已注册的端点 URL: ${params.resource}`,
      );
    }

    const client = getClient(params.client_id);
    if (client === undefined)
      throw new OAuthError("invalid_client", "client_id 未注册");
    if (!client.redirectUris.includes(params.redirect_uri)) {
      throw new OAuthError("invalid_request", "redirect_uri 与注册值不符");
    }

    const code = randomUUID();
    codes.set(code, {
      challenge: params.code_challenge,
      clientId: params.client_id,
      repoId,
      redirectUri: params.redirect_uri,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return code;
  }

  async function token(form: {
    grant_type: string;
    code?: string;
    code_verifier?: string;
    client_id?: string;
    redirect_uri?: string;
    resource?: string;
    refresh_token?: string;
    scope?: string;
  }) {
    if (form.grant_type === "authorization_code") {
      const code = form.code;
      if (!code) throw new OAuthError("invalid_request", "缺少 code");
      if (!form.code_verifier)
        throw new OAuthError("invalid_grant", "缺少 code_verifier");

      const rec = codes.get(code);
      if (!rec || Date.now() > rec.expiresAt) {
        if (rec) codes.delete(code);
        throw new OAuthError("invalid_grant", "未知或已过期的授权码");
      }

      codes.delete(code);

      const computed = createHash("sha256")
        .update(form.code_verifier)
        .digest("base64url");
      if (computed !== rec.challenge) {
        throw new OAuthError("invalid_grant", "PKCE code_verifier 校验失败");
      }
      if (form.client_id !== undefined && form.client_id !== rec.clientId) {
        throw new OAuthError("invalid_grant", "client_id 与授权码不匹配");
      }
      if (
        form.redirect_uri !== undefined &&
        form.redirect_uri !== rec.redirectUri
      ) {
        throw new OAuthError("invalid_grant", "redirect_uri 与授权码不匹配");
      }

      if (
        form.resource !== undefined &&
        form.resource !== cfg.endpointFor(rec.repoId)
      ) {
        throw new OAuthError(
          "invalid_target",
          "resource 与授权码绑定的端点不匹配",
        );
      }

      const resource = cfg.endpointFor(rec.repoId);
      const scope = scopeFor(rec.repoId);

      const accessToken = await new SignJWT({ scope, jti: randomUUID() })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(cfg.issuer)
        .setAudience(resource)
        .setSubject("user")
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(KEY);

      const rt = randomUUID();
      insertRefreshStmt.run(rt, resource, rec.repoId, null, 1, Date.now());

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 8 * 3600,
        refresh_token: rt,
        scope,
      };
    }

    if (form.grant_type === "refresh_token") {
      const rt = form.refresh_token;
      if (!rt) throw new OAuthError("invalid_request", "缺少 refresh_token");

      const rec = getRefreshToken(rt);
      if (!rec) throw new OAuthError("invalid_grant", "未知的 refresh_token");

      if (!rec.valid) {
        invalidateChain(rt);
        throw new OAuthError(
          "invalid_grant",
          "refresh_token 已被吊销（检测到复用）",
        );
      }

      const resource = form.resource;
      if (resource !== undefined && resource !== rec.resource) {
        throw new OAuthError(
          "invalid_target",
          "resource 与 refresh_token 绑定的端点不匹配",
        );
      }

      invalidateRefreshStmt.run(rt);

      const accessToken = await new SignJWT({
        scope: scopeFor(rec.repoId),
        jti: randomUUID(),
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(cfg.issuer)
        .setAudience(rec.resource)
        .setSubject("user")
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(KEY);

      const newRt = randomUUID();
      insertRefreshStmt.run(newRt, rec.resource, rec.repoId, rt, 1, Date.now());

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 8 * 3600,
        refresh_token: newRt,
        scope: scopeFor(rec.repoId),
      };
    }

    throw new OAuthError(
      "unsupported_grant_type",
      `不支持的 grant_type: ${form.grant_type}`,
    );
  }

  /** 本 AS 使用的 scope 形态：每 repo 一个，与 `aud` 一起构成 D5 的隔离 */
  const scopeFor = (repoId: string): string => `grande:repo:${repoId}`;

  function protectedResourceMetadata(repoId: string) {
    return {
      resource: cfg.endpointFor(repoId),
      authorization_servers: [cfg.issuer],
      // spike 版带了这个字段而本实现漏了。客户端据此决定要请求什么 scope——
      // 缺失时它只能猜，或者干脆判定这个资源不可用。
      scopes_supported: [scopeFor(repoId)],
    };
  }

  function authServerMetadata() {
    return {
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/authorize`,
      token_endpoint: `${cfg.issuer}/token`,
      registration_endpoint: `${cfg.issuer}/register`,
      jwks_uri: `${cfg.issuer}/jwks`,
      // 硬编码空数组是错的：客户端据此判断能请求哪些 scope。
      // 由 isRegistered 之外再要一份「有哪些 repo」的能力不划算，所以让调用方注入。
      scopes_supported: (cfg.registeredRepoIds?.() ?? []).map(scopeFor),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
  }

  async function verifyBearer(token: string, resource: string) {
    const { payload } = await jwtVerify(token, KEY, {
      issuer: cfg.issuer,
      audience: resource,
      algorithms: ["HS256"],
    });
    return { sub: String(payload.sub ?? "") };
  }

  return {
    register,
    authorize,
    token,
    protectedResourceMetadata,
    authServerMetadata,
    verifyBearer,
  };
}
