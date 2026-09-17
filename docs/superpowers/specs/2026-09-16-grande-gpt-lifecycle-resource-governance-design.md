# GrandeGPT Lifecycle & Resource Governance

## Scope

本阶段只解决两个层级的问题：第一批是 lifecycle correctness，第二批是 resource/performance governance。当前实现先完成第一批，再进入第二批。

### 第一批：Lifecycle correctness

1. PR lifecycle：PR identity / merged milestone 必须 durable；audit 只记录历史，不再作为当前状态唯一来源。外部 merge 必须在 exact PR head + exact merge SHA 证据成立后才允许 cleanup。
2. Task crash recovery：正式利用 CREATING，并增加 closing intent / 等价 durable intent；startup + periodic reconciliation 恢复 orphan / ghost / residual。
3. Authorization expiry：过期 READY / APPROVED 收敛为 EXPIRED，释放新的 proposal，并留下 durable state + audit。
4. Inactive projection：区分 waiting_human / waiting_ci / waiting_external / stalled_agent，并输出 fail-closed cleanup eligibility。

### 第二批：Resource/performance governance

Per-task/global job admission、controlled cancel、cache/artifact/log retention、low-disk admission、compact/paginated status、repo_map byte-aware pagination、减少 status 重复 Git/file traversal。

## Guardrails

- 不引入 generic workflow engine 或第二套 Task 状态机。
- 不开放 generic shell / host exec。
- audit 是事件账本，不是 lifecycle current-state store。
- dirty / unpushed / uncertain / unresolved deployment 一律 fail closed，不因 TTL 自动删除 active worktree。
- bounded change；每个切片 RED → minimal GREEN → proportional regression → independent review。
