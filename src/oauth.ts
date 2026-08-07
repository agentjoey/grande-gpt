import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { SignJWT, jwtVerify } from "jose";
import { currentEpoch, isEpochCurrent } from "./tokenEpoch.ts";

export interface OAuthConfig {
  issuer: string;
  /**
   * 单一端点的绝对 URL（D18：`${issuer}/mcp`，不再按 repo 区分）。
   * 保留成函数而非直接存字符串，是为了让调用方（`server.ts`）与本模块共享
   * 同一处拼接逻辑，不在两个文件里各写一遍容易走样的字符串模板。
   */
  endpointFor(): string;
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
  redirectUri: string;
  expiresAt: number;
}

interface RefreshTokenRecord {
  resource: string;
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
  parent: string | null;
  valid: number;
}

const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

/**
 * D18：单一端点、单一 scope。此前是每 repo 一个 `grande:repo:<repoId>`——
 * 隔离由端点/scope 表达；现在隔离下移到 `taskId`（见 tools.ts 的
 * `grande_task_open`/`grande_repo_edit`），OAuth 层不再有「repo」这个概念，
 * 一个诚实的名字就够了：这枚令牌能打开的是整个工作区的 Gateway，具体动到
 * 哪个仓库由后续的工具调用（尤其是 `taskId`）决定，不由这枚令牌决定。
 */
const SCOPE = "grande:workspace";

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

/**
 * `resource` 参数的校验。**D18 之前**这里叫 `resourceToRepoId`：从 `resource`
 * 的 URL 路径里解析出 `repoId`，再要求它已注册、且往返拼接（`endpointFor(repoId)`）
 * 与原始输入完全相等。D18 把「按 repo 区分」去掉了，但**校验的形状必须原样
 * 保留**——origin 相等 + 往返相等这两道检查各自堵的是不同的洞，具体如下：
 *
 * - **origin 相等**：`resource` 是调用方（ChatGPT）可控字符串，不检查 origin
 *   的话，`https://evil.test/mcp` 这种跨源资源标识符也能进入后续比较。
 * - **往返相等**（`resource === cfg.endpointFor()`）：这道检查在每-repo 版本
 *   里挡的是 Hono 路由参数解码与 `c.req.url` 原始字符串之间的差异（`%2f`
 *   这类）——因为端点路径里嵌了一段可变的 `repoId`。D18 的端点路径是固定
 *   字面量 `/mcp`，不再嵌可变段，这个具体的解码歧义场景确实随 `repoId` 一起
 *   消失了；但「往返相等」这道检查本身没有变得多余——它仍然是唯一一处同时
 *   钉住 protocol/host/port/path/query/fragment **全部**相等的比较（单独的
 *   `pathname === "/mcp"` 检查不管 query/fragment），继续保留，不因为它现在
 *   „顺带" 也防住了已经不存在的那个具体场景就把它退化成一个更松的判定。
 */
