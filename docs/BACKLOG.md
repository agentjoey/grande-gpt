# GrandeGPT Backlog

> **Canonical backlog / single source of truth**
>
> 本文件是 GrandeGPT 当前 backlog 的唯一权威索引。`CLAUDE.md` 中的历史“已知遗留”、`docs/research/**` 的事故记录、PR/TaskBrief 和聊天结论都只能作为 evidence/detail，**不得单独维护当前状态**。任何新 backlog、优先级变化、关闭或去重都必须更新本文件。

最后整理：2026-08-20

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

## Active backlog

### GG-BL-001 — PR 已 merge，但 local canonical `main` 仍旧

- **Priority**: P0
- **Status**: OPEN
- **Category**: reliability / Git lifecycle
- **Problem**: GitHub PR 已成功 merge 到 remote `main`，本机 canonical checkout 仍可能停在旧 HEAD；后续 `grande_task_open` 会从 stale local canonical 建 task。
- **Evidence / Detail**: [`docs/research/2026-08-19-canonical-main-staleness-backlog.md`](research/2026-08-19-canonical-main-staleness-backlog.md)。已在 Phase 4 closeout、Phase 5 PR #7 后重复复现；PR #10 后本地 canonical 再次未立即包含刚合并内容。
- **Related**: GG-BL-003。
- **Next**: 设计窄语义 safe canonical refresh：固定 registered repo / `origin` / default branch，仅 clean + fast-forward-only；禁止 arbitrary ref、force、`reset --hard`。即使暂不自动 refresh，也要让 stale remote/local 成为显式状态，不能静默开新 Task。
- **Done when**: 连续 Task A→B 的真实 GitHub/host 探针证明 A merge 后 B 不会从 merge 前 local HEAD 启动；dirty/diverged canonical 明确 fail closed 且无副作用。

### GG-BL-002 — `grande gateway restart` 非 failure-safe

- **Priority**: P0
- **Status**: MITIGATED
- **Category**: production operations
- **Problem**: `restart` 可先成功 `bootout` 旧 LaunchAgent，再因 `bootstrap` error 5 失败，把 production 留在线下；单独 `gateway start` 才恢复。
- **Evidence / Detail**: [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md)。plist 当时存在且 `plutil -lint` 为 OK，job 已 unloaded。S17 已把 loaded restart 改为 `kickstart -k`（不再先 `bootout`），unloaded bootstrap 对 error 5 做最多 3 次有限重试，并在 restart 返回成功前等待 Gateway endpoint readiness；2026-08-20 fresh `unit-selfhost` 为 67 files / 628 tests PASS，`typecheck` PASS。当前 production `gatewayBuild=git:5fc26be272e3ece97b4d2e97690c82b454f615a2` 已包含 readiness gate。
- **Next**: 只剩 host acceptance：连续 10 次受控 production restart，每轮记录 LaunchAgent loaded/running、Gateway endpoint/health 恢复、runtime identity，并在同一 ChatGPT 会话继续做真实 GrandeGPT read probe；任何一轮失败都保持本项未关闭。
- **Done when**: 行为测试/宿主探针覆盖 bootout→bootstrap race；restart 成功必须验证新 Gateway running，失败不得被误报成功并必须给可执行恢复路径；连续 10 次 production restart/activation 真实探针全绿。

### GG-BL-003 — `grande_sync_base` 方向与 `up-to-date` 文案误导

