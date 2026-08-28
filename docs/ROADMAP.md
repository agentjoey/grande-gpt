## phase-7: Phase 7 — Reliability Foundation

```yaml alljobs
id: phase-7
kind: phase
status: done
order: 70
```

**Status**：DONE（2026-08-23）
**范围**：`GG-BL-007`、`GG-BL-017`、`GG-BL-018`、`GG-BL-019`。
**Closeout evidence**：implementation PR #22；exact head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa`；local `unit-selfhost` 109 files / 859 tests PASS、`typecheck` PASS、GitHub Actions PASS、Host outer-test 10 files / 171 tests PASS；merge SHA `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`；production activation receipt 后续成功读回。公开 contract 保持 25 tools / epoch 2。

## phase-8: Phase 8 — Flow Simplification

```yaml alljobs
id: phase-8
kind: phase
status: done
order: 80
```

**Status**：DONE（2026-08-23）
**范围**：`GG-BL-020`、`GG-BL-021`、`GG-BL-022`、`GG-BL-023`。
目标是在 **不改变公开 `tools/list`** 的前提下减少正常开发轮次和无意义 Human Gate：内部 delivery-target projection、短 job bounded wait、PR/verifier continuation、L1/L2/L3 风险分级。
**范围边界**：Phase 8 完成的是 no-tool-epoch 内部 primitive/projection。**公开 `TaskBrief.deliveryTarget` schema 不属于 Phase 8**，与 public tool-surface convergence 一并留给 Phase 9 / `GG-BL-024`。
**退出条件已满足**：
- internal `local / pr / deploy` projection 能屏蔽无关阶段，并维持单一 blocker + nextAction；
- 短 `grande_run` 在固定 bounded-wait 预算内可直接返回 terminal result，长 job 保留稳定 jobId/recovery；
- 正常 PR 可直接进入 merge gate，`pr_status` 按需诊断；同一 task authorization 下可在 verifier/Host gate 后重新进入 merge，且每次重新读取 exact-SHA gates；
- L1/L2/L3 classifier 与 coding-agent policy 正式落地，未知路径 fail closed 到 L3；
- production tool identity 仍为 25 tools / epoch 2 / 原 digest。
**Closeout evidence**：implementation PR #25；exact head `e902877854e2513cfa1d6545ffb15b22cc8410f9`；`unit-selfhost` 112 files / 871 tests PASS、`typecheck` PASS、GitHub Actions PASS、manual-only Host outer-test 10 files / 172 tests PASS；merge SHA `217a2dadc2887046decdeb9ab3c2813060ae7d97`。production activation receipt 已由后续 `grande_task_status` 读回：`targetBuild = runtimeBuild = git:217a2dadc2887046decdeb9ab3c2813060ae7d97`、`toolsetEpoch=2`、`toolsCount=25`、`toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`、LaunchAgent running、endpoint ready、trusted read probe HTTP 200。详细见 [`docs/research/2026-08-23-phase8-flow-simplification-closeout.md`](research/2026-08-23-phase8-flow-simplification-closeout.md)。

## phase-9: Phase 9 — Tool Surface Convergence

```yaml alljobs
id: phase-9
kind: phase
status: paused
order: 90
```

**Status**：BLOCKED before public contract change（`GG-BL-010` release-ready gate）
**范围**：`GG-BL-024`。
目标是把 Phase 8 已验证的内部流程语义，在 **一次正式 Tool Epoch** 中收敛公开 MCP surface，而不是零散增删工具。
**进入条件**：
1. Phase 7、Phase 8 完成；**已满足**。
2. `GG-BL-010` 达到 release-ready 稳定门槛：§7.2 `C-Web-1 + C-iOS + C-Web-2` 三次 same-conversation two-task formal runs 已于 2026-08-23 **3/3 PASS**；server tool identity 与 client/session binding snapshot 可区分，已有可靠 App refresh/new-session release procedure。当前仍需完成 §7.3 **7-day ordinary-use observation**：至少 5 个普通 conversation、每个至少 2 个真实任务、覆盖 Web 与当前实际 capability-supported 的 iOS，且无 unexplained disablement；**formal matrix 已满足，整体 release-ready gate 仍未满足**。
3. 在条件 2 满足前，production **25-tool contract 冻结**，除阻断性安全/可靠性修复外不主动改变工具快照。
**一次性变更目标**：
- public `TaskBrief.deliveryTarget = local | pr | deploy` 正式进入 contract，并复用 Phase 8 已验证的内部 projection 语义；
- `grande_repo_add_propose` + `grande_repo_add_apply` → 单一 `grande_repo_register`，继续保留 proposalDigest + Human Gate 两阶段语义；
- `grande_capability_inspect` → `grande_capability_list` filter；
- `grande_deploy_verify` → 可重入 `grande_deploy`；
- 正常完成路径将 `grande_task_close` 移出公开 MCP，异常/放弃任务继续走 CLI/Console；
- 不长期同时暴露新旧 alias，不为了整数目标合并风险不同的核心工具。
**退出条件**：新 tool count/epoch/digest 稳定；Dev App 与 Production App 完成 refresh；所有当时实际 capability-supported 的目标 release clients 完成 fresh conversation 真实任务；失败时可直接回滚上一 Gateway build/tool epoch。

## phase-10: Phase 10 — Internal Convergence

```yaml alljobs
id: phase-10
kind: phase
status: planned
order: 100
```

**Status**：NOT STARTED
**范围**：`GG-BL-025`。
目标是只根据最新代码的真实重复与耦合证据，收敛内部 process supervision、receipt eligibility、tool assembly 与 deployment/capability 调用路径。
**进入条件**：Phase 9 新公开 contract 已稳定，或某个独立内部缺陷有足够证据证明必须提前处理。
**退出条件**：只关闭仍真实存在的重复实现；没有为了“架构更漂亮”新增 workflow engine、通用 middleware framework、第二套状态系统、第二个 Gateway 或新的 provider graph。

## maintenance: Maintenance lane

```yaml alljobs
id: maintenance
kind: phase
status: active
order: 99
```
