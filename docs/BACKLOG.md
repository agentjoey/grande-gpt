# GrandeGPT Backlog

> **Canonical backlog / single source of truth**
>
> 本文件是 GrandeGPT 当前 backlog 的唯一权威索引。`CLAUDE.md`、`docs/research/**`、PR/TaskBrief 和聊天结论只能作为 evidence/detail，**不得单独维护当前状态**。任何新 backlog、优先级变化、关闭或去重都必须更新本文件。

最后整理：2026-08-23

## 维护规范

### ID

- 格式：`GG-BL-NNN`，一经分配不复用、不改号。
- 同一根因的重复复现更新原条目的 Evidence，不新开重复 ID。
- 后来确认是另一根因时才拆新 ID，并在两边写 `Related`。

### Priority

| Priority | 含义 |
|---|---|
| **P0** | 破坏 Golden Path、可导致 production outage / 数据或安全边界风险、或已重复出现且会污染后续任务基线。优先于新功能。 |
| **P1** | 重要可靠性/运维缺陷；有 workaround，但会持续制造人工介入、误判或闭环摩擦。 |
| **P2** | 应修的可用性、韧性、least-privilege 或维护问题；不阻塞当前主流程。 |
| **P3** | 低优先级文档/兼容性清理。 |
| **OBS** | 外部平台行为或证据不足的观察项；先收集复现，不默认承诺 GrandeGPT 代码修复。 |

### Status

| Status | 含义 |
|---|---|
| **OPEN** | 问题成立，尚未完成修复。 |
| **MITIGATED** | 已有有效缓解，但根因/自动闭环仍未完成。 |
| **OBSERVATION** | 仅观察；需要更多证据或属于外部平台。 |
| **BLOCKED** | 修复方向明确，但依赖 Human/external platform。 |
| **DONE** | 完成判据已被证据满足。DONE 条目保留 ID，移到 Archive，不删除。 |

`ACCEPTED` 不作为 backlog status。明确接受且不计划修的架构取舍放在 `CLAUDE.md` 的 **已接受的风险**。

### 写入与关闭纪律

- **先查重**：新发现先搜索 `GG-BL-*` 与标题关键词；重复复现追加 Evidence。
- **证据与状态分离**：research 文档允许很长，但当前 priority/status 只在这里维护。
- **修复不等于关闭**：代码 merge 后必须满足 `Done when`；涉及 production 的还要有 runtime/host 行为证据。
- **关闭不删除**：改为 `DONE` 并移到 Archive，写明修复 PR/commit/验证证据。
- **部分修复**：保留原 ID，状态改 `MITIGATED`，明确还剩什么。
- **外部平台**：用 `OBS / OBSERVATION`；不要为了适配平台偶发现象降低 Gateway policy、annotations 或绕过安全边界。
- **详细文档不双写状态**：`docs/research/**` 只保存时间线、复现和设计背景；若其中旧状态与本文件冲突，以本文件为准。

## Roadmap after Phase 6

本区只维护 **Phase 顺序、范围与进入/退出条件**；每个 backlog 的实时 `Priority / Status` 仍以对应条目为唯一权威。

### Phase 7 — Reliability Foundation

**Status**：DONE（2026-08-23）

**范围**：`GG-BL-007`、`GG-BL-017`、`GG-BL-018`、`GG-BL-019`。

**Closeout evidence**：implementation PR #22；exact head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa`；local `unit-selfhost` 109 files / 859 tests PASS、`typecheck` PASS、GitHub Actions PASS、Host outer-test 10 files / 171 tests PASS；merge SHA `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`；production activation receipt 后续成功读回。公开 contract 保持 25 tools / epoch 2。

### Phase 8 — Flow Simplification

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

### Phase 9 — Tool Surface Convergence

**Status**：BLOCKED before public contract change（`GG-BL-010` release-ready gate）

**范围**：`GG-BL-024`。

目标是把 Phase 8 已验证的内部流程语义，在 **一次正式 Tool Epoch** 中收敛公开 MCP surface，而不是零散增删工具。

**进入条件**：

1. Phase 7、Phase 8 完成；**已满足**。
2. `GG-BL-010` 达到 release-ready 稳定门槛：完成 `C-Web-1 + C-iOS + C-Web-2` 三次 same-conversation two-task formal runs，其中 iOS 因当前目标客户端已真实暴露 GrandeGPT capability 而纳入；server tool identity 与 client/session binding snapshot 可区分，已有可靠 App refresh/new-session release procedure，且最近没有新的 unexplained `tool disabled` recurrence。若某目标客户端在 gate 开始前已不再暴露 custom MCP capability，必须记录版本/时间/capability absence 并显式 rebaseline，不把不可达产品路径变成永久 hard gate；**当前未满足**。
3. 在条件 2 满足前，production **25-tool contract 冻结**，除阻断性安全/可靠性修复外不主动改变工具快照。

