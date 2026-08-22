# GrandeGPT Backlog

> **Canonical backlog / single source of truth**
>
> 本文件是 GrandeGPT 当前 backlog 的唯一权威索引。`CLAUDE.md` 中的历史“已知遗留”、`docs/research/**` 的事故记录、PR/TaskBrief 和聊天结论都只能作为 evidence/detail，**不得单独维护当前状态**。任何新 backlog、优先级变化、关闭或去重都必须更新本文件。

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

`ACCEPTED` 不作为 backlog status。明确接受且不计划修的架构取舍放在 `CLAUDE.md` 的 **已接受的风险**，避免“待办”和“已决定不做”混在一起。

### 每个条目必须包含

1. `Priority / Status / Category`
2. 一句可复现的问题定义
3. `Evidence / Detail`：代码、测试、research、真实 production 观察或 PR
4. `Next`：最小修复方向；不得借 backlog 偷扩产品边界
5. `Done when`：可验证关闭条件

### 写入与关闭纪律

- **先查重**：新发现先搜索 `GG-BL-*` 与标题关键词；重复复现追加 Evidence。
- **证据与状态分离**：research 文档允许很长，但当前 priority/status 只在这里维护。
- **修复不等于关闭**：代码 merge 后必须满足 `Done when`；涉及 production 的还要有 runtime/host 行为证据。
- **关闭不删除**：改为 `DONE` 并移到 Archive，写明修复 PR/commit/验证证据。
- **部分修复**：保留原 ID，状态改 `MITIGATED`，明确还剩什么。
- **外部平台**：用 `OBS / OBSERVATION`；不要为了适配平台偶发现象降低 Gateway policy、`readOnlyHint` / `destructiveHint` 或绕过安全边界。
- **详细文档不双写状态**：`docs/research/**` 只保存时间线、复现和设计背景；若其中旧状态与本文件冲突，以本文件为准。

## Roadmap after Phase 6

本区只维护 **Phase 顺序、范围与进入/退出条件**；每个 backlog 的实时 `Priority / Status` 仍以对应条目为唯一权威。不要再建立第二份维护当前状态的 roadmap 文档。

### Phase 7 — Reliability Foundation

**Status**：DONE（2026-08-23）

**范围**：`GG-BL-007`、`GG-BL-017`、`GG-BL-018`、`GG-BL-019`。

目标是在继续压缩流程或改变公开 tool contract 前，先补齐控制状态恢复、跨进程写互斥、独立 CI 与 durable production activation evidence。

**进入条件**：Phase 6 已关闭，Automated Host Verifier 已在 production controlled auto mode 运行；不重新设计 verifier execution plane。

**退出条件**：

- SQLite schema upgrade 有顺序 migration、迁移前 backup、失败回滚与真实 restore evidence；
- Gateway/CLI 对同一 repo 的跨进程写操作可以 fail-closed 互斥，不同 repo 仍可并行；
- GrandeGPT 自身 PR 有最小独立 CI，`unit-selfhost`、`typecheck` 与 tool-contract checks 不再长期依赖 `CI=none`；
- production activation 有 durable evidence，能绑定 target/runtime build、toolset identity、restart 与 read probe，不靠聊天人工推断。

**Closeout evidence**：Phase 7 implementation PR #22 已 merge；exact PR head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa` 的 local `unit-selfhost` 为 109 files / 859 tests PASS、`typecheck` PASS、GitHub Actions CI PASS、manual-only Host outer-test 10 files / 171 tests PASS。canonical merge SHA 为 `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`。production activation receipt 已持久化并由后续 `grande_task_status` 读回：`targetBuild = runtimeBuild = git:aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`、`toolsetEpoch=2`、`toolsCount=25`、`toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`、LaunchAgent running、endpoint ready、trusted read probe HTTP 200。Phase 7 未改变公开 25-tool contract。

### Phase 8 — Flow Simplification

**范围**：`GG-BL-020`、`GG-BL-021`、`GG-BL-022`、`GG-BL-023`。

目标是在 **不改变当前公开 `tools/list`** 的前提下减少正常开发轮次和无意义 Human Gate：按真实交付目标投影流程，短 job bounded wait，PR/verifier 自动续跑，并按 L1/L2/L3 风险分级开发与 review。

**进入条件**：Phase 7 的可靠性基础已具备，不需要靠流程简化掩盖底层恢复、锁、CI 或 activation 缺口。**该进入条件已于 2026-08-23 满足。**

**退出条件**：