- **Priority**: P1
- **Status**: OPEN
- **Category**: reliability / tool semantics
- **Problem**: 实现实际是 **local canonical → task worktree**，从不写 canonical；公开描述“把任务分支同步到本机 canonical HEAD”容易被理解为 task→canonical。`up-to-date` 实际只表示 `canonical HEAD` 是 task HEAD 的祖先，并不表示两个 HEAD 相等，但 hint 说“已与本机 canonical HEAD 保持一致”。
- **Evidence / Detail**: `src/syncBase.ts` 的 `isAncestor(canonical, before)` 分支；`src/localLoopTools.ts` 的 tool description/hint；真实调用曾出现 task HEAD `8446ff8…`、canonical HEAD `c5c4c34…` 仍返回 `action=up-to-date`。PR #10 已记录该语义缺陷。
- **Related**: GG-BL-001；误导文案会掩盖 stale canonical，因为模型可能把 `up-to-date` 理解成 canonical 已追上。
- **Next**: description 明确“把当前 local canonical HEAD 合入/快进到 task，绝不修改 canonical”；hint 改为“task 已包含当前 canonical HEAD”；保留 `before/after/canonicalHead`；新增 task-ahead + canonical-ancestor 回归测试。
- **Done when**: tool contract/文案与实现方向一致，task-ahead 场景不再声称 HEAD 一致，并有行为测试钉住。

### GG-BL-004 — Merge 与 production runtime activation 仍是两步

- **Priority**: P1
- **Status**: MITIGATED
- **Category**: release / production operations
- **Problem**: canonical/remote 代码 merge 后，长期运行的 Gateway 不会自动加载新实现；若 tool contract 未变，仅看 `toolsCount` 可能误以为 production 已升级。
- **Evidence / Detail**: [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md)。Phase 5 merge 后 production 仍运行旧进程，restart/start 后 S10 `progress` 才出现。
- **Mitigation already shipped**: production 现已暴露 `gatewayBuild / toolsetEpoch / toolsCount / toolsDigest`，并有 [`docs/chatgpt-connector-compatibility-runbook.md`](chatgpt-connector-compatibility-runbook.md)，所以“运行的是哪个 build”已经可观测。
- **Next**: 收敛剩余问题到 release activation：GrandeGPT 自身 release/closeout 必须显式 `restart/start → gatewayBuild/selfcheck → behavior probe`；是否自动 restart 需和 GG-BL-002 一起设计，避免自动化一个不 failure-safe 的动作。
- **Done when**: 每次 GrandeGPT production release 都能从 release evidence 证明运行 build 等于目标 build，且不会把“merged”误记为“activated”。

### GG-BL-005 — GC 看不到 `CLOSED` 但 worktree 残留

- **Priority**: P1
- **Status**: OPEN
- **Category**: local operations / cleanup
- **Problem**: GC 方向 A 只认“完全没有 task 行”，方向 B 只看 active task；若 task 已 `CLOSED` 但 `removeWorktree`/branch cleanup 中途失败，DB 有 CLOSED 行且目录仍在，两边都可能漏掉。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 已知遗留 #2；`src/worktreeGc.ts` 为当前实现入口。
- **Next**: 在现有 GC 增加第三种 reconciliation 形态，不新增生命周期系统。
- **Done when**: fixture/行为测试证明 CLOSED+residual worktree 能被 `gc` 发现，`--apply` 可安全清理且幂等，不误伤 active task。

### GG-BL-006 — `selfcheck` 对交互 shell 的 `GRANDE_ISSUER` 依赖易误判

- **Priority**: P2
- **Status**: OPEN
- **Category**: operations UX
- **Problem**: LaunchAgent/Gateway 已正常配置 production issuer 时，普通 shell 直接运行 `grande selfcheck` 仍会因 shell 未设置 `GRANDE_ISSUER` 而失败，容易被理解成 Gateway outage。
- **Evidence / Detail**: [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md)。
- **Next**: 不降低 issuer/audience 校验；优先改善诊断文本和 `gateway status` 的可信 issuer 展示；只有能证明可信来源时才考虑显式复用 LaunchAgent/config issuer。
- **Done when**: shell 缺 issuer 时输出能清楚区分“CLI 环境缺失”和“Gateway 不健康”，并保持 fail-closed。

### GG-BL-007 — 控制平面缺少备份方案

