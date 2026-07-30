import type { DatabaseSync } from "node:sqlite";

/**
 * Token epoch —— 让「吊销」名副其实的那一个整数。
 *
 * ## 它解决什么
 *
 * access token 是 8 小时的**无状态** JWT，`verifyBearer` 原先只验签名/issuer/aud/过期，
 * **一次库都不查**。后果是：吊销 refresh token 完全不影响已经发出去的 access token，
 * 而 `/mcp` 只有 bearer 这一道门（Cloudflare Access 只挡 `/authorize`）。
 * 也就是说，一枚泄漏的 token 能从公网调用全部工具、最长 8 小时，**没有任何办法叫停**。
 *
 * epoch 是签发时写进 token 的一个整数。`verifyBearer` 拿它和库里的当前值比，小于就拒。
 * **递增一次 = 所有在途 access token 当场失效。**
 *
 * ## 为什么这行得通（实测过，不是推断）
 *
 * 网关长期持有一个 db 连接，而 `grande revoke` 是**另一个进程**在写。
 * 2026-07-30 实测：WAL 模式下，独立进程写入后网关同一个连接下一次读**立即**看到新值。
 * 这是整个特性成立的前提——如果看不见，revoke 就得等网关重启，那等于没做。
 * 对应测试：`tests/tokenEpoch.test.ts` 的「跨进程」那条。
 *
 * ## 有意的取舍
 *
 * - **全局，不分 client。** D2 是单用户，今天实际只有一个 client（ChatGPT）。
 *   等真有第二个再说；现在做 per-client 是造一个没有对象的区分。
 * - **每个请求一次 SQLite 读。** 本地库，可忽略。不缓存——缓存多久，revoke 就
 *   迟多久生效，那正是本特性要消灭的东西。
 * - 这让 `verifyBearer` 不再无状态。ChatGPT 那条「服务端必须无状态」约束指的是
 *   **会话**状态（不能把对话上下文留在内存里），不是认证状态，两者不冲突。
 */

/** 单行表，`k` 恒为 `'access'`。用表而不是 PRAGMA，是为了能跟其他写一起进事务。 */
const KEY = "access";

/**
 * 读当前 epoch。库里没有行时返回 1 而**不是** 0 —— 见 `assertEpochCurrent` 的说明：
 * 0 在 JS 里是 falsy，让「缺失」和「合法的最小值」撞在一起是找 bug 的好办法。
 */
export function currentEpoch(db: DatabaseSync): number {
  const row = db.prepare("SELECT v FROM oauth_epoch WHERE k = ?").get(KEY) as
    | { v: number }
    | undefined;
  return row?.v ?? 1;
}

/**
 * 递增 epoch，返回新值。**这一步就是吊销**——在此之后签发的 token 带新值，
 * 之前签发的一律作废。
 *
 * `INSERT ... ON CONFLICT DO UPDATE` 而不是「先读再写」：后者在两个 `grande revoke`
 * 撞在一起时会丢掉一次递增（都读到 3，都写 4）。丢掉一次递增在这里不致命
 * （结果仍然是「变大了」），但这是本项目已经犯过两次的 CAS 形状，不给它第三次机会。
 */
export function bumpEpoch(db: DatabaseSync): number {
  db.prepare(
    `INSERT INTO oauth_epoch (k, v) VALUES (?, 2)
     ON CONFLICT(k) DO UPDATE SET v = v + 1`,
  ).run(KEY);
  return currentEpoch(db);
}

/**
 * 判定一枚 token 的 epoch claim 是否仍然有效。
 *
 * **claim 缺失一律拒绝**，不当作「老 token，放行吧」。放行才是危险的那个方向：
 * 本特性上线前签发的 token 恰恰是我们最想切断的一批（它们诞生于「无法吊销」的时代）。
 * 代价是上线时所有客户端要重新授权一次——一次性的，可接受。
 */
export function isEpochCurrent(claim: unknown, current: number): boolean {
  return typeof claim === "number" && Number.isInteger(claim) && claim >= current;
}