- `local / pr / deploy` 只执行各自必要阶段，status 保持一个 blocker + 一个 nextAction；
- 普通短测试通常一次 `grande_run` 即可获得终态，长任务和恢复才需要 `grande_run_result`；
- 正常 PR flow 不再要求无意义的 `pr_status → merge → verifier → Human → merge` 往返，同一授权任务可自动完成 verifier 后第二次 merge gate；
- L1/L2/L3 正式落地，普通 bug 不再承担 L3 级 spec/plan/reviewer/host ceremony；
- 整个 Phase 保持当前公开 tool contract 冻结，不 bump toolset epoch。

### Phase 9 — Tool Surface Convergence

**范围**：`GG-BL-024`。

目标是把已经在 Phase 8 内部验证成熟的流程语义，在 **一次正式 Tool Epoch** 中收敛公开 MCP surface，而不是零散增删工具。

**进入条件**：

1. Phase 7、Phase 8 完成；
2. `GG-BL-010` 至少达到 release-ready 稳定门槛：当前 Web、fresh Web、iOS fresh conversation 的真实调用可用，server tool identity 与 client/session binding snapshot 可区分，已有可靠 App refresh/new-session release procedure，且最近没有新的 unexplained `tool disabled` recurrence；
3. 在满足以上条件前，production **25-tool contract 冻结**，除阻断性安全/可靠性修复外不主动改变工具快照。

**一次性变更目标**：

- `grande_repo_add_propose` + `grande_repo_add_apply` → 单一 `grande_repo_register`，但继续保留 proposalDigest + Human Gate 两阶段语义；
- `grande_capability_inspect` → `grande_capability_list` filter；
- `grande_deploy_verify` → 可重入 `grande_deploy`；
- 正常完成路径将 `grande_task_close` 移出公开 MCP，异常/放弃任务继续走 CLI/Console；
- 不长期同时暴露新旧 alias，不为了整数目标合并风险不同的核心工具。

**退出条件**：新 tool count/epoch/digest 稳定；Dev App 与 Production App 完成 refresh；Web/iOS 新聊天完成真实任务；失败时可直接回滚上一 Gateway build/tool epoch。

### Phase 10 — Internal Convergence

**范围**：`GG-BL-025`。

目标是只根据最新代码的真实重复与耦合证据，收敛内部 process supervision、receipt eligibility、tool assembly 与 deployment/capability 调用路径。

**进入条件**：Phase 9 的新公开 contract 已稳定，或某个独立内部缺陷有足够证据证明必须提前处理。

**退出条件**：只关闭仍真实存在的重复实现；没有为了“架构更漂亮”新增 workflow engine、通用 middleware framework、第二套状态系统、第二个 Gateway 或新的 provider graph。若最新代码已消除某个子问题，直接从 scope 删除。

### Maintenance lane

- `GG-BL-006`、`GG-BL-008`、`GG-BL-009` 保持独立 maintenance lane，不为凑 Phase 范围强行并入 Phase 7–10。
- `GG-BL-010` 继续保持 P0 / MITIGATED，并作为 Phase 9 的 release gate；Phase 7/8 不等待其永久关闭，也不得用改变 tool contract 的方式“试试看能不能修”。
- `GG-BL-011`、`GG-BL-012` 继续保持 observation，不因 roadmap 自动升格工程项。

## Active backlog

### GG-BL-006 — `selfcheck` 对交互 shell 的 `GRANDE_ISSUER` 依赖易误判

- **Priority**: P2
- **Status**: OPEN
- **Category**: operations UX
- **Problem**: LaunchAgent/Gateway 已正常配置 production issuer 时，普通 shell 直接运行 `grande selfcheck` 仍会因 shell 未设置 `GRANDE_ISSUER` 而失败，容易被理解成 Gateway outage。
- **Evidence / Detail**: [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md)。
- **Next**: 不降低 issuer/audience 校验；优先改善诊断文本和 `gateway status` 的可信 issuer 展示；只有能证明可信来源时才考虑显式复用 LaunchAgent/config issuer。
- **Done when**: shell 缺 issuer 时输出能清楚区分“CLI 环境缺失”和“Gateway 不健康”，并保持 fail-closed。

### GG-BL-008 — GitHub fine-grained PAT least-privilege 与生命周期

- **Priority**: P2
- **Status**: OPEN
- **Category**: security / operations
- **Problem**: 历史 PAT 配置包含当前切片用不到的部分写权限，并记录了到期时间；权限与有效期需要按当前真实 repo/功能重新核对，不能长期依赖旧截图结论。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #10。历史记录还指出 `GET /user/repos` 不能证明 fine-grained repository grant，因为公开 repo 会混入结果。
- **Next**: 用当前 GitHub 功能矩阵重新做 least-privilege review；在 credential health/doctor 中提供过期或失效的可操作诊断，但不要通过不可靠 API 推断授权范围。
- **Done when**: production PAT 权限与 GrandeGPT 当前所需操作一一对应，过期/失效有明确预警或 runbook，且真实 push/PR/CI/merge 验证通过。