**一次性变更目标**：

- public `TaskBrief.deliveryTarget = local | pr | deploy` 正式进入 contract，并复用 Phase 8 已验证的内部 projection 语义；
- `grande_repo_add_propose` + `grande_repo_add_apply` → 单一 `grande_repo_register`，继续保留 proposalDigest + Human Gate 两阶段语义；
- `grande_capability_inspect` → `grande_capability_list` filter；
- `grande_deploy_verify` → 可重入 `grande_deploy`；
- 正常完成路径将 `grande_task_close` 移出公开 MCP，异常/放弃任务继续走 CLI/Console；
- 不长期同时暴露新旧 alias，不为了整数目标合并风险不同的核心工具。

**退出条件**：新 tool count/epoch/digest 稳定；Dev App 与 Production App 完成 refresh；所有当时实际 capability-supported 的目标 release clients 完成 fresh conversation 真实任务；失败时可直接回滚上一 Gateway build/tool epoch。

### Phase 10 — Internal Convergence

**Status**：NOT STARTED

**范围**：`GG-BL-025`。

目标是只根据最新代码的真实重复与耦合证据，收敛内部 process supervision、receipt eligibility、tool assembly 与 deployment/capability 调用路径。

**进入条件**：Phase 9 新公开 contract 已稳定，或某个独立内部缺陷有足够证据证明必须提前处理。

**退出条件**：只关闭仍真实存在的重复实现；没有为了“架构更漂亮”新增 workflow engine、通用 middleware framework、第二套状态系统、第二个 Gateway 或新的 provider graph。

### Maintenance lane

- `GG-BL-006`、`GG-BL-008`、`GG-BL-009` 保持独立 maintenance lane，不为凑 Phase 范围强行并入 Phase 7–10。
- `GG-BL-010` 继续保持 P0 / MITIGATED，并作为 Phase 9 的 release gate；不得用改变 tool contract 的方式“试试看能不能修”。
- `GG-BL-011`、`GG-BL-012` 继续保持 observation，不因 roadmap 自动升格工程项。

## Active backlog

### GG-BL-006 — `selfcheck` 对交互 shell 的 `GRANDE_ISSUER` 依赖易误判

- **Priority**: P2
- **Status**: OPEN
- **Category**: operations UX
- **Problem**: LaunchAgent/Gateway 已正常配置 production issuer 时，普通 shell 直接运行 `grande selfcheck` 仍会因 shell 未设置 `GRANDE_ISSUER` 而失败，容易被理解成 Gateway outage。
- **Evidence / Detail**: [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md)。
- **Next**: 不降低 issuer/audience 校验；优先改善诊断文本和 `gateway status` 的可信 issuer 展示。
- **Done when**: shell 缺 issuer 时输出能清楚区分“CLI 环境缺失”和“Gateway 不健康”，并保持 fail-closed。

### GG-BL-008 — GitHub fine-grained PAT least-privilege 与生命周期

- **Priority**: P2
- **Status**: OPEN
- **Category**: security / operations
- **Problem**: 历史 PAT 配置包含当前切片用不到的部分写权限，并记录了到期时间；权限与有效期需要按当前真实 repo/功能重新核对。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #10；历史记录也指出 `GET /user/repos` 不能证明 fine-grained repository grant。
- **Next**: 用当前 GitHub 功能矩阵重新做 least-privilege review，并在 credential health/doctor 中提供可操作诊断。
- **Done when**: production PAT 权限与 GrandeGPT 当前所需操作一一对应，过期/失效有明确预警或 runbook，且真实 push/PR/CI/merge 验证通过。

### GG-BL-009 — 历史 S0 文档仍含过期 `repo_edit` 能力描述

- **Priority**: P3
- **Status**: OPEN
- **Category**: docs
- **Problem**: 部分历史 S0 文档仍写 `repo_edit` 不支持 delete，与 S1+ 当前能力不同。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #8。
- **Next**: 仅在容易被误当当前规格的入口加 historical/superseded 标记；不大规模重写历史记录。
- **Done when**: 当前权威入口不会把读者导向旧能力结论，历史文件保留但明确 superseded。

