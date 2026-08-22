# GrandeGPT Backlog

> **Canonical backlog / single source of truth**
>
> 本文件是 GrandeGPT 当前 backlog 的唯一权威索引。`CLAUDE.md` 中的历史“已知遗留”、`docs/research/**` 的事故记录、PR/TaskBrief 和聊天结论都只能作为 evidence/detail，**不得单独维护当前状态**。任何新 backlog、优先级变化、关闭或去重都必须更新本文件。

最后整理：2026-08-22

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
- **Problem**: GrandeGPT App/插件仍显示 installed/enabled、server schema/tool discovery 仍正常时，某个已经运行中的 ChatGPT 会话可能在首次或后续真实 `grande_*` 调用时直接返回 `The GrandeGPT tool has been disabled. Do not send any more messages to GrandeGPT.`；随后该会话无法继续使用 GrandeGPT，只能新建会话或重新绑定。该故障会直接中断长任务。
- **Evidence / Detail**: 早期样本见 [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md) 与 [`docs/chatgpt-connector-compatibility-runbook.md`](chatgpt-connector-compatibility-runbook.md)。现有样本包括 89 次与 256 次 Gateway tool calls 后出现 pre-Gateway disable，以及 `installed=true / status=ENABLED`、schema discovery 可见 25 tools 时首次真实调用即 disabled 的独立样本；这些证据不支持把 256 当作确认配额，也不能证明单一 server-side 根因。另有会话观察到 ChatGPT App tool snapshot 为 23 tools，而同一 production Gateway 报告 `toolsCount=25 / toolsetEpoch=2`，说明 session/app binding 与 server toolset identity 可以分叉。
- **Release A evidence (2026-08-21)**: candidate 已加入真实 `buildTools` handler/fixture 行为回归，覆盖 `repo_read`、`repo_search`、`run_result` 与 error envelopes；canonical `toMcpTextResult` 完整编码后逐个执行 32 KiB 上限，并要求同一序列比 legacy duplicated wire encoding 至少小 30%。记录包括 targeted 10 files / 205 tests PASS、`pnpm typecheck` PASS、完整 77 files / 850 tests PASS；exact candidate host boundary tests 绑定 code commit `7b98f7dce2f0b10723b29be64ca28e1438f1a779`，5 files / 160 tests PASS。
- **2026-08-22 closeout regression**: 当前会话成功重新绑定 GrandeGPT，server identity 为 `toolsetEpoch=2 / toolsCount=25`，并连续完成 status、read/search/diff、edit、run/result、commit、push、PR 等多轮真实调用，未发生 disabled。
- **Mitigation**: 保留 server-side toolset identity、32 KiB result budget、单次终态 result、有界轮询/分页、connector compatibility runbook 与长会话真实工具调用回归；不降低 annotations、不绕过 Gateway、不增加第二执行通道。
- **Remaining**: ChatGPT Web/iOS/fresh-Web 的完整两任务 release gate 与七天观察期仍属于根因关闭前的后续验证；平台侧 binding 故障并未宣称彻底消除。
- **Done when**: 完成跨客户端两任务 release gate 和稳定观察，或获得可控根因并证明长期稳定后再转 DONE；当前按 Human Owner closeout 决策保持 MITIGATED。

### GG-BL-014 — 长任务可能在只读分析后静默停滞

- **Priority**: P1
- **Status**: OPEN
- **Category**: agent execution / continuity
- **Problem**: 长时间开发任务在 task 仍为 `READY`、`blocker=null`、没有运行中 job、也没有需要 Human Gate 的情况下，agent 可能在完成一次只读 search/inspection 后不再发出下一笔 edit/run/tool call；UI 停留在最后一条“searched/inspected”进度，看起来像仍在执行，实际没有任何后台工作。
- **Evidence / Detail**: 2026-08-21 `task-reliability-hostverifier-20260821-001` 的 Slice A/A1：`job_a7b944e8-c162-455a-a251-56b5346a0fe3` 已以 73 files / 703 tests PASS 结束，随后完成 production `execFileSync("git", ...)` 枚举；之后 task 长时间保持 3 changed files、无新增 job/commit/edit，直到 Human Owner指出停滞。恢复后立即迁移 `src/commit.ts`、`src/push.ts`、`src/prOpen.ts`，changed files 3→6，并得到新 job `job_cf470d0b-02bc-425c-88a6-ef89a4e2f86d` 73 files / 703 tests PASS，证明当时不是代码、Git base 或测试 blocker。当前只有这一份明确样本，不能据此断言根因在模型、ChatGPT harness 或 GrandeGPT Gateway。
- **Related**: GG-BL-010 会中断工具调用通道，但本次没有 tool-disabled/error，且恢复后同一会话继续成功调用 GrandeGPT，因此目前不合并为同一根因。
- **Next**: 先建立可观测性而不是猜根因：为长任务记录最近一次“有副作用或 job 状态推进”的 progress timestamp/phase/next action，并在 `READY + blocker=null + no running job` 且超过合理 inactivity window 时给出显式 stalled/needs-resume 状态或提示；同时收集下一次复现时的 ChatGPT-dispatched call、Gateway `/mcp/[rpc]/[tool]`、task audit/job timeline，区分“模型未发调用”“平台未派发”“Gateway 未执行”。不要新增 daemon、通用自动执行器或绕过 Human Gate。
- **Done when**: 至少一个真实长任务复现/回归证明静默停滞能被明确检测并报告唯一 next action，不再把无后台活动显示成持续执行；恢复路径不需要重建 task、不丢 worktree 改动、不降低工具安全边界，并有测试钉住 task liveness/status 语义。

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

### GG-BL-013 — Host outer-test 自动形成 exact-SHA merge gate

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: S18 增加 `OuterTestReceipt`，绑定 task/repo/exact commit/plan/toolchain；HEAD 或 plan 变化使旧 receipt 失效；`grande_pr_merge` 对 GrandeGPT self-host task 要求 current-plan exact-SHA host verification receipt，并保持无通用 `host_exec`/unsandboxed escape hatch 的安全边界。
- **Verification evidence**: receipt persistence/expiry、merge fail-closed、load-bearing host verification tests 已纳入 Phase 5.5；closeout 的最终 host verification 对 closeout commit 再生成 exact-SHA receipt。