### GG-BL-009 — 历史 S0 文档仍含过期 `repo_edit` 能力描述

- **Priority**: P3
- **Status**: OPEN
- **Category**: docs
- **Problem**: 部分历史 S0 文档仍写 `repo_edit` 不支持 delete，与 S1+ 当前能力不同。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #8。
- **Next**: 仅在容易被误当当前规格的入口加 historical/superseded 标记；不大规模重写有价值的历史记录。
- **Done when**: 当前权威入口不会把读者导向旧能力结论，历史文件保留但明确 superseded。

### GG-BL-010 — 当前会话的 GrandeGPT direct tool execution channel 会被禁用

- **Priority**: P0
- **Status**: MITIGATED
- **Category**: reliability / ChatGPT App session binding
- **Problem**: GrandeGPT App/插件仍显示 installed/enabled、server schema/tool discovery 仍正常时，某个已经运行中的 ChatGPT 会话可能在首次或后续真实 `grande_*` 调用时直接返回 `The GrandeGPT tool has been disabled. Do not send any more messages to GrandeGPT.`；随后该会话无法继续使用 GrandeGPT，只能新建会话或重新绑定。该故障会直接中断长任务。
- **Evidence / Detail**: 早期样本见 [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md) 与 [`docs/chatgpt-connector-compatibility-runbook.md`](chatgpt-connector-compatibility-runbook.md)。现有样本包括 89 次与 256 次 Gateway tool calls 后出现 pre-Gateway disable，以及 `installed=true / status=ENABLED`、schema discovery 可见 25 tools 时首次真实调用即 disabled 的独立样本；这些证据不支持把 256 当作确认配额，也不能证明单一 server-side 根因。另有会话观察到 ChatGPT App tool snapshot 为 23 tools，而同一 production Gateway 报告 `toolsCount=25 / toolsetEpoch=2`，说明 session/app binding 与 server toolset identity 可以分叉。
- **Release A evidence (2026-08-21)**: candidate 已加入真实 `buildTools` handler/fixture 行为回归，覆盖 `repo_read`、`repo_search`、`run_result` 与 error envelopes；canonical `toMcpTextResult` 完整编码后逐个执行 32 KiB 上限，并要求同一序列比 legacy duplicated wire encoding 至少小 30%。记录包括 targeted 10 files / 205 tests PASS、`pnpm typecheck` PASS、完整 77 files / 850 tests PASS；exact candidate host boundary tests 绑定 code commit `7b98f7dce2f0b10723b29be64ca28e1438f1a779`，5 files / 160 tests PASS。
- **2026-08-22 closeout regression**: 当前会话成功重新绑定 GrandeGPT，server identity 为 `toolsetEpoch=2 / toolsCount=25`，并连续完成 status、read/search/diff、edit、run/result、commit、push、PR 等多轮真实调用，未发生 disabled。
- **2026-08-22 post-activation recurrence**: Automated Host Verifier 已 activation 后，在一个已有 GrandeGPT conversation 中尝试 direct `grande_task_status`，ChatGPT 再次返回 `The GrandeGPT tool has been disabled.`。这次复现进一步证明 verification execution plane 与 ChatGPT conversation/App binding plane 是独立问题：Host Verifier 自动执行能力正常投产并不能消除或证明修复 client/session binding drift。
- **Mitigation**: 保留 server-side toolset identity、32 KiB result budget、单次终态 result、有界轮询/分页、connector compatibility runbook 与长会话真实工具调用回归；不降低 annotations、不绕过 Gateway、不增加第二执行通道。
- **Remaining**: ChatGPT Web/iOS/fresh-Web 的完整两任务 release gate 与七天观察期仍属于根因关闭前的后续验证；平台侧 binding 故障并未宣称彻底消除。Automated Host Verifier 的 execution-plane hardening 不作为本项关闭条件的替代品。
- **Related / Roadmap gate**: 本项保持独立 P0/MITIGATED，不阻塞 Phase 7/8；但 Phase 9 改变公开 tool snapshot 前必须达到 roadmap 定义的 release-ready 稳定门槛。不得通过频繁改变 tools/list、降低 annotations、绕过 Gateway 或增加第二执行通道来试探性规避 binding drift。
- **Done when**: 完成跨客户端两任务 release gate 和稳定观察，或获得可控根因并证明长期稳定后再转 DONE；当前按 Human Owner closeout 决策保持 MITIGATED。