### GG-BL-010 — 当前会话的 GrandeGPT direct tool execution channel 会被禁用

- **Priority**: P0
- **Status**: MITIGATED
- **Category**: reliability / ChatGPT App session binding
- **Problem**: GrandeGPT App/插件仍显示 installed/enabled、server schema/tool discovery 正常时，某个运行中的 ChatGPT 会话仍可能在真实 `grande_*` 调用时直接 disabled，随后该会话无法继续使用 GrandeGPT。
- **Evidence / Detail**: 早期样本见 [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md) 与 [`docs/chatgpt-connector-compatibility-runbook.md`](docs/chatgpt-connector-compatibility-runbook.md)。已有 89 次、256 次调用后 pre-Gateway disable 样本，以及 installed/enabled、schema discovery 可见时首次真实调用即 disabled 的样本；还观察过 client snapshot 23 tools 而同一 production Gateway 为 25 tools / epoch 2，证明 session/app binding 与 server tool identity 可分叉。
- **Release A evidence (2026-08-21)**: candidate `7b98f7dce2f0b10723b29be64ca28e1438f1a779` 加入真实 `buildTools` handler/fixture 行为回归与 canonical result-budget coverage；exact candidate Host boundary 验证为 **5 files / 160 tests PASS**。该历史证据继续作为 connector-compatibility 文档契约的一部分，不因为 Phase 8 closeout 被压缩掉。
- **Mitigation**: 保留 server-side toolset identity、32 KiB result budget、单次终态 result、有界轮询/分页、compatibility runbook 与长会话真实工具调用回归；不降低 annotations、不绕过 Gateway、不增加第二执行通道。
- **2026-08-23 Phase 8 evidence**: Phase 8 在不改变 25-tool identity 的情况下完成大量真实 status/read/edit/run/PR/merge 调用并成功 activation，说明 flow simplification 可独立发布；这**不等于** binding drift 已根因关闭。
- **2026-08-23 target-client capability evidence**: OpenAI Help Center 当日公开说明仍写 custom/full MCP apps mobile unavailable / web only，但 Human Owner 当前 ChatGPT iOS 原生会话可以真实连续调用 GrandeGPT direct tools。平台文档与实际 rollout/account/product-path 存在冲突；本项目 release gate 因此以目标客户端真实 capability 为准。当前 iOS capability 已确认，所以本轮 formal matrix 仍包含 iOS。
- **Remaining**: 完成 `C-Web-1 + C-iOS + C-Web-2` 三次 same-conversation two-task formal gate；每次保持 frozen build/epoch/count/digest、无 reconnect/refresh/restart，Task A/B 各 ≤50 external calls、合计 result ≤1 MiB、单 result ≤32 KiB，并对账 Gateway correlation。随后完成 7 天 ordinary-use observation，至少 5 个 conversation、每个 ≥2 个真实任务，覆盖 Web 与当时实际 capability-supported 的其他目标客户端。该 Remaining 同时构成 Phase 9 public Tool Epoch 的 release gate。
- **Escalation**: 若在 frozen identity / under-budget 条件下出现两个独立、当前 epoch、证据完整的 pre-Gateway disable 样本，且失败调用未到 Gateway、无 401/restart/identity change，则停止继续通过 server payload/OAuth/annotations/tools-list 试探，转 `BLOCKED — ChatGPT platform/session binding boundary` 并附完整证据。
- **Done when**: **跨客户端两任务** formal matrix 三次全绿，随后 7 天 / ≥5 ordinary conversations 无 unexplained disablement，或获得可控根因并证明长期稳定后再转 DONE。当前保持 MITIGATED。

### GG-BL-024 — 下一次 Tool Epoch 收敛公开 MCP surface

