import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Layout } from "./layout.ts";

/**
 * 当前代码认识的 schema 版本，落在 SQLite 内置的 `PRAGMA user_version`（一个
 * 普通整数，SQLite 自己不使用它，专门留给应用层标记 schema 版本，新建的库默认
 * 是 0）。每次这里的 `CREATE TABLE` 语句发生不兼容变化（增删列、改类型……）就
 * 把这个数字加一。**不写迁移机制**——S0 阶段只需要「检测到不认识的版本就响亮
 * 拒绝」，不需要「自动把旧库改造成新库」；本 slice 已经改过一次 schema
 * （audit 表补 `reason` 列），后续 slice 还会再改，此刻先把检测钉住，迁移留给
 * 真正需要它的那一天。
 *
 * `1 → 2`：新增 `oauth_client` / `oauth_refresh` 两张表（U1 实测缺口的回归修
 * 复——client 与 refresh_token 原先只活在 oauth.ts 的内存 Map 里，网关一重启
 * 就全丢，ChatGPT 存的 `client_id` 立刻变成「未注册」）。旧库（`user_version=1`）
 * 没有这两张表，靠下面同一套版本检测响亮拒绝，不新开一条检测路径。
 *
 * `2 → 3`：D18（单一端点 + 任务绑定隔离）取代 D5（每-repo 端点）——`aud` 不再
 * 按 repo 区分，`oauth_refresh.repoId` 列因此失去意义，删掉而不是留一列永远
 * 写不出有意义值的字段。旧库（`user_version=2`）那一列还在，同样靠版本检测
 * 响亮拒绝。
 */
const SCHEMA_VERSION = 3;

/**
 * 打开状态库并保证 schema 就位。
 *
 * 用 Node 内置的 `node:sqlite` 而非 better-sqlite3：零依赖，与项目「能力面最小」
 * 的主线一致。代价是 Node 把它标为 experimental，API 可能随版本变化——因此
 * Node 版本锁定 24，且用 `--disable-warning=ExperimentalWarning` **精确**屏蔽
 * 那一条警告（不是全局关警告，其它警告仍应可见）。
 *
 * `stmt.get()` 返回 **null-prototype 对象**，断言时用 `toEqual` 而非 `toStrictEqual`。
 *
 * **Schema 版本检测**：没有版本号时，一个在旧 schema 下创建的库会静默通过
 * `openDb()`——`CREATE TABLE IF NOT EXISTS` 对已存在的表完全是 no-op，不会因为
 * 列对不上就报错——直到后面某次 `INSERT`/`UPDATE` 命中一个当时还不存在的列
 * （例如 audit 表的 `reason`），才在离病灶很远的地方抛出一个 `no such column`。
 * 那时候 `beginAudit()` 早已成功、`INTENT` 行已经落库，账本从此卡在半吊子状态
 * 且没有回头路（这正是 item 1 要堵的同一类「先斩后奏」问题，这里堵的是它在
 * schema 这一层的版本）。
 *
 * 做法：开库时先看 `task`/`job`/`audit` 这三张已知表里有没有任意一张已经存在——
 * 存在就说明这是一个**曾经被别的代码打开过**的库，此时它的 `user_version`
 * 必须与当前代码认识的 `SCHEMA_VERSION` 完全相等，否则立刻拒绝并把两个版本号
 * 都亮出来（不写只报「不匹配」三个字那种没法排障的错误）；不存在任何一张已知
 * 表，才说明这是一个真正全新的库，正常建表后把 `user_version` 写成
 * `SCHEMA_VERSION`。**没有迁移路径**：版本号变化时，把旧库删掉重新初始化是
 * 唯一支持的动作，这是有意的克制，不是遗漏。
 */
export function openDb(layout: Layout): DatabaseSync {
  mkdirSync(dirname(layout.stateDb), { recursive: true });
  const db = new DatabaseSync(layout.stateDb);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // 默认是 0：第二个写者一撞上第一个写者的锁就立刻抛 `database is locked`，
  // 不给并发写者留任何排队等待的余地。S0 已经是多个只读 CLI 调用与未来的工具
  // 写路径共享同一个库文件的场景，5s 足够盖过绝大多数单次事务的持锁时间，
  // 又不会把一次真正的死锁拖成看不出问题的长时间挂起。
  db.exec("PRAGMA busy_timeout = 5000");

  const hasExistingSchema =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('task','job','audit') LIMIT 1",
      )
      .get() !== undefined;

  if (hasExistingSchema) {
    const { user_version: onDisk } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (onDisk !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `状态库 schema 版本不匹配：代码期望 user_version=${SCHEMA_VERSION}，磁盘上的库是 ` +
          `user_version=${onDisk}（${layout.stateDb}）。这个库可能建自加入版本号之前的旧代码，` +
          `或者建自更新的代码。不做自动迁移——请人工确认后处理（例如备份后删除该文件，` +
          `让程序重新初始化一个空库）。`,
      );
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS task (
      taskId       TEXT PRIMARY KEY,
      repoId       TEXT NOT NULL,
      branch       TEXT NOT NULL,
      baseCommit   TEXT NOT NULL,
      worktreePath TEXT NOT NULL,
      state        TEXT NOT NULL,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL,
      stateVersion INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job (
      jobId        TEXT PRIMARY KEY,
      taskId       TEXT NOT NULL REFERENCES task(taskId),
      profile      TEXT NOT NULL,
      argv         TEXT NOT NULL,
      state        TEXT NOT NULL,
      pgid         INTEGER,
      exitCode     INTEGER,
      startedAt    INTEGER NOT NULL,
      endedAt      INTEGER,
      artifactPath TEXT,
      summary      TEXT
    );

    CREATE TABLE IF NOT EXISTS audit (
      opId         TEXT PRIMARY KEY,
      taskId       TEXT,
      tool         TEXT NOT NULL,
      inputDigest  TEXT NOT NULL,
      decision     TEXT NOT NULL,
      state        TEXT NOT NULL,
      pathsTouched TEXT NOT NULL,
      reason       TEXT,
      at           INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_taskId  ON job(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_task  ON audit(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_state ON audit(state);

    -- OAuth client 与 refresh_token 都要长期存活（client_id 是 ChatGPT 无限期
    -- 复用的标识；refresh_token 存在的意义就是"跨重启不用重新授权"），所以落库。
    -- 授权码（code）刻意不落库——见 oauth.ts 里 codes 那个 Map 上的注释。
    CREATE TABLE IF NOT EXISTS oauth_client (
      clientId     TEXT PRIMARY KEY,
      redirectUris TEXT NOT NULL,   -- JSON array
      createdAt    INTEGER NOT NULL
    );

    -- D18：resource 现在对每一枚 token 都是同一个值（单一端点），不再需要
    -- repoId 列——见上面 SCHEMA_VERSION 的 "2 → 3" 注释。
    CREATE TABLE IF NOT EXISTS oauth_refresh (
      handle    TEXT PRIMARY KEY,
      resource  TEXT NOT NULL,
      parent    TEXT,
      valid     INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);

  // 只在「真正新建」这一次盖版本号；已有 schema 的库在上面已经验过版本相等，
  // 没有必要（也不应该）重新写一遍同一个值。
  if (!hasExistingSchema) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}