### GG-BL-020 — Task 缺少 `deliveryTarget = local | pr | deploy`

- **Priority**: P2
- **Status**: OPEN
- **Category**: developer flow / task projection
- **Problem**: 当前开发闭环仍偏向固定 Golden Path，纯本地修改、只需 PR 的任务与需要 production deploy 的任务会被同一组阶段概念包围，造成无关 blocker、状态噪声和额外调用。
- **Evidence / Detail**: 2026-08-22 owner-approved capability/flow simplification proposal 明确要求按实际交付目标选择 `local / pr / deploy`，且不把缺少 deploy spec 误报为 local/pr readiness failure。
- **Next**: 在稳定 TaskBrief/TaskProgress 语义中加入 `deliveryTarget`，不扩大小型生命周期状态机。local 只要求本地 acceptance/tests/attestation；pr 再要求 push/PR/CI/exact-SHA merge/refresh/cleanup；deploy 在 pr 之上要求可信 deploy spec + deploy/verify。target 扩大外部副作用必须重新 Human confirmation。
- **Done when**: ① local 不要求 PR/CI/deploy；② pr 不要求 deploy；③ deploy 必须存在可信 deploy spec；④ doctor/task_status 只评估当前 target 所需阶段；⑤ target 扩大需要 Human confirmation，缩小不能伪造已发生外部结果；⑥ status 始终只返回一个 blocker 与一个 nextAction。

### GG-BL-021 — 短 job 普遍需要 `grande_run → grande_run_result` 两次调用

- **Priority**: P2
- **Status**: OPEN
- **Category**: agent UX / runner efficiency
- **Problem**: `grande_run` 当前立即返回 jobId，即使 profile 很快完成，agent 仍需要第二次 `grande_run_result`；短测试因此承担与长任务相同的 MCP 往返成本。
- **Evidence / Detail**: 2026-08-22 owner-approved flow simplification proposal 将 bounded wait 列为不改变 tool contract 即可获得的高收益优化；现有 async job/recovery 语义仍有价值，不能为了少一次调用删除 `run_result`。
- **Next**: 为 `grande_run` 增加固定、较短的 server-side bounded wait；预算内终态直接返回 result summary + attestation context，超预算返回 jobId。保持现有 artifact、shutdown、timeout/RSS 与 recovery 语义，不把 MCP 请求拖到不可控 timeout。
- **Done when**: ① bounded wait 有固定上限并有 timeout regression；② 短 job 在预算内一次调用返回 terminal result；③ 超预算稳定返回 jobId；④ 长任务/recovery 继续使用 `grande_run_result`；⑤ 不增加高频轮询、不破坏 artifact/attestation/job terminal semantics。

### GG-BL-022 — 正常 PR / verifier 流程存在不必要状态往返

- **Priority**: P2
- **Status**: OPEN
- **Category**: developer flow / PR lifecycle
- **Problem**: 正常 PR 流程仍可能要求 agent 先显式读 `pr_status`，再调用 merge；auto verifier 启动并 PASS 后又需要再次推进 merge。对同一已授权任务，这些安全检查应由 merge gate 观察和返回 blocker，而不是变成人工确认节点。
- **Evidence / Detail**: Automated Host Verifier 已证明 verifier execution plane 可以在 merge gate 下异步完成且绝不自行 merge；PR #20 的真实流程是第一次 merge 启 verifier、PASS 后第二次 merge 成功，说明剩余优化是 agent continuation，而不是放宽 exact-SHA gate。
- **Next**: 正常路径允许直接 `grande_pr_merge`，内部读取 exact PR head、CI、attestation、host receipt；只有 blocker 需要展开 CI/PR 诊断时才使用 `grande_pr_status`。verifier PASS 后 agent 在同一次 task authorization 下自动再次调用 merge；每次 merge 都重新读取全部门禁。不要增加 workflow engine，也不要让 verifier 子进程自行 merge。
- **Done when**: ① 正常 green PR 可不经预先 `pr_status` 进入 merge gate；② blocker 返回结构化 nextAction；③ verifier PASS 后 agent 自动执行第二次 merge，无重复 Human confirmation；④第二次 merge 重新检查 PR head/CI/attestation/receipt；⑤ verifier/runner 永不拥有 merge 权限。

### GG-BL-023 — 开发风险等级未正式落地，普通修改流程过重

