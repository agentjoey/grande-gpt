import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Layout } from "./layout.ts";
import { SCHEMA_VERSION as CONTRACT_VERSION } from "./contract.ts";

/**
 * 当前代码认识的 schema 版本，落在 SQLite 内置的 `PRAGMA user_version`（一个
 * 普通整数，SQLite 自己不使用它，专门留给应用层标记 schema 版本，新建的库默认
 * 是 0）。每次这里的 `CREATE TABLE` 语句发生不兼容变化（增删列、改类型……）就
 * 把这个数字加一。**不写迁移机制**——只需要「检测到不认识的版本就响亮拒绝」。
 *
 * `1 → 2`：新增 `oauth_client` / `oauth_refresh` 两张表。
 * `2 → 3`：D18 单一端点，删除 `oauth_refresh.repoId`。
 * `3 → 4`：S2 Verification Attestation。job 增加 run 启动时的工作区摘要与本机
 * 工具链字段，并新增 attestation 表，把通过的 job 绑定到随后产生的 commit sha。
 * `4 → 5`：token epoch。新增 `oauth_epoch` 单行表，让「吊销」能真的切断在途的
 * 无状态 access token（此前只能等 8 小时过期）。见 `src/tokenEpoch.ts`。
 * ⚠️ 升级到 5 之后**所有已签发的 access token 立即失效**（缺 epoch claim 一律拒绝），
 * 客户端需要重新授权一次——这是有意的，见 tokenEpoch.ts 里的取舍说明。
 * `5 → 6`：告警确认。新增 `audit_ack` 表——控制台的「标记为已知」**只追加确认记录，
 * 绝不修改 audit 原行**（账本不可篡改）。没有它，判据明确的异常会永远挂在首屏，
 * 两天后人就开始无视整个告警区，而那正是设计要避免的。
 *
 * S4 的 `task_brief` 与 S7 的 `deployment_receipt` 都是【向后兼容的附属表】：旧代码
 * 完全忽略它们，新代码可用 `CREATE TABLE IF NOT EXISTS` 在已匹配版本的库上安全补齐，
 * 因此不增加 user_version。两者都不改变既有表/列，也不扩张 Task 状态机。
 *
 * 导出是为了让测试断言跟着它走。**不要在测试里写死版本号**——那只会让每次升版
 * 多一道手改杂活，而真正的门禁是运行时那道（版本不符直接拒绝打开，线上表现为 502）。
 */
/** 单一真相源在 `contract.ts`——控制台也读那一份，改一处两边一起动。 */
export const SCHEMA_VERSION = CONTRACT_VERSION;

/** 打开状态库并保证 schema 就位；已有库版本必须与当前代码完全一致。 */
export function openDb(layout: Layout): DatabaseSync {
  mkdirSync(dirname(layout.stateDb), { recursive: true });
  const db = new DatabaseSync(layout.stateDb);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const hasExistingSchema =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('task','job','audit','attestation') LIMIT 1",
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

    CREATE TABLE IF NOT EXISTS task_brief (
      taskId    TEXT PRIMARY KEY REFERENCES task(taskId),
      briefJson TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployment_receipt (
      taskId      TEXT PRIMARY KEY REFERENCES task(taskId),
      receiptJson TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job (
      jobId           TEXT PRIMARY KEY,
      taskId          TEXT NOT NULL REFERENCES task(taskId),
      profile         TEXT NOT NULL,
      argv            TEXT NOT NULL,
      state           TEXT NOT NULL,
      pgid            INTEGER,
      exitCode        INTEGER,
      startedAt       INTEGER NOT NULL,
      endedAt         INTEGER,
      artifactPath    TEXT,
      summary         TEXT,
      workspaceDigest TEXT,
      hostToolchain   TEXT
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

    CREATE TABLE IF NOT EXISTS attestation (
      attestationId TEXT PRIMARY KEY,
      taskId        TEXT NOT NULL REFERENCES task(taskId),
      "commit"     TEXT NOT NULL,
      profile       TEXT NOT NULL,
      jobId         TEXT NOT NULL REFERENCES job(jobId),
      exitCode      INTEGER NOT NULL,
      startedAt     INTEGER NOT NULL,
      endedAt       INTEGER NOT NULL,
      hostToolchain TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_job_taskId       ON job(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_task       ON audit(taskId);
    CREATE INDEX IF NOT EXISTS idx_audit_state      ON audit(state);
    CREATE INDEX IF NOT EXISTS idx_attestation_task ON attestation(taskId);
    CREATE INDEX IF NOT EXISTS idx_attestation_job  ON attestation(jobId);

    CREATE TABLE IF NOT EXISTS oauth_client (
      clientId     TEXT PRIMARY KEY,
      redirectUris TEXT NOT NULL,
      createdAt    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_refresh (
      handle    TEXT PRIMARY KEY,
      resource  TEXT NOT NULL,
      parent    TEXT,
      valid     INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );

    -- 单行表（k 恒为 'access'）。递增 v = 所有在途 access token 当场失效。
    -- 见 src/tokenEpoch.ts；用户面是 grande revoke --yes。
    CREATE TABLE IF NOT EXISTS oauth_epoch (
      k TEXT PRIMARY KEY,
      v INTEGER NOT NULL
    );

    -- 告警确认。**只追加，不修改 audit 原行**——账本不可篡改是铁律。
    -- 「标记为已知」的语义是「我看过了，知道这回事」，不是「这条不存在」：
    -- 原行仍在账本里，只是不再占用首屏的告警位。
    CREATE TABLE IF NOT EXISTS audit_ack (
      opId    TEXT PRIMARY KEY,
      ackedAt INTEGER NOT NULL,
      note    TEXT
    );
  `);

  if (!hasExistingSchema) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}
