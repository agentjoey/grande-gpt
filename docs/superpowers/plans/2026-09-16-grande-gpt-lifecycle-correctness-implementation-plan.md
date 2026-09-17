# Lifecycle Correctness Implementation Plan

## Task 1 — Durable PR / merge lifecycle

1. 增加 task-level durable PR receipt：固定 task ↔ PR identity；允许从 opened milestone 单向补齐 exact merge evidence，不允许 identity/merge evidence 被覆盖。
2. `grande_pr_open` 成功或幂等发现既有 PR 时写 opened receipt。
3. `grande_pr_merge` 正常 merge、发现外部已 merge、响应丢失后 observe/reconcile 三条路径都必须携带 exact task head + merge SHA；exact evidence 不足时禁止自动 cleanup。
4. `taskProgress` / legacy delivery target 优先读取 durable receipt；audit 仅保留 legacy fallback/history。
5. focused tests 覆盖 receipt immutable/idempotent、external merge、audit window eviction 后 projection、unsafe cleanup fail-closed。

## Task 2 — Task create / close crash recovery

利用 CREATING 和 durable closing intent；startup + periodic reconciliation 确定性恢复 orphan / ghost / residual。

## Task 3 — Authorization expiry convergence

过期 READY / APPROVED 自动 CAS 到 EXPIRED，释放 active unique slot，并写 audit。

## Task 4 — Inactive lifecycle projection

投影 waiting_human / waiting_ci / waiting_external / stalled_agent，并给出 cleanup eligibility；dirty / uncertain / unresolved delivery 永不自动 eligible。

## Final gate

第一批形成完整候选后仅跑一次完整 selfhost / typecheck / CI / Host gate；切片阶段不反复跑全量门禁。