- **Priority**: P2
- **Status**: OPEN
- **Category**: resilience / operations
- **Problem**: `~/.grande-control/` 不在 Git 中，包含不可从 repo 重建的状态/审计数据；机器故障会丢失。历史记录里“grande-gpt 代码无 remote”已过时，不再属于本项。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #9；Human Owner 已指定未来目标为本地 NAS。
- **Next**: 定义本地 NAS 备份/恢复 runbook 或最小命令；`secrets/` 必须明确排除或采用独立安全处理，不能进入普通备份仓库。
- **Done when**: 有一次真实 backup + restore 验证，明确哪些 control-plane 数据可恢复、哪些 secrets 不进入普通备份。

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
- **Problem**: GrandeGPT App/插件仍显示 installed/enabled、server schema/tool discovery 仍正常时，某个已经运行中的 ChatGPT 会话可能在首次或后续真实 `grande_*` 调用时直接返回 `The GrandeGPT tool has been disabled. Do not send any more messages to GrandeGPT.`；随后该会话无法继续使用 GrandeGPT，只能新建会话或重新绑定。该故障会直接中断长任务，因此已不再是低优先级 platform observation。
- **Evidence / Detail**: 早期样本见 [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md) 与 [`docs/chatgpt-connector-compatibility-runbook.md`](chatgpt-connector-compatibility-runbook.md)。S17 再次重复出现：受影响会话中 GrandeGPT `installed=true / status=ENABLED`，schema discovery 可发现 25 tools，但第一次真实执行 `grande_task_status(task-p55-20260819-001)` 即收到 tool disabled；本轮在故障前**没有执行任何 Gateway restart/bootout**，因此不能归因于 GG-BL-002/S17-3-2 的 launchd restart race。当前另一会话还观察到 ChatGPT 暴露的 App tool snapshot 为 23 tools，而同一个 production Gateway 通过 `grande_task_status` 报告 `toolsCount=25 / toolsetEpoch=2`，说明 session/app binding 与 server toolset identity 可以发生分叉；这条分叉是否是 disable 的直接触发条件仍需验证，不能先当根因。2026-08-20 Human Owner 报告该 binding 问题已在另一 Work 会话修复；本会话随后做独立复验：production identity 持续为 `gatewayBuild=git:5fc26be272e3ece97b4d2e97690c82b454f615a2 / toolsetEpoch=2 / toolsCount=25 / toolsDigest=sha256:ec07c95e5e537958e49e99e3aaae708348c2f610b6c3c21e0ec5d1f8dcdea804`，并在同一会话连续完成 status、repo read/search/diff、edit、run、run_result、capability discovery 等多轮真实工具调用，未再发生 disabled。
- **Related**: GG-BL-004（runtime/toolset identity 可观测）与 GG-BL-002（restart reliability）都能提供诊断上下文，但此前证据明确表明本项可以在**没有 restart**时独立发生。
- **Next**: 当前长任务 binding 回归已通过；只剩和 GG-BL-002 共用的 host acceptance：连续 10 次受控 Gateway restart/activation，并在每次恢复后由同一 ChatGPT 会话继续真实 GrandeGPT probe。不要为了恢复调用降低 `readOnlyHint/destructiveHint/openWorldHint`、绕过 Gateway 或增加第二套执行通道。
- **Done when**: 修复/规避后用长任务连续验证证明同一会话在多轮 `run → result → edit → verify` 以及至少 10 次受控 Gateway restart/activation 场景中不会被无故 disable。若最终确认完全属于 ChatGPT 平台且 server-side 无可控修复，则必须有经过重复验证的 release/session operational mitigation，并把状态从 OPEN 改为 BLOCKED，而不是静默关闭。

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

当前标准化时不把大量历史已修事项重新编号。今后从 Active/Observations 关闭的 `GG-BL-*` 条目统一移动到这里，并保留：`ID / DONE date / fix PR or commit / verification evidence`。