- **Priority**: P2
- **Status**: BLOCKED
- **Category**: MCP contract / tool surface
- **Problem**: 当前 25-tool contract 中仍有 onboarding 两工具、capability inspect、deploy verify、task close 等可在保持风险语义的前提下合并或内部化；Phase 8 的 internal delivery-target projection 也尚未进入 public TaskBrief schema。零散修改 tools/list 会放大 ChatGPT binding/snapshot 排障变量。
- **Evidence / Detail**: 2026-08-22 owner-approved simplification proposal 要求一次正式 tool epoch 收敛；Phase 8 已完成 no-tool-epoch primitives，且 production 仍保持 25 tools / epoch 2 / 原 digest。`GG-BL-010` 证明 session/app binding 与 server tool identity 可分叉，因此本项目前被 release gate 阻塞。
- **Next**: **先完成 `GG-BL-010` release-ready gate，不提前改 production contract。** gate 满足后一次 release 完成：① public `TaskBrief.deliveryTarget`；② `repo_add_propose/apply → grande_repo_register`；③ capability inspect 并入 list filter；④ deploy verify 并入可重入 deploy；⑤正常完成路径移除公开 task_close；⑥ bump toolset epoch 并执行 Dev/Production App refresh。
- **Done when**: ①旧 25-tool identity 与新 identity 明确不同且新 count/epoch/digest 稳定；② public deliveryTarget 正式可选且扩大外部副作用需要 Human confirmation；③删除工具不再出现在 tools/list；④ `repo_register` 不接受 path/force，proposal 零写入，register 保持 Human Gate/stale protection；⑤ deploy 重入不重复外部副作用；⑥ task 自动 cleanup 不暴露通用 delete；⑦ Dev/Production App refresh 后所有当时实际 capability-supported 的目标 release clients 用 fresh conversation 完成真实任务；⑧失败可直接 rollback 上一 Gateway build/tool epoch。

### GG-BL-025 — 内部执行、receipt 与 tool assembly 存在潜在重复和隐式耦合

- **Priority**: P3
- **Status**: OPEN
- **Category**: architecture / maintainability
- **Problem**: 2026-08-22 架构评审指出 runner/host verifier process supervision、job/receipt JSON eligibility、公开 tool handler 互调以及 handler wrapping/assembly 可能存在重复实现或隐式顺序耦合；设计基线早于部分 Phase 6–8 改动，不能把旧快照直接当成当前代码事实。
- **Evidence / Detail**: owner-reviewed lightweight architecture design；Phase 8 新增 flow wrapper 后更应先做最新 canonical evidence review，而不是直接抽象框架。
- **Next**: 先做 code evidence review。只对仍存在且至少有两个真实使用者的重复 primitive 做收敛；禁止建设 workflow engine、通用 interceptor framework、第二状态系统或 capability marketplace。
- **Done when**: ①逐项 evidence review 完成并删除已经不存在的 scope；②若 runner/verifier 确有重复，仅保留一套窄 process lifecycle primitive；③ receipt/job eligibility 有单一 fail-closed parser/validator；④ deployment 不通过公开 MCP handler 触发内部领域动作；⑤写工具 wrapper 顺序有集中测试且不依赖共享可变 ToolDef；⑥没有新增与轻量定位冲突的通用框架。

## Observations

### GG-BL-011 — `grande_repo_search` 的 truncated 信号曾被忽略

- **Priority**: OBS
- **Status**: OBSERVATION
- **Category**: agent UX
- **Problem**: 曾有一次模型收到 `truncated + nextCursor` 后没有继续分页。
- **Next**: 收集重复样本；若成为稳定失败模式，再考虑 guidance/UI 改善。
- **Done when**: 重复证据足以升格工程项，或长期无复现后由 Human Owner 明确归档。

### GG-BL-012 — `/.well-known/openid-configuration` 返回 404

- **Priority**: OBS
- **Status**: OBSERVATION
- **Category**: OAuth compatibility
- **Problem**: ChatGPT/其他客户端可能探测 OIDC discovery path；GrandeGPT 当前提供 OAuth authorization-server metadata，现有 OAuth 流程正常，但该路径仍为 404。
- **Next**: 仅在真实客户端兼容性要求出现时评估别名/兼容端点。
- **Done when**: 出现真实需要后实现并验证兼容，或确认长期无需支持并由 Human Owner 归档。

## Not backlog

以下内容**不要**重复创建 backlog：

- `CLAUDE.md` 的 **已接受的风险**：明确取舍，不是待办；除非 Human Owner 重新打开决策。
- `package.json` 的 `postinstall/prepare` 宿主执行风险：当前是已知且有意保留的安全/可用性取舍；若威胁模型变化再建立新 ID。
- 已修复并有验证证据的历史事故（token epoch、loopback bind、schema arg validation、outer-test 等）：保留历史记录，不重新进入 Active。
- research 文档中的旧 priority/status：只作为当时快照，当前状态以本文件为准。

## Archive

### GG-BL-001 — PR 已 merge，但 local canonical `main` 仍旧

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: S16 引入受控 canonical refresh：固定 registered repo、origin/current canonical branch、clean precondition、fetch+compare+fast-forward-only；dirty/diverged fail closed；`task_open` 基于 refresh 后 canonical。
- **Verification evidence**: canonical refresh / task-open 行为与 fail-closed 测试纳入 Phase 5.5 gates。