- **Priority**: P2
- **Status**: OPEN
- **Category**: development process / review policy
- **Problem**: 普通文档、常规 bug 与 sandbox/auth/verifier 等核心高风险修改容易沿用近似完整的 spec/plan/reviewer/host 流程，重复维护文档与 review gate，增加 token、调用和 Human 等待而不增加对应安全收益。
- **Evidence / Detail**: 2026-08-22 两份 owner-reviewed optimization design 均提出 L1/L2/L3 分级，并明确 Pact/independent reviewer 不应成为普通轻量任务的永久 ceremony。
- **Next**: 以现有 host-verification classifier 和产品安全边界为基础定义 L1/L2/L3：L1 文档/非运行资源走基础检查；L2 常规业务源码/bug 使用简短 TaskBrief、行为测试和普通 review，按 classifier none/smoke；L3 才要求 design spec + implementation plan + independent reviewer + full verifier，无法分类默认 L3。Pact 仅用于 GrandeGPT L3、多 agent 或 Human 明确要求。
- **Done when**: ① classifier/文档明确 L1/L2/L3；② L1 不要求独立 spec/plan/reviewer/host verifier；③ L2 只要求简短 TaskBrief + tests + ordinary review + none/smoke；④ L3 强制完整设计、独立 reviewer、full gates；⑤无法分类不会被 agent 自行降级；⑥真实普通 bug dogfood 证明中间文档/Human gate 减少且安全 gate 无退化。

### GG-BL-024 — 下一次 Tool Epoch 收敛公开 MCP surface

- **Priority**: P2
- **Status**: OPEN
- **Category**: MCP contract / tool surface
- **Problem**: 当前 25-tool contract 中仍有 onboarding 两工具、capability inspect、deploy verify、task close 等可在保持风险语义的前提下合并或内部化的公开面；但零散修改 tools/list 会放大 ChatGPT binding/snapshot 排障变量。
- **Evidence / Detail**: 2026-08-22 owner-approved capability/flow simplification proposal 目标约从 25 tools 收敛到 21，明确要求一个正式 tool epoch 一次切换、不长期暴露新旧 alias。`GG-BL-010` 已证明 session/app binding 与 server tool identity 可分叉，因此本项必须在稳定 release gate 后执行。
- **Next**: 在 Phase 7/8 完成且 GG-BL-010 达到 roadmap release-ready 门槛后，一次 release 完成：① `repo_add_propose/apply → grande_repo_register`，仍使用 proposalDigest + Human Gate；② capability inspect 并入 list filter；③ deploy verify 并入可重入 deploy；④正常完成路径移除公开 task_close；⑤ bump toolset epoch 并执行 Dev/Production App refresh。不要为整数目标合并风险不同的工具，也不要长期保留 alias。
- **Done when**: ①旧 25-tool identity 与新 identity 明确不同且新 count/epoch/digest 稳定；②删除工具不再出现在 tools/list；③ `repo_register` 不接受 path/force，scan/proposal 零写入，register 保持 Human Gate/stale protection；④ deploy 重入不重复外部副作用；⑤ task 自动 cleanup 不暴露通用 delete；⑥ Dev/Production App refresh 后 Web/iOS 新聊天完成真实任务；⑦失败可直接 rollback 上一 Gateway build/tool epoch。

### GG-BL-025 — 内部执行、receipt 与 tool assembly 存在潜在重复和隐式耦合

- **Priority**: P3
- **Status**: OPEN
- **Category**: architecture / maintainability
- **Problem**: 2026-08-22 架构评审指出 runner/host verifier process supervision、job/receipt JSON eligibility、公开 tool handler 互调以及 handler wrapping/assembly 可能存在重复实现或隐式顺序耦合；这些问题有维护成本，但设计文档基线早于部分 Phase 6/P1 改动，不能把旧快照直接当成当前代码事实。
- **Evidence / Detail**: owner-reviewed lightweight architecture design 提出窄 `ProcessSupervisor`、typed receipt codec/eligibility、deployment 调领域服务、静态 ToolSpec/fixed middleware order 等方向；本项明确 evidence-driven，实施前先逐项确认最新 canonical 仍有重复/耦合。
- **Next**: 先做 code evidence review。只对仍存在且至少有两个真实使用者的重复 primitive 做收敛：process supervision 若重复则抽窄 supervisor；receipt/job JSON 若漂移则建立单一 codec/eligibility；deployment/capability 内部调用领域函数而非包装后的公开 handler；tool assembly 若仍依赖对象原地替换则固定最小 middleware 顺序。禁止借此建设 workflow engine、通用 interceptor framework、第二状态系统或 capability marketplace。
- **Done when**: ①逐项 evidence review 完成并删除已经不存在的 scope；②若 runner/verifier 确有重复，仅保留一套窄 process lifecycle primitive；③ receipt/job eligibility 有单一 fail-closed parser/validator；④ deployment 不通过公开 MCP handler 触发内部领域动作；⑤写工具 wrapper 顺序有集中测试且不依赖共享可变 ToolDef；⑥没有新增与轻量定位冲突的通用框架。