function isValidResource(cfg: OAuthConfig, resource: string): boolean {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  if (url.origin !== new URL(cfg.issuer).origin) return false;
  if (url.pathname !== "/mcp") return false;
  return resource === cfg.endpointFor();
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
    "INSERT INTO oauth_refresh (handle, resource, parent, valid, createdAt) VALUES (?, ?, ?, ?, ?)",
  );
  const getRefreshStmt = db.prepare(
    "SELECT resource, parent, valid FROM oauth_refresh WHERE handle = ?",
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
    if (!isValidResource(cfg, params.resource)) {
      throw new OAuthError(
        "invalid_target",
        `resource 不是本网关的端点 URL: ${params.resource}`,
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
        form.resource !== cfg.endpointFor()
      ) {
        throw new OAuthError(
          "invalid_target",
          "resource 与授权码绑定的端点不匹配",
        );
      }

      const resource = cfg.endpointFor();

      const accessToken = await new SignJWT({ scope: SCOPE, jti: randomUUID(), epoch: currentEpoch(db) })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(cfg.issuer)
        .setAudience(resource)
        .setSubject("user")
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(KEY);

      const rt = randomUUID();
      insertRefreshStmt.run(rt, resource, null, 1, Date.now());

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 8 * 3600,
        refresh_token: rt,
        scope: SCOPE,
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

      // 库里存的 resource 也必须**今天仍然有效**，不能只信它签发那天有效。
      // `/authorize` 用 isValidResource 挡非法 resource，但那道检查只在签发的那一刻
      // 生效；refresh 是唯一一条不经过 /authorize 就能签出 access token 的路径。
      // `endpointFor()` 一旦变化（D18 就把它从 `${issuer}/mcp/${repoId}` 改成了
      // `${issuer}/mcp`），旧 refresh_token 会**一直**签发 aud 已经没人认的 access
      // token：refresh 成功 → 拿去用 401 → 客户端再 refresh，陷在死循环里，而每一步
      // 单看都「成功」。实测中只能手工把该行置 valid=0 才解开。
      //
      // 拒成 invalid_grant（不是 invalid_target）：问题出在这枚凭据本身已经过时，
      // 客户端该做的是丢掉它重新走一次授权，而不是换个 resource 再试。同时吊销它，
      // 免得客户端反复拿同一枚失效凭据来撞。
      if (!isValidResource(cfg, rec.resource)) {
        invalidateRefreshStmt.run(rt);
        throw new OAuthError(
          "invalid_grant",
          `refresh_token 绑定的端点 ${rec.resource} 已不是本网关的有效端点，请重新走一次授权流程`,
        );
      }

      invalidateRefreshStmt.run(rt);

      const accessToken = await new SignJWT({
        scope: SCOPE,
        jti: randomUUID(),
        epoch: currentEpoch(db),
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(cfg.issuer)
        .setAudience(rec.resource)
        .setSubject("user")
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(KEY);

      const newRt = randomUUID();
      insertRefreshStmt.run(newRt, rec.resource, rt, 1, Date.now());

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 8 * 3600,
        refresh_token: newRt,
        scope: SCOPE,
      };
    }

    throw new OAuthError(
      "unsupported_grant_type",
      `不支持的 grant_type: ${form.grant_type}`,
    );
  }

  /**
   * D18：单一端点，因此只有一份受保护资源元数据——不再按 repoId 参数化。
   * `server.ts` 的合法别名路由（`/mcp/:repoId`）为了兼容旧连接器仍然存在，
   * 但它们的发现文档都指向这**同一份**元数据，不再各自生成一份。
   */
  function protectedResourceMetadata() {
    return {
      resource: cfg.endpointFor(),
      authorization_servers: [cfg.issuer],
      scopes_supported: [SCOPE],
    };
  }

  function authServerMetadata() {
    return {
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/authorize`,
      token_endpoint: `${cfg.issuer}/token`,
      registration_endpoint: `${cfg.issuer}/register`,
      jwks_uri: `${cfg.issuer}/jwks`,
      scopes_supported: [SCOPE],
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
    // 每次都读库，不缓存——缓存多久，`grande revoke` 就迟多久生效，
    // 而「立即生效」正是本检查存在的全部理由。见 src/tokenEpoch.ts。
    if (!isEpochCurrent(payload.epoch, currentEpoch(db))) {
      throw new OAuthError("invalid_token", "access token 已被吊销，请重新走一次授权流程");
    }
    return { sub: String(payload.sub ?? "") };
  }

  /**
   * 签一枚**只给本机自检用**的 access token（遗留 #4 下半，`grande selfcheck`）。
   *
   * ## 这不增加任何权限
   *
   * 签名密钥就在 `~/.grande-control/secrets/oauth-key`——能跑 `grande` 的人
   * 本来就读得到它，自签一枚 token 一直是可能的（2026-07-29 那次排查干的正是
   * 这件事，只是当时靠手写脚本）。这个函数不打开新的门，只是把一件已经可行、
   * 但每次都要现搓的事做对：issuer / audience / epoch 与真实签发路径完全一致，
   * 否则自检看到的就不是客户端看到的。
   *
   * ## 两条有意的收紧
   *
   * - **60 秒过期**，不是 8 小时。自检是一次性的，令牌活得越久越像个隐患。
   * - **调用方绝不打印它**。一枚有效 bearer 落进终端回滚区/日志，等于把
   *   「只有本机能做」变成「谁看过这块屏幕都能做」。`cli.ts` 里只在进程内
   *   传给 fetch，不 out()、不写盘。
   *
   * epoch 照常写入并取当前值——`grande revoke --yes` 之后自检应当同样被拒，
   * 那才是真实客户端的行为。
   */
  async function mintSelfCheckToken(): Promise<string> {
    return await new SignJWT({ scope: SCOPE, jti: randomUUID(), epoch: currentEpoch(db) })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(cfg.issuer)
      .setAudience(cfg.endpointFor())
      .setSubject("selfcheck")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(KEY);
  }

  return {
    register,
    authorize,
    token,
    protectedResourceMetadata,
    authServerMetadata,
    verifyBearer,
    mintSelfCheckToken,
  };
}