### GG-BL-002 — `grande gateway restart` 非 failure-safe

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: loaded restart 使用 `kickstart -k`；unloaded bootstrap error 5 有限重试；restart success 前等待 endpoint readiness，并暴露 runtime identity。
- **Verification evidence**: fresh `unit-selfhost`/typecheck；S17 production acceptance 10/10 restart 全绿。

### GG-BL-003 — `grande_sync_base` 方向与 `up-to-date` 文案误导

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: contract 明确 canonical → task，绝不修改 canonical；relation 为 `equal/task_ahead/canonical_ahead/diverged`。
- **Verification evidence**: task-ahead / canonical-ahead / diverged 行为回归纳入 Phase 5.5 tests。

### GG-BL-004 — Merge 与 production runtime activation 仍是两步

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: release activation evidence 显式化，通过 `gatewayBuild/toolsetEpoch/toolsCount/toolsDigest` 识别实际 runtime，不再把 merged 等同于 activated。
- **Verification evidence**: S17 10/10 restart acceptance 与真实 read probes；后续由 GG-BL-019 durable activation receipt 完整收敛。

### GG-BL-005 — GC 看不到 `CLOSED` 但 worktree 残留

- **DONE date**: 2026-08-22
- **Task**: `task-p1-20260822-001`
- **Fix**: 增加 `closedResidualWorktrees` reconciliation，受管 path + current-state recheck + existing `removeWorktree`，Gateway 启动只报告不自动删除。
- **Verification evidence**: real Git worktree fixtures；candidate `unit-selfhost` 98 files / 827 tests PASS、`typecheck` PASS。

### GG-BL-013 — Host outer-test 自动形成 exact-SHA merge gate

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 S18，后续由 Reliability & Automated Host Verifier supersede
- **Fix**: exact-SHA/current-plan Host receipt gate，后升级为 controlled automatic Host Verifier；manual CLI 保留为受信 fallback/manual-only Human Gate。
- **Verification evidence**: receipt persistence/expiry、restricted async verifier、Receipt V2、startup reconciliation 与 bounded infra retry；production controlled auto mode 已 activation。

### GG-BL-014 — 长任务可能在只读分析后静默停滞

- **DONE date**: 2026-08-22
- **Task**: `task-p1-20260822-001`
- **Fix**: `TaskProgress` 增加只读 liveness projection，不写 heartbeat、不新增生命周期状态；stalled 不伪装 blocker。
- **Verification evidence**: deterministic regression；candidate `unit-selfhost` 98 files / 827 tests PASS、`typecheck` PASS。

### GG-BL-015 — Auto Verifier 缺少最小可信运行可观察性

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 6 S19 / `task-p6-20260822-001`
- **Fix**: `grande_task_status` 增加 trusted host-verifier operational snapshot，无新 MCP tool/metrics store/queue。
- **Verification evidence**: behavior tests；Phase 6 code gate 97 files / 817 tests PASS、`typecheck` PASS。

### GG-BL-016 — Auto Verifier 失败分类与升级语义不完整

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 6 S20 / `task-p6-20260822-001`
- **Fix**: `candidate | infrastructure | integrity` failure taxonomy；bounded infra retry、integrity zero-retry fail closed、SHA isolation。
- **Verification evidence**: load-bearing tests；Phase 6 code gate 97 files / 817 tests PASS、`typecheck` PASS。

### GG-BL-007 — Control-plane backup、SQLite migration 与 restore 路径不完整

- **Priority**: P1
- **Status**: DONE
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: ordered 5→6 migration、verified pre-migration backup、transaction rollback、managed backup root/retention、dry-run Human restore、ordinary backup excludes `secrets/`。
- **Verification evidence**: real version-5 fixtures；Phase 7 exact candidate 109/859 PASS、typecheck PASS、PR #22 CI/Host gates PASS。

### GG-BL-017 — Gateway / CLI 缺少跨进程 repo write lock

- **Priority**: P1
- **Status**: DONE
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: trusted control-root per-repo cross-process lock，live PID busy fail closed、ESRCH stale recovery、malformed metadata fail closed、nonce ownership release；Gateway writes 与 Git/worktree-writing CLI 共用。
- **Verification evidence**: two-process behavior tests；Phase 7 exact candidate 109/859 PASS、typecheck/CI/Host PASS。