## Observations

### GG-BL-011 — `grande_repo_search` 的 truncated 信号曾被忽略

- **Priority**: OBS
- **Status**: OBSERVATION
- **Category**: agent UX
- **Problem**: 曾有一次模型收到 `truncated + nextCursor` 后没有继续分页。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #3；目前只有单次样本。
- **Next**: 收集重复样本；若成为稳定失败模式，再考虑 guidance/UI 改善，不提前建设搜索编排层。
- **Done when**: 重复证据足以升格工程项，或长期无复现后由 Human Owner 明确归档。

### GG-BL-012 — `/.well-known/openid-configuration` 返回 404

- **Priority**: OBS
- **Status**: OBSERVATION
- **Category**: OAuth compatibility
- **Problem**: ChatGPT/其他客户端可能探测 OIDC discovery path；GrandeGPT 当前提供 OAuth authorization-server metadata，现有 OAuth 流程正常，但该路径仍为 404。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #5。
- **Next**: 仅在真实客户端兼容性要求出现时评估别名/兼容端点；不因为探测请求本身扩协议面。
- **Done when**: 出现真实需要后实现并验证兼容，或确认长期无需支持并由 Human Owner 归档。

## Not backlog

以下内容**不要**重复创建 backlog：

- `CLAUDE.md` 的 **已接受的风险**：这是明确取舍，不是待办；除非 Human Owner 重新打开决策。
- `package.json` 的 `postinstall/prepare` 宿主执行风险：当前是已知且有意保留的安全/可用性取舍；若威胁模型变化再建立新 ID。
- 已修复并有验证证据的历史事故（token epoch、loopback bind、schema arg validation、outer-test 等）：保留历史记录，不重新进入 Active。
- research 文档中的旧 priority/status：只作为当时快照，当前状态以本文件为准。

## Archive

### GG-BL-001 — PR 已 merge，但 local canonical `main` 仍旧

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: S16 引入受控 canonical refresh：固定 registered repo、origin/current canonical branch、clean precondition、fetch+compare+fast-forward-only；dirty/diverged fail closed；`task_open` 基于 refresh 后 canonical。
- **Verification evidence**: canonical refresh / task-open 行为与 fail-closed 测试纳入 Phase 5.5 `unit-selfhost`；host verification 由 Phase 5.5 outer-test/receipt gate 覆盖。

### GG-BL-002 — `grande gateway restart` 非 failure-safe

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: S17 对 loaded restart 使用 `kickstart -k`，避免先 bootout；unloaded bootstrap 对 error 5 有限重试；restart success 前等待 endpoint readiness，并暴露 runtime identity。
- **Verification evidence**: 2026-08-20 fresh `unit-selfhost` 67 files / 628 tests PASS、`typecheck` PASS；S17 production acceptance 连续 10/10 restart 全绿，LaunchAgent 保持 loaded/running，readiness 与 MCP probe 恢复，selfcheck 正常。

### GG-BL-003 — `grande_sync_base` 方向与 `up-to-date` 文案误导

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: tool contract 改为明确 canonical → task，绝不修改 canonical；relation 明确为 `equal/task_ahead/canonical_ahead/diverged`，不再用含混的 `up-to-date` 表示 HEAD 相等。
- **Verification evidence**: task-ahead / canonical-ahead / diverged 行为回归纳入 Phase 5.5 tests，production tool contract 已反映新语义。

### GG-BL-004 — Merge 与 production runtime activation 仍是两步

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: S17 将 release activation evidence 显式化：restart/readiness 后通过 `gatewayBuild/toolsetEpoch/toolsCount/toolsDigest` 识别实际 runtime；selfcheck/doctor/status 可读取 toolset identity，不再把 merged 等同于 activated。
- **Verification evidence**: S17 10/10 production restart acceptance 与真实 ChatGPT read probes；2026-08-22 closeout session 可见 `toolsetEpoch=2 / toolsCount=25`。

### GG-BL-005 — GC 看不到 `CLOSED` 但 worktree 残留