### GG-BL-018 — GrandeGPT 自身缺少最小独立 CI gate

- **Priority**: P1
- **Status**: DONE
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: pinned macOS GitHub Actions CI，Node 24、pnpm 10.33.0、frozen lockfile、selfhost-safe tests、typecheck、focused tool-contract checks。
- **Verification evidence**: final exact PR head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa` Actions run PASS；Host 10/171 PASS。

### GG-BL-019 — Production activation 缺少 durable evidence / receipt

- **Priority**: P1
- **Status**: DONE
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: durable activation receipt 绑定 target/runtime build、toolset epoch/count/digest、activation time、LaunchAgent/endpoint readiness 与 trusted read probe；mismatch fail closed。
- **Verification evidence**: Phase 7 activation receipt 跨会话成功读回；Phase 8 再次使用同一路径并读回 build `217a2dadc2887046decdeb9ab3c2813060ae7d97`，证明机制持续有效。

### GG-BL-020 — Task 缺少 delivery-target projection

- **Priority**: P2
- **Status**: DONE
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 8 / `task-p8-20260823-001`
- **Fix**: 新增内部 `DeliveryTarget = local | pr | deploy` domain primitive 与 TaskProgress projection，基于可信现有 evidence/default 解析目标并屏蔽无关阶段，重新计算单一 blocker/nextAction。Phase 8 按批准的 no-tool-epoch 范围**未**改变 public TaskBrief schema；public explicit target 选择和外部副作用扩大确认移交 `GG-BL-024`。
- **Verification evidence**: delivery-target regressions 覆盖 local masking、PR 不要求 deploy、deploy 缺可信 spec fail closed、PR opened 后直达 merge action；Phase 8 exact candidate 112/871 PASS、typecheck/CI/Host PASS，production activation readback PASS。

### GG-BL-021 — 短 job 普遍需要 `grande_run → grande_run_result` 两次调用

- **Priority**: P2
- **Status**: DONE
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 8 / `task-p8-20260823-001`
- **Fix**: `grande_run` response layer 使用现有 `waitForTerminalJob` 最多观察 5 秒；预算内直接返回 terminal result，超预算返回稳定 jobId + poll hint；runner 仍拥有进程 lifecycle，artifact/shutdown/timeout/RSS/recovery 语义不变。
- **Verification evidence**: short/slow regressions；Host `tools.host.test.ts` 同时验证长 job bounded wait 与短 job first-call terminal；Phase 8 Host 10 files / 172 tests PASS。

### GG-BL-022 — 正常 PR / verifier 流程存在不必要状态往返

- **Priority**: P2
- **Status**: DONE
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 8 / `task-p8-20260823-001`
- **Fix**: TaskProgress PR projection 不再把预先 `pr_status` 当强制阶段；正常路径直接进入 `grande_pr_merge`，blocker 后才按需诊断。merge authority/exact-SHA checks 保持在 merge gate，verifier/runner 不获得 merge 权限。
- **Verification evidence**: PR #25 dogfood：direct merge → CI pending blocker → on-demand status → merge re-entry → real manual-only Host gate → receipt 后再次 merge；最终 PR #25 成功 merge，证明 continuation 减少往返但安全 gate 未退化。

### GG-BL-023 — 开发风险等级未正式落地，普通修改流程过重

- **Priority**: P2
- **Status**: DONE
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 8 / `task-p8-20260823-001`，closeout correction `task-p8-closeout-20260823-001`
- **Fix**: 新增 `DevelopmentRiskLevel = L1 | L2 | L3` classifier；文档/非运行资源 L1、普通源码 L2、sandbox/runner/auth/gateway/host-verifier/merge/deploy/tools 等关键边界 L3，未知路径 fail closed 到 L3。`CLAUDE.md` 将对应 ceremony 写成 coding-agent 硬约束。Closeout dogfood 发现 root `CLAUDE.md` 未列入 L1 文档集合而被误判 L3，随后以最小 source/test correction 显式加入并增加回归，不扩展未知路径白名单。
- **Verification evidence**: classifier regressions + 与 existing host classifier 的 L1→none、L2→smoke、L3→full 对齐证明；Phase 8 implementation 走 L3 full/manual Host gate。Closeout 的文档 diff 首先真实暴露 `CLAUDE.md` 漏项，修复后因包含 classifier source/test correction 合理成为 L2，而不是继续承担错误的 L3 ceremony；该 correction 必须通过本任务 fresh verification/CI/merge 后才进入 canonical。