- **DONE date**: 2026-08-22
- **Task**: `task-p1-20260822-001` / `grande/p1-continuity-gc-2001`
- **Fix**: 在既有 GC 增加第三类 `closedResidualWorktrees` reconciliation：只接受仍为 `CLOSED`、worktree 存在且 stored path 精确等于受管 expected task path 的记录；`grande gc` dry-run/`--apply` 明确展示与处理该类，apply-time 再校验 current state/path 并复用现有 `removeWorktree`。Gateway 启动时仅报告残留，绝不自动删除。
- **Verification evidence**: 真实 Git worktree fixtures 覆盖 discovery、CLI dry-run/apply、目录与 Git worktree registration 一并清理、CLOSED row 保持、二次运行幂等、READY active task 不误伤、stale-plan apply-time recheck、非受管 path fail-closed；candidate fresh `unit-selfhost` 98 files / 827 tests PASS，`typecheck` PASS。canonical 仅在本变更通过 merge gate 后获得 DONE 状态。

### GG-BL-013 — Host outer-test 自动形成 exact-SHA merge gate

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 S18，后续由 Reliability & Automated Host Verifier supersede
- **Fix**: S18 先建立 `OuterTestReceipt` exact-SHA/current-plan merge gate；随后 Reliability & Automated Host Verifier 将原 Human 手工 outer-test 路径升级为 `eligible exact SHA → controlled automatic Host Verifier → trusted V2 result/receipt → merge gate`。自动路径仍保持固定 manifest、受限 host verifier、无通用 `host_exec`/unsandboxed escape hatch；manual CLI 只作为受信 fallback / manual-only Human Gate。
- **Verification evidence**: Phase 5.5 已证明 receipt persistence/expiry 与 merge fail-closed；Reliability 实现随后加入 restricted async verifier、Receipt V2、startup reconciliation 与 bounded infra retry。2026-08-22 Human Owner 已确认 production controlled auto mode 正式 activation；Phase 6 以 post-activation hardening 为起点，不重新打开“如何自动执行 host verification”。

### GG-BL-014 — 长任务可能在只读分析后静默停滞

- **DONE date**: 2026-08-22
- **Task**: `task-p1-20260822-001` / `grande/p1-continuity-gc-2001`
- **Fix**: 在既有 `TaskProgress` 只读 projection 增加 liveness：从 `TaskRow.updatedAt`、job start/end、成功 write audit 的 `updatedAt` 派生 `progressAt`；`READY + blocker=null + no running job + not completed/cleanup + 15 min inactivity` 投影为 `stalled`。不写 heartbeat、不新增生命周期状态、不把 stalled 伪装成 blocker，并保留同一唯一 `nextAction`；CLI `status` 显式显示 `STALLED`。
- **Verification evidence**: 2026-08-21 的真实长任务停滞事件作为原始复现样本；新增 deterministic regression 覆盖 stale READY 检测、长期 running job 不误报、成功 write audit 推进 progress timestamp，且恢复无需重建 task/丢弃 worktree；candidate fresh `unit-selfhost` 98 files / 827 tests PASS，`typecheck` PASS。canonical 仅在本变更通过 merge gate 后获得 DONE 状态。

### GG-BL-015 — Auto Verifier 缺少最小可信运行可观察性

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 6 S19 / `task-p6-20260822-001`
- **Fix**: 在既有 `grande_task_status` response 上增加由 trusted host-verifier job/runtime identity 派生的最小 operational snapshot，覆盖 mode/enabled/state、last attempt/result/SHA/duration、last success/failure、failure class/reason、active job、固定 queueDepth=0、verifier build/version，以及 task current-SHA correlation；未新增 MCP tool、metrics store、日志抓取或 queue。
- **Verification evidence**: 行为测试证明 trusted PASS、running job、candidate RED 与 old-SHA historical result 投影；Phase 6 code gate 为 97 files / 817 tests PASS、`typecheck` PASS。最终候选的 exact-SHA production auto verifier receipt/merge audit 作为运行时关闭证据，且 PASS 后不再修改候选 SHA。

### GG-BL-016 — Auto Verifier 失败分类与升级语义不完整

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 6 S20 / `task-p6-20260822-001`
- **Fix**: 统一 `candidate | infrastructure | integrity` failure taxonomy；trusted runtime 持久化 class/reason；candidate zero retry；同 SHA infrastructure 最多一次 bounded retry、第二次 Human escalation；current-SHA receipt/result/SHA/policy identity mismatch 作为 integrity zero-retry immediate fail-closed；old-SHA verification/retry state 不复用。修复了一个 RED-first 暴露的真实缺口：integrity attempt 原会从 merge gate 漏入 coordinator dispatch，现在显式在 dispatch 前 Human-gate fail closed。
- **Verification evidence**: load-bearing tests 覆盖 candidate no-retry、transient infra retry+recovery、persistent infra escalation、integrity zero-retry/fail-closed、SHA change isolation；Phase 6 code gate 为 97 files / 817 tests PASS、`typecheck` PASS。最终 exact-SHA production auto verifier receipt/merge audit 作为 host-only关闭证据。

### GG-BL-007 — Control-plane backup、SQLite migration 与 restore 路径不完整

- **Priority**: P1
- **Status**: DONE
- **Category**: resilience / state migration / operations
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: 保持 SQLite，新增显式有序 5→6 migration、`BEGIN IMMEDIATE` 事务边界、迁移前 `VACUUM INTO` verified backup、固定 managed backup root 与 retention、integrity/schema verification，以及 dry-run 默认且 `--yes` 才原子替换的 Human restore CLI。普通 backup 明确不包含 `secrets/`；live-handle 检测使用 SQLite WAL exclusive transition 语义而不是仅凭残留 `-wal/-shm` 文件判断。
- **Verification evidence**: 真实 version-5 fixtures 覆盖 Task/audit/OAuth/attestation/receipt 保留、backup failure 零修改、migration failure rollback、managed backup restore、invalid/outside-root/live-handle fail-closed。Phase 7 exact candidate `unit-selfhost` 109 files / 859 tests PASS、`typecheck` PASS；PR #22 与 host/CI gates 均通过后 merge 到 canonical `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`。

### GG-BL-017 — Gateway / CLI 缺少跨进程 repo write lock

- **Priority**: P1
- **Status**: DONE
- **Category**: reliability / Git lifecycle / concurrency
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: 在既有 process-local FIFO mutex 下增加固定 control-root 的 per-repo cross-process lock；使用 exclusive create、`pid/repoId/acquiredAt/nonce` metadata、live PID busy fail-closed、仅 ESRCH 视为 stale、malformed metadata 不自动删除、release 校验 ownership/nonce。Gateway writes 与 `gc --apply` 共用同一锁，不同 repo 仍可并行。
- **Verification evidence**: 两独立 Node 进程覆盖同 repo 冲突、不同 repo 并行、stale recovery、malformed fail-closed、nonce ownership，以及 GC busy 零部分副作用；最终 exact candidate local `unit-selfhost` 109/859 PASS、typecheck PASS，GitHub CI PASS，Host outer-test 10/171 PASS。

### GG-BL-018 — GrandeGPT 自身缺少最小独立 CI gate

- **Priority**: P1
- **Status**: DONE
- **Category**: verification / GitHub CI
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: 新增最小 GitHub Actions CI，固定 `macos-15`、Node 24、pnpm 10.33.0、frozen lockfile，运行 selfhost-safe unit selection、typecheck 与 focused tool-contract checks；Host Verifier 继续独立承担 trusted host-only suite。首轮 Ubuntu runner 暴露 Darwin assumptions 后改为 pinned macOS；第二轮 macOS CI 又暴露 `sbpl.test.ts` 对 `xcrun`/Homebrew Git 布局的错误测试假设，修正为与 runtime `which git`→仅 `/usr/bin/git` shim 时 fallback `xcrun` 的同一选择规则。
- **Verification evidence**: final exact PR head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa` 的 GitHub Actions run `32585178938` PASS；merge gate 读取真实 exact-head CI 而非 `CI=none`。同一候选 local `unit-selfhost` 109 files / 859 tests PASS、`typecheck` PASS，Host outer-test 10 files / 171 tests PASS。

### GG-BL-019 — Production activation 缺少 durable evidence / receipt

- **Priority**: P1
- **Status**: DONE
- **Category**: production activation / evidence
- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: 新增独立 durable activation receipt，将 target/runtime build、toolset epoch/count/digest、activation timestamp、LaunchAgent running、endpoint readiness 与 trusted read probe 绑定；build/tool identity 不一致时 fail closed。receipt 与 merge/deploy evidence 保持分离，只有 restart readiness、running status 与 trusted read probe 全部成功后才持久化。
- **Verification evidence**: PR #22 merge 后 canonical 为 `aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`。production `gateway restart` 成功记录 receipt；后续独立 `grande_task_status` readback 返回 `targetBuild = runtimeBuild = git:aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`、`toolsetEpoch=2`、`toolsCount=25`、`toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`、LaunchAgent running、endpointReady=true、trusted read probe HTTP 200。由此满足跨会话 durable activation closeout，且公开 tool contract 未变化。
