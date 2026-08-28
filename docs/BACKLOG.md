# GrandeGPT Backlog

> **AllJobs canonical backlog / single source of truth**
>
> 本文件遵循 AllJobs canonical backlog 格式（每个条目为 `## ID: Title` 小节 + `yaml alljobs` 元数据块），仍是 GrandeGPT 当前 backlog 的唯一权威索引。由原 bullet-style `docs/BACKLOG.md`（最后整理：2026-08-28）经 AllJobs `planning:convert` 转换生成。`CLAUDE.md`、`docs/research/**`、PR/TaskBrief 和聊天结论只能作为 evidence/detail，**不得单独维护当前状态**。

### 维护规范

#### ID

- 格式：`GG-BL-NNN`，一经分配不复用、不改号。
- 同一根因的重复复现更新原条目的 Evidence，不新开重复 ID。
- 后来确认是另一根因时才拆新 ID，并在两边写 `Related`。

#### Priority

| Priority | 含义 |
|---|---|
| **P0** | 破坏 Golden Path、可导致 production outage / 数据或安全边界风险、或已重复出现且会污染后续任务基线。优先于新功能。 |
| **P1** | 重要可靠性/运维缺陷；有 workaround，但会持续制造人工介入、误判或闭环摩擦。 |
| **P2** | 应修的可用性、韧性、least-privilege 或维护问题；不阻塞当前主流程。 |
| **P3** | 低优先级文档/兼容性清理。 |
| **OBS** | 外部平台行为或证据不足的观察项；先收集复现，不默认承诺 GrandeGPT 代码修复。 |

#### Status

| Status | 含义 |
|---|---|
| **OPEN** | 问题成立，尚未完成修复。 |
| **MITIGATED** | 已有有效缓解，但根因/自动闭环仍未完成。 |
| **OBSERVATION** | 仅观察；需要更多证据或属于外部平台。 |
| **BLOCKED** | 修复方向明确，但依赖 Human/external platform。 |
| **DONE** | 完成判据已被证据满足。DONE 条目保留 ID，移到 Archive，不删除。 |

`ACCEPTED` 不作为 backlog status。明确接受且不计划修的架构取舍放在 `CLAUDE.md` 的 **已接受的风险**。

#### 写入与关闭纪律

- **先查重**：新发现先搜索 `GG-BL-*` 与标题关键词；重复复现追加 Evidence。
- **证据与状态分离**：research 文档允许很长，但当前 priority/status 只在这里维护。
- **修复不等于关闭**：代码 merge 后必须满足 `Done when`；涉及 production 的还要有 runtime/host 行为证据。
- **关闭不删除**：改为 `DONE` 并移到 Archive，写明修复 PR/commit/验证证据。
- **部分修复**：保留原 ID，状态改 `MITIGATED`，明确还剩什么。
- **外部平台**：用 `OBS / OBSERVATION`；不要为了适配平台偶发现象降低 Gateway policy、annotations 或绕过安全边界。
- **详细文档不双写状态**：`docs/research/**` 只保存时间线、复现和设计背景；若其中旧状态与本文件冲突，以本文件为准。

### Not backlog

以下内容**不要**重复创建 backlog：

- `CLAUDE.md` 的 **已接受的风险**：明确取舍，不是待办；除非 Human Owner 重新打开决策。
- `package.json` 的 `postinstall/prepare` 宿主执行风险：当前是已知且有意保留的安全/可用性取舍；若威胁模型变化再建立新 ID。
- 已修复并有验证证据的历史事故（token epoch、loopback bind、schema arg validation、outer-test 等）：保留历史记录，不重新进入 Active。
- research 文档中的旧 priority/status：只作为当时快照，当前状态以本文件为准。

## GG-BL-006: `selfcheck` 对交互 shell 的 `GRANDE_ISSUER` 依赖易误判

```yaml alljobs
id: GG-BL-006
work_mode: implementation
status: ready
priority: P2
phase: maintenance
done_when: shell 缺 issuer 时输出能清楚区分“CLI 环境缺失”和“Gateway 不健康”，并保持 fail-closed。
```

- **Category**: operations UX
- **Problem**: LaunchAgent/Gateway 已正常配置 production issuer 时，普通 shell 直接运行 `grande selfcheck` 仍会因 shell 未设置 `GRANDE_ISSUER` 而失败，容易被理解成 Gateway outage。
- **Evidence / Detail**: [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md)。
- **Next**: 不降低 issuer/audience 校验；优先改善诊断文本和 `gateway status` 的可信 issuer 展示。
- **Original status**: OPEN

## GG-BL-008: GitHub fine-grained PAT least-privilege 与生命周期

```yaml alljobs
id: GG-BL-008
work_mode: implementation
status: ready
priority: P2
phase: maintenance
done_when: production PAT 权限与 GrandeGPT 当前所需操作一一对应，过期/失效有明确预警或 runbook，且真实
  push/PR/CI/merge 验证通过。
```

- **Category**: security / operations
- **Problem**: 历史 PAT 配置包含当前切片用不到的部分写权限，并记录了到期时间；权限与有效期需要按当前真实 repo/功能重新核对。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #10；历史记录也指出 `GET /user/repos` 不能证明 fine-grained repository grant。
- **Next**: 用当前 GitHub 功能矩阵重新做 least-privilege review，并在 credential health/doctor 中提供可操作诊断。
- **Original status**: OPEN

## GG-BL-009: 历史 S0 文档仍含过期 `repo_edit` 能力描述

```yaml alljobs
id: GG-BL-009
work_mode: implementation
status: ready
priority: P2
phase: maintenance
done_when: 当前权威入口不会把读者导向旧能力结论，历史文件保留但明确 superseded。
```

- **Category**: docs
- **Problem**: 部分历史 S0 文档仍写 `repo_edit` 不支持 delete，与 S1+ 当前能力不同。
- **Evidence / Detail**: `CLAUDE.md` 历史 S0.5 遗留 #8。
- **Next**: 仅在容易被误当当前规格的入口加 historical/superseded 标记；不大规模重写历史记录。
- **Original priority**: P3
- **Original status**: OPEN

## GG-BL-010: 当前会话的 GrandeGPT direct tool execution channel 会被禁用

```yaml alljobs
id: GG-BL-010
work_mode: implementation
status: doing
priority: P0
phase: maintenance
done_when: "**跨客户端两任务** formal matrix 三次全绿，随后 7 天 / ≥5 ordinary conversations 无
  unexplained disablement，或获得可控根因并证明长期稳定后再转 DONE。formal matrix 已满足；当前仍保持
  MITIGATED，等待 observation 完成。"
```

- **Category**: reliability / ChatGPT App session binding
- **Problem**: GrandeGPT App/插件仍显示 installed/enabled、server schema/tool discovery 正常时，某个运行中的 ChatGPT 会话仍可能在真实 `grande_*` 调用时直接 disabled，随后该会话无法继续使用 GrandeGPT。
- **Evidence / Detail**: 早期样本见 [`docs/research/2026-08-19-phase5-production-followup-backlog.md`](research/2026-08-19-phase5-production-followup-backlog.md) 与 [`docs/chatgpt-connector-compatibility-runbook.md`](docs/chatgpt-connector-compatibility-runbook.md)。已有 89 次、256 次调用后 pre-Gateway disable 样本，以及 installed/enabled、schema discovery 可见时首次真实调用即 disabled 的样本；还观察过 client snapshot 23 tools 而同一 production Gateway 为 25 tools / epoch 2，证明 session/app binding 与 server tool identity 可分叉。
- **Release A evidence (2026-08-21)**: candidate `7b98f7dce2f0b10723b29be64ca28e1438f1a779` 加入真实 `buildTools` handler/fixture 行为回归与 canonical result-budget coverage；exact candidate Host boundary 验证为 **5 files / 160 tests PASS**。该历史证据继续作为 connector-compatibility 文档契约的一部分，不因为 Phase 8 closeout 被压缩掉。
- **Mitigation**: 保留 server-side toolset identity、32 KiB result budget、单次终态 result、有界轮询/分页、compatibility runbook 与长会话真实工具调用回归；不降低 annotations、不绕过 Gateway、不增加第二执行通道。
- **2026-08-23 Phase 8 evidence**: Phase 8 在不改变 25-tool identity 的情况下完成大量真实 status/read/edit/run/PR/merge 调用并成功 activation，说明 flow simplification 可独立发布；这**不等于** binding drift 已根因关闭。
- **2026-08-23 target-client capability evidence**: OpenAI Help Center 当日公开说明仍写 custom/full MCP apps mobile unavailable / web only，但 Human Owner 当前 ChatGPT iOS 原生会话可以真实连续调用 GrandeGPT direct tools。平台文档与实际 rollout/account/product-path 存在冲突；本项目 release gate 因此以目标客户端真实 capability 为准。当前 iOS capability 已确认，所以本轮 formal matrix 仍包含 iOS。
- **2026-08-23 formal matrix evidence**: `C-Web-1 + C-iOS + C-Web-2` 已 **3/3 PASS**。三次运行均在 frozen `toolsetEpoch=2` / `toolsCount=25` / digest `sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815` 下完成 same-conversation two-task gate，无 unexplained disabled / Resource not found / unexpected formal-path 401 / Gateway restart / identity drift；详见 C-Web-1、C-iOS、C-Web-2 独立 evidence。另有 `C-macOS-App supplemental validation: PASS`，只作为额外客户端覆盖，不改变 formal matrix 组成。
- **Remaining**: §7.2 formal matrix 已完成。现在只剩 §7.3 **7-day ordinary-use observation**：至少 5 个普通 conversation、每个 conversation 至少 2 个真实用户任务，覆盖 Web 与当前实际 capability-supported 的 iOS；只保留 redacted telemetry summary，7 天内不得出现 unexplained disablement，并要求 frozen formal identity 仍成立。该 Remaining 同时构成 Phase 9 public Tool Epoch 的 release gate。
- **Escalation**: 若在 frozen identity / under-budget 条件下出现两个独立、当前 epoch、证据完整的 pre-Gateway disable 样本，且失败调用未到 Gateway、无 401/restart/identity change，则停止继续通过 server payload/OAuth/annotations/tools-list 试探，转 `BLOCKED — ChatGPT platform/session binding boundary` 并附完整证据。
- **Original status**: MITIGATED

## GG-BL-024: 下一次 Tool Epoch 收敛公开 MCP surface

```yaml alljobs
id: GG-BL-024
work_mode: implementation
status: blocked
priority: P2
phase: phase-9
done_when: ①旧 25-tool identity 与新 identity 明确不同且新 count/epoch/digest 稳定；② public
  deliveryTarget 正式可选且扩大外部副作用需要 Human confirmation；③删除工具不再出现在 tools/list；④
  `repo_register` 不接受 path/force，proposal 零写入，register 保持 Human Gate/stale
  protection；⑤ deploy 重入不重复外部副作用；⑥ task 自动 cleanup 不暴露通用 delete；⑦ Dev/Production
  App refresh 后所有当时实际 capability-supported 的目标 release clients 用 fresh
  conversation 完成真实任务；⑧失败可直接 rollback 上一 Gateway build/tool epoch。
```

- **Category**: MCP contract / tool surface
- **Problem**: 当前 25-tool contract 中仍有 onboarding 两工具、capability inspect、deploy verify、task close 等可在保持风险语义的前提下合并或内部化；Phase 8 的 internal delivery-target projection 也尚未进入 public TaskBrief schema。零散修改 tools/list 会放大 ChatGPT binding/snapshot 排障变量。
- **Evidence / Detail**: 2026-08-22 owner-approved simplification proposal 要求一次正式 tool epoch 收敛；Phase 8 已完成 no-tool-epoch primitives，且 production 仍保持 25 tools / epoch 2 / 原 digest。`GG-BL-010` 证明 session/app binding 与 server tool identity 可分叉，因此本项目前被 release gate 阻塞。
- **Next**: **先完成 `GG-BL-010` release-ready gate，不提前改 production contract。** gate 满足后一次 release 完成：① public `TaskBrief.deliveryTarget`；② `repo_add_propose/apply → grande_repo_register`；③ capability inspect 并入 list filter；④ deploy verify 并入可重入 deploy；⑤正常完成路径移除公开 task_close；⑥ bump toolset epoch 并执行 Dev/Production App refresh。
- **Original status**: BLOCKED

## GG-BL-025: 内部执行、receipt 与 tool assembly 存在潜在重复和隐式耦合

```yaml alljobs
id: GG-BL-025
work_mode: implementation
status: ready
priority: P2
phase: phase-10
done_when: ①逐项 evidence review 完成并删除已经不存在的 scope；②若 runner/verifier 确有重复，仅保留一套窄
  process lifecycle primitive；③ receipt/job eligibility 有单一 fail-closed
  parser/validator；④ deployment 不通过公开 MCP handler 触发内部领域动作；⑤写工具 wrapper
  顺序有集中测试且不依赖共享可变 ToolDef；⑥没有新增与轻量定位冲突的通用框架。
```

- **Category**: architecture / maintainability
- **Problem**: 2026-08-22 架构评审指出 runner/host verifier process supervision、job/receipt JSON eligibility、公开 tool handler 互调以及 handler wrapping/assembly 可能存在重复实现或隐式顺序耦合；设计基线早于部分 Phase 6–8 改动，不能把旧快照直接当成当前代码事实。
- **Evidence / Detail**: owner-reviewed lightweight architecture design；Phase 8 新增 flow wrapper 后更应先做最新 canonical evidence review，而不是直接抽象框架。
- **Next**: 先做 code evidence review。只对仍存在且至少有两个真实使用者的重复 primitive 做收敛；禁止建设 workflow engine、通用 interceptor framework、第二状态系统或 capability marketplace。
- **Original priority**: P3
- **Original status**: OPEN

## GG-BL-030: post-merge release closeout 缺少受控 canonical docs 回写路径

```yaml alljobs
id: GG-BL-030
work_mode: implementation
status: blocked
priority: P1
phase: maintenance
done_when: ① 已注册 repo 的 canonical main 可通过 GrandeGPT 一次 closeout 请求完成一组允许的
  docs/evidence/backlog 修改，并最终在 canonical main read-back；②不依赖 ChatGPT GitHub
  integration Contents API 写权限；③支持 expected HEAD CAS 与已有文件 expected
  digest；④dirty canonical、stale HEAD、unauthorized
  repo/path、non-fast-forward/merge rejection、partial edit failure 全部 fail
  closed；⑤一次多文件 closeout 只产生一个原子 commit/merge outcome；⑥完整 audit receipt 可读回
  before/after HEAD、commit/merge SHA、changed files 与 push/merge/read-back 结果；⑦无
  repo 外写、force push、generic host shell 或 source-code hotfix bypass；⑧自动化覆盖 happy
  path、stale HEAD、dirty repo、unauthorized repo/path、push/merge rejection、partial
  edit failure；⑨以 `grande-console` 与 `mathmagics` 的真实 release closeout 复现为
  E2E，完成 closeout 后从 canonical main 读回验证。
```

- **Category**: developer workflow / repository write / release closeout
- **Problem**: GrandeGPT 已能完成 task worktree 开发、commit、push、PR、merge、deploy 与 verify，但 release 验收后对 `docs/BACKLOG.md`、verification/release evidence、`README.md` 等 canonical truth source 的收尾没有一条明确的一次性 closeout 路径。当前 `grande_repo_edit` 只写 task worktree；若调用方转而依赖 ChatGPT GitHub integration 的 Contents API / merge 权限，则可能因 integration scope 返回 `403 Resource not accessible by integration`，最终退化为 Human Owner 本机 `gh` / shell。虽然可以另开 docs-only task 再走一遍 PR 流程，但这不是 first-class release closeout，且会持续制造额外任务/PR ceremony 与人工误用外部 GitHub integration 的机会。
- **Evidence / Detail**: 2026-08-25 `grande-console` Pleurat redesign release closeout：implementation、tests、PR、merge、production activation 与 live smoke 已完成，最后仍需要同步 BACKLOG / verification / README；ChatGPT GitHub integration 的写/merge 路径出现 `403 Resource not accessible by integration`，Human Owner 使用本机 `gh` 完成 merge，docs-only closeout 仍暴露同类人工 fallback。2026-08-26 `mathmagics` Phase 6 再次复现：PR #6 已 merge 且 canonical exact-HEAD Host verification 已通过后，`.agent/CURRENT.md` / `.agent/BACKLOG.md` 仍停在 `Host Verification Pending`，只能再创建 `task-mathmagics-phase6-closeout-20260826-001` 与第二个 docs-only PR #7 才能把 release truth 回写 canonical。当前 GrandeGPT contract 也明确 `grande_repo_edit` 只能写 task worktree，不接受 canonical target。
- **Design direction**: 优先实现一个窄的 **canonical docs closeout domain primitive / workflow**，而不是把 `grande_repo_edit` 泛化为 `target=canonical`，更不开放 generic host shell。外部可表现为一次 closeout 调用，但内部优先复用现有受控链路：registered repo + per-repo write lock + expected canonical HEAD CAS → 独立 closeout worktree/branch → 原子多文件 edit → commit → GrandeGPT 自有 credential push → 现有 PR/merge gate → canonical ff-only refresh → read-back receipt。只有后续证据证明 PR-under-the-hood 无法满足 closeout，才评估更高风险的 direct default-branch commit；不得先默认开放 `git push main`。
- **Path policy**: “docs-only”必须由 **路径分类 + 明确 denylist** 决定，不能只按 `.md/.yaml/.json` 扩展名放行。至少允许 repo 明确的 `README.md`、`docs/**` 中 closeout/evidence/backlog 文档与经注册的额外路径；必须拒绝 repo 外路径，以及 `.github/workflows/**`、package manifests/lockfiles、`.grande/**`、auth/secrets/control-plane、可执行脚本和其他会改变 build/runtime/permission 语义的配置。未知路径 fail closed；源码修改继续走正常 task/PR development。
- **Security / integrity**: 必须验证 registered repo、允许的 base branch、clean canonical、`expectedHead` CAS、每个已有目标文件的 expected blob/content hash；canonical HEAD 漂移、dirty tree、unauthorized path/repo、partial edit、non-fast-forward/merge rejection 均 fail closed。不允许 force push、reset-hard、branch deletion、repo 外写入或任意 host command。一次 closeout 的多个文件必须形成单一 atomic commit/merge outcome。
- **Audit receipt**: 每次 closeout 至少记录 repo、branch、before HEAD、after HEAD、changed files、每个文件 before/after digest、actor/task/reason、closeout branch/PR（若使用）、commit/merge SHA、push/merge result 与 canonical read-back 结果；失败不得留下“部分已更新但状态显示 DONE”的 receipt。
- **Related**: `GG-BL-001`（canonical refresh，已 DONE）、`GG-BL-008`（GrandeGPT GitHub credential least-privilege）、`GG-BL-017`（per-repo write lock，已 DONE）、`GG-BL-010`（当前 public tool-contract release gate）、`GG-BL-024`（下一次 Tool Epoch surface convergence）。
- **Blocked by / sequencing**: production 25-tool contract 在 `GG-BL-010` §7.3 observation 完成前冻结，因此不得为了本项单独修改 public `tools/list` 或 `grande_repo_edit` schema。可以先设计/实现不暴露的新 internal primitive 与测试；用户可调用的 public surface 应与 `GG-BL-024` 下一次正式 Tool Epoch 一并评审和发布，避免额外 tool snapshot/digest churn。
- **Original status**: BLOCKED

## GG-BL-034: existing external self-host PR 无法纳入 exact-SHA Host Verification / merge lifecycle

```yaml alljobs
id: GG-BL-034
work_mode: implementation
status: ready
priority: P1
phase: maintenance
done_when: "①已有 external self-host PR 可在 Human 授权下安全 adopt 到 controlled
  Task；②receipt/attestation/CI/PR head 全部绑定同一 exact SHA；③SHA drift、repo
  mismatch、dirty/stale state fail closed；④adopt 后继续复用正常 `grande_pr_merge`，不新增
  bypass merge path；⑤PR #50 场景可不依赖人工 exception 完成。"
```

- **Category**: developer workflow / self-host verification / PR adoption
- **Problem**: GrandeGPT 当前将 Host Verification receipt 与 `grande_pr_merge` 绑定到 Task-owned branch/worktree。由 Codex、Work mode 或其他外部路径创建的 self-host PR 即使代码、CI 与 review 已满足要求，也没有合法方式绑定到现有 Task，因此无法通过正常 exact-SHA Host Verification receipt 与 merge gate。
- **Evidence / Detail**: GitHub issue #51。PR #50 `codex/gg-bl-033-ci-baseline` 的 exact head `7d431ba8e6863d6d0f23671786af1f74a0ac1c35` 无法绑定到当时 active self-host task；现有 task HEAD 为另一分支 SHA，继续验证会验证错误 commit。最终只能采用 Human Owner 明确授权的 external-PR exception 完成 closeout。
- **Design direction**: 增加 fail-closed 的 existing-PR adoption 机制，只允许显式用户授权的 registered self-host repo PR。adoption 必须绑定 PR number + exact remote head SHA + controlled task/worktree，并重新校验 repo ownership、cleanliness、remote PR head、CI、attestation 与 current canonical relation；不得演化为 generic arbitrary-branch merge path。
- **Security boundary**: 不接受任意 repo/path/branch；不得跳过 attestation、CI、exact-SHA Host receipt 或现有 `grande_pr_merge` gate；PR head 漂移、repo 不匹配、dirty worktree、stale canonical 或无法证明 ownership 时全部 fail closed。
- **Related**: `GG-BL-013`（exact-SHA Host gate，DONE）、`GG-BL-030`（canonical closeout path）、`GG-BL-033`（触发本缺口的 canonical CI repair）。
- **Next**: 先设计最小 adoption primitive 与 RED tests，覆盖 external PR happy path、SHA drift、repo mismatch、dirty worktree、stale attestation、wrong-task binding。保持 public MCP surface 不变，除非与下一次正式 Tool Epoch 一并发布。
- **Original status**: OPEN

## GG-BL-011: `grande_repo_search` 的 truncated 信号曾被忽略

```yaml alljobs
id: GG-BL-011
work_mode: implementation
status: idea
priority: P2
phase: maintenance
done_when: 重复证据足以升格工程项，或长期无复现后由 Human Owner 明确归档。
```

- **Category**: agent UX
- **Problem**: 曾有一次模型收到 `truncated + nextCursor` 后没有继续分页。
- **Next**: 收集重复样本；若成为稳定失败模式，再考虑 guidance/UI 改善。
- **Original priority**: OBS
- **Original status**: OBSERVATION

## GG-BL-012: `/.well-known/openid-configuration` 返回 404

```yaml alljobs
id: GG-BL-012
work_mode: implementation
status: idea
priority: P2
phase: maintenance
done_when: 出现真实需要后实现并验证兼容，或确认长期无需支持并由 Human Owner 归档。
```

- **Category**: OAuth compatibility
- **Problem**: ChatGPT/其他客户端可能探测 OIDC discovery path；GrandeGPT 当前提供 OAuth authorization-server metadata，现有 OAuth 流程正常，但该路径仍为 404。
- **Next**: 仅在真实客户端兼容性要求出现时评估别名/兼容端点。
- **Original priority**: OBS
- **Original status**: OBSERVATION

## GG-BL-029: 受控 macOS native build / execution 缺少 Darwin toolchain dependency closure

```yaml alljobs
id: GG-BL-029
work_mode: implementation
status: done
priority: P1
phase: maintenance
```

- **DONE date**: 2026-08-24
- **Fix**: PR #38 / #39 补齐 trusted `darwin-clang` 所需的最小只读 Developer Tools selector closure；PR #40 增加 trusted-profile-only、repo-relative exact `nativeExecTargets`，允许同一 sandbox job 编译并执行固定 native artifact。没有开放 generic shell / generic host exec、任意 executable、`/var` subtree 或 public MCP surface。
- **GrandeGPT evidence**: PR #38 merge `0f29af634f138dcc141ca9c1f1c01c72fb6d2661`；PR #39 merge `9e51252e0e387c496d3c1cd9772545728da15bed`；PR #40 merge `af30bc3ab9b2966685973b4a876e6c42711ae09c`；PR/canonical CI PASS，production activation 已完成。
- **Real consumer evidence**: `grande-obsidian-mcp` Phase 3 PR #4 在 GrandeGPT 受控路径中完成固定 Darwin helper 编译/执行，真实验证 `RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH`；14 test files / 104 tests PASS，并完成 target-overwrite load-bearing proof。Phase 3 live S5 acceptance 后续 PASS，PR #6 正式记录 PASSED/CLOSED。
- **Done evidence**: 原始 P3-0 `clang → xcode-select → /var/select/developer_dir → EPERM` sandbox/toolchain blocker 已不再存在；真实消费方已越过编译器初始化并完成目标 native 行为验证，同时安全边界未扩大。
- **Original status**: DONE

## GG-BL-031: fresh task worktree / canonical checkout 缺少可靠 dependency bootstrap

```yaml alljobs
id: GG-BL-031
work_mode: implementation
status: done
priority: P1
phase: maintenance
```

- **DONE date**: 2026-08-27
- **Task / PR**: `task-gg-bl-031-bootstrap-triggering-20260827-001` / PR #45
- **Fix**: 完成受控 dependency bootstrap triggering 与隔离 cache materialization，使 fresh npm/pnpm worktree 首次 profile execution 可自动准备依赖；identity 绑定 package manager、lockfile、Node/platform/arch，避免跨 repo 共享可变 `node_modules`。
- **Verification evidence**: exact head `df5ca534383bc0650166fb29cd5d5f201e5c68e8`；GitHub CI、attestation、exact-SHA Host verification PASS；merge SHA `e2e6ec1df00e16b436fb708fe8c371ba57687d6d`。production activation receipt 读回同 build / epoch 2 / 25 tools；MathMagics 两个 fresh worktree 真实 E2E 均无需 Human `npm ci`，第二个 worktree 命中隔离 cache 并直接进入 Vitest。
- **Original status**: DONE

## GG-BL-032: host verification applicability policy

```yaml alljobs
id: GG-BL-032
work_mode: implementation
status: done
priority: P0
phase: maintenance
```

- **DONE date**: 2026-08-28
- **Task / PR**: `task-gg-bl-032-host-verification-20260828-001` / PR #49
- **Root cause**: `taskProgress` 对所有 registered repo 投影 Host Verification requirement，但 `prLifecycle` 只对 `grande-gpt` self-host 强制 receipt，导致非 self-host status contract 与 destructive merge enforcement 不一致。
- **Fix**: 建立共享 `isHostVerificationApplicable(repoId)` policy/source-of-truth。非 self-host repo 直接投影 `requiredLevel=none`、`state=not-required`、`receiptEligible=true`，不调用 Host inspector、不进入 host-verification phase；`prLifecycle` 复用同一 policy。
- **Verification evidence**: final exact head `c5552eab531777d16fd58a85292b9233c29ea77c`；`unit-selfhost` 130 files / 939 PASS / 2 skipped；typecheck PASS；attestation `att_e18e8222-2e48-49fe-b488-ef466f601856`；Ubuntu CI GREEN；macOS Seatbelt 因 paths filter 不适用；independent review APPROVE；manual trusted Host suite 11 files / 187 PASS。
- **Release evidence**: merge SHA `6b459fed0d5b19998e192b54dd50a6c9f1fce399`；canonical main 同 SHA；post-merge main CI GREEN。
- **Original status**: DONE

## GG-BL-033: canonical main CI portability baseline

```yaml alljobs
id: GG-BL-033
work_mode: implementation
status: done
priority: P0
phase: maintenance
```

- **DONE date**: 2026-08-28
- **PR**: #50
- **Problem**: canonical main CI 在 Ubuntu 与 GitHub-hosted macOS 上因 macOS-only `/bin/cp -Rc`、platform-specific CLI expectations、Seatbelt PATH/runtime resolution 以及 stale historical toolsDigest fixture 失败，阻塞后续 self-host exact-SHA merge gates。
- **Fix**: 用共享 Node native copy helper 替换 `/bin/cp -Rc` 并保留 relative symlink text；将 doctor/gateway tests 改为 platform-aware contract；把 active Node root 放到 sandbox PATH 首位而不扩大 exec roots/permissions；更新 GG-BL-028 后已过期的 pinned toolsDigest fixture。
- **Verification evidence**: final exact head `93bdfdd119a20bbddf1b2fda8bcf44d0c57ec83b`；targeted `tools.test.ts` 53 PASS；typecheck PASS；trusted Host suite 11 files / 187 PASS；Ubuntu `verify` GREEN；macOS `seatbelt-dns` GREEN；independent review APPROVE（symlink blocker 修复后仅做 proportional re-review）。
- **Release evidence**: merge SHA `1d96292dfaa9b6f1dfa01e55be6fd436467af067`；canonical main 同 SHA 后 Ubuntu CI / macOS Seatbelt GREEN。该 PR 暴露的 external existing self-host PR adoption gap 独立记录为 `GG-BL-034` / GitHub issue #51。
- **Original status**: DONE

## GG-BL-028: mutable profile registry 污染 `toolsDigest`

```yaml alljobs
id: GG-BL-028
work_mode: implementation
status: done
priority: P1
phase: maintenance
```

- **DONE date**: 2026-08-27
- **Task / PR**: `task-gg-bl-028-digest-stability-20260827-002` / PR #47
- **Root cause**: runtime registered repo/profile state 曾进入 `grande_run.inputSchema.properties.profile.description`，而 `inputSchema` 属于 `toolsDigest` hash contract，导致 same-build / same-epoch / same-count 下 registry mutation 可改变 digest。
- **Fix**: `profile` schema description 固定为 `要执行的 profile 名称`；mutable profile discovery 保留在 top-level tool description；不修改 hash algorithm，不 bump `TOOLSET_EPOCH`。
- **TDD evidence**: RED same-build registration mutation `sha256:4af6e790f0d4b50fc99b5dbfc3d120ccbd757f1a208ff515ed57b10079035907 → sha256:9b38932c3fb884860ff1d15a4f64360e7ecb8ceadb443f3461003785798e5a5c`；GREEN `unit-selfhost` **128 files / 935 tests PASS**、2 skipped、0 failed，`typecheck` PASS。
- **Release evidence**: exact head `0956ea206bcb0bea69d051afb0ee74e3e554dfbe`；GitHub CI PASS；exact-SHA Host smoke PASS；merge SHA `e9e6a4da50da91004e82154b73837463bf611e08`。
- **Production evidence**: build `git:e9e6a4da50da91004e82154b73837463bf611e08`；`toolsetEpoch=2`；`toolsCount=25`；`toolsDigest=sha256:7f2390e540b4311f9e3f70b890239460bf0c63e770e3c2e45f227dac41dcb7da`；activation receipt eligibility 已证明 runtime build/tool identity、LaunchAgent/endpoint readiness 与 trusted read probe HTTP 200 全部一致。
- **Related**: `GG-BL-010`、`GG-BL-024`、`GG-BL-030`。
- **Original status**: DONE

## GG-BL-026: npm repo 的 verification attestation 错误绑定 pnpm toolchain

```yaml alljobs
id: GG-BL-026
work_mode: implementation
status: done
priority: P0
phase: maintenance
```

- **DONE date**: 2026-08-24
- **Task / PR**: `task-npm-compat-20260824-001` / PR #35
- **Fix**: 新增窄 `packageManagerIdentity` primitive；verification identity 显式记录 `packageManager / packageManagerVersion / lockfile / lockfileSha256`，支持 pnpm 与 npm；冲突、缺对应 lockfile、unsupported manager fail closed；legacy pnpm attestation/receipt 保持只读兼容。ordinary attestation、trusted Host Verifier、V2 receipt 共用同一 identity 语义。
- **Verification evidence**: exact candidate `585ead9a990728625576801e240e332cbf592233`；fresh `unit-selfhost` **118 files / 888 tests PASS**、`typecheck` PASS、GitHub Actions PASS；manual Host outer-test **10 files / 176 tests PASS**；PR #35 merge SHA `b2da29a954f9453622f7455387da2bb3c7bd2de2`；production activation receipt 已读回 `targetBuild = runtimeBuild = git:b2da29a954f9453622f7455387da2bb3c7bd2de2`、`toolsetEpoch=2`、`toolsCount=25`、`toolsDigest=sha256:ce3a7107fd8861f5816b94bda803dd9bdae5059d25cf14627ae8fbde49b31227`，LaunchAgent running、endpoint ready、read probe HTTP 200。
- **Original status**: DONE

## GG-BL-027: npm `node_modules/.bin` symlink target 被 Seatbelt `process-exec` 拒绝

```yaml alljobs
id: GG-BL-027
work_mode: implementation
status: done
priority: P1
phase: maintenance
```

- **DONE date**: 2026-08-24
- **Task / PR**: `task-npm-compat-20260824-001` / PR #35
- **Fix**: `runSandboxed()` 从当前 worktree 根部 `node_modules/.bin` 重新枚举 symlink，只接受 `realpath` 后仍位于本 worktree `node_modules` 内的普通文件，并把真实 target 作为 exact `literal process-exec` allow；`buildProfile()` 再做 containment 校验。没有放开整个 `node_modules` 或 worktree。
- **Verification evidence**: trusted Host suite 验证 npm-style `.bin -> node_modules/<pkg>/...` 正向执行、越界 target 拒绝、worktree 其他 executable 拒绝，并包含 load-bearing A/B proof：去掉 exact-target allow 时同一 npm case 重新得到 `Operation not permitted`。同一 exact candidate `585ead9a990728625576801e240e332cbf592233` 完成 `unit-selfhost` **118/888 PASS**、`typecheck`、GitHub Actions、Host **10/176 PASS**；PR #35 merge SHA `b2da29a954f9453622f7455387da2bb3c7bd2de2`，随后 production activation 到该 merge SHA。
- **Original status**: DONE

## GG-BL-001: PR 已 merge，但 local canonical `main` 仍旧

```yaml alljobs
id: GG-BL-001
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: S16 引入受控 canonical refresh：固定 registered repo、origin/current canonical branch、clean precondition、fetch+compare+fast-forward-only；dirty/diverged fail closed；`task_open` 基于 refresh 后 canonical。
- **Verification evidence**: canonical refresh / task-open 行为与 fail-closed 测试纳入 Phase 5.5 gates。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-002: `grande gateway restart` 非 failure-safe

```yaml alljobs
id: GG-BL-002
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: loaded restart 使用 `kickstart -k`；unloaded bootstrap error 5 有限重试；restart success 前等待 endpoint readiness，并暴露 runtime identity。
- **Verification evidence**: fresh `unit-selfhost`/typecheck；S17 production acceptance 10/10 restart 全绿。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-003: `grande_sync_base` 方向与 `up-to-date` 文案误导

```yaml alljobs
id: GG-BL-003
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: contract 明确 canonical → task，绝不修改 canonical；relation 为 `equal/task_ahead/canonical_ahead/diverged`。
- **Verification evidence**: task-ahead / canonical-ahead / diverged 行为回归纳入 Phase 5.5 tests。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-004: Merge 与 production runtime activation 仍是两步

```yaml alljobs
id: GG-BL-004
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 / `task-p55-20260819-001`
- **Fix**: release activation evidence 显式化，通过 `gatewayBuild/toolsetEpoch/toolsCount/toolsDigest` 识别实际 runtime，不再把 merged 等同于 activated。
- **Verification evidence**: S17 10/10 restart acceptance 与真实 read probes；后续由 GG-BL-019 durable activation receipt 完整收敛。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-005: GC 看不到 `CLOSED` 但 worktree 残留

```yaml alljobs
id: GG-BL-005
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Task**: `task-p1-20260822-001`
- **Fix**: 增加 `closedResidualWorktrees` reconciliation，受管 path + current-state recheck + existing `removeWorktree`，Gateway 启动只报告不自动删除。
- **Verification evidence**: real Git worktree fixtures；candidate `unit-selfhost` 98 files / 827 tests PASS、`typecheck` PASS。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-013: Host outer-test 自动形成 exact-SHA merge gate

```yaml alljobs
id: GG-BL-013
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 5.5 S18，后续由 Reliability & Automated Host Verifier supersede
- **Fix**: exact-SHA/current-plan Host receipt gate，后升级为 controlled automatic Host Verifier；manual CLI 保留为受信 fallback/manual-only Human Gate。
- **Verification evidence**: receipt persistence/expiry、restricted async verifier、Receipt V2、startup reconciliation 与 bounded infra retry；production controlled auto mode 已 activation。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-014: 长任务可能在只读分析后静默停滞

```yaml alljobs
id: GG-BL-014
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Task**: `task-p1-20260822-001`
- **Fix**: `TaskProgress` 增加只读 liveness projection，不写 heartbeat、不新增生命周期状态；stalled 不伪装 blocker。
- **Verification evidence**: deterministic regression；candidate `unit-selfhost` 98 files / 827 tests PASS、`typecheck` PASS。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-015: Auto Verifier 缺少最小可信运行可观察性

```yaml alljobs
id: GG-BL-015
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 6 S19 / `task-p6-20260822-001`
- **Fix**: `grande_task_status` 增加 trusted host-verifier operational snapshot，无新 MCP tool/metrics store/queue。
- **Verification evidence**: behavior tests；Phase 6 code gate 97 files / 817 tests PASS、`typecheck` PASS。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-016: Auto Verifier 失败分类与升级语义不完整

```yaml alljobs
id: GG-BL-016
work_mode: implementation
status: done
priority: P2
phase: maintenance
```

- **DONE date**: 2026-08-22
- **Phase / task**: Phase 6 S20 / `task-p6-20260822-001`
- **Fix**: `candidate | infrastructure | integrity` failure taxonomy；bounded infra retry、integrity zero-retry fail closed、SHA isolation。
- **Verification evidence**: load-bearing tests；Phase 6 code gate 97 files / 817 tests PASS、`typecheck` PASS。
- **Original priority**: (missing)
- **Original status**: (missing)

## GG-BL-007: Control-plane backup、SQLite migration 与 restore 路径不完整

```yaml alljobs
id: GG-BL-007
work_mode: implementation
status: done
priority: P1
phase: phase-7
```

- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: ordered 5→6 migration、verified pre-migration backup、transaction rollback、managed backup root/retention、dry-run Human restore、ordinary backup excludes `secrets/`。
- **Verification evidence**: real version-5 fixtures；Phase 7 exact candidate 109/859 PASS、typecheck PASS、PR #22 CI/Host gates PASS。
- **Original status**: DONE

## GG-BL-017: Gateway / CLI 缺少跨进程 repo write lock

```yaml alljobs
id: GG-BL-017
work_mode: implementation
status: done
priority: P1
phase: phase-7
```

- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: trusted control-root per-repo cross-process lock，live PID busy fail closed、ESRCH stale recovery、malformed metadata fail closed、nonce ownership release；Gateway writes 与 Git/worktree-writing CLI 共用。
- **Verification evidence**: two-process behavior tests；Phase 7 exact candidate 109/859 PASS、typecheck/CI/Host PASS。
- **Original status**: DONE

## GG-BL-018: GrandeGPT 自身缺少最小独立 CI gate

```yaml alljobs
id: GG-BL-018
work_mode: implementation
status: done
priority: P1
phase: phase-7
```

- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: pinned macOS GitHub Actions CI，Node 24、pnpm 10.33.0、frozen lockfile、selfhost-safe tests、typecheck、focused tool-contract checks。
- **Verification evidence**: final exact PR head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa` Actions run PASS；Host 10/171 PASS。
- **Original status**: DONE

## GG-BL-019: Production activation 缺少 durable evidence / receipt

```yaml alljobs
id: GG-BL-019
work_mode: implementation
status: done
priority: P1
phase: phase-7
```

- **DONE date**: 2026-08-23
- **Phase / task**: Phase 7 / `task-p7-20260822-001`
- **Fix**: durable activation receipt 绑定 target/runtime build、toolset epoch/count/digest、activation time、LaunchAgent/endpoint readiness 与 trusted read probe；mismatch fail closed。
- **Verification evidence**: Phase 7 activation receipt 跨会话成功读回；Phase 8 再次使用同一路径并读回 build `217a2dadc2887046decdeb9ab3c2813060ae7d97`，证明机制持续有效。
- **Original status**: DONE

## GG-BL-020: Task 缺少 delivery-target projection

```yaml alljobs
id: GG-BL-020
work_mode: implementation
status: done
priority: P2
phase: phase-8
```

- **DONE date**: 2026-08-23
- **Phase / task**: Phase 8 / `task-p8-20260823-001`
- **Fix**: 新增内部 `DeliveryTarget = local | pr | deploy` domain primitive 与 TaskProgress projection，基于可信现有 evidence/default 解析目标并屏蔽无关阶段，重新计算单一 blocker/nextAction。Phase 8 按批准的 no-tool-epoch 范围**未**改变 public TaskBrief schema；public explicit target 选择和外部副作用扩大确认移交 `GG-BL-024`。
- **Verification evidence**: delivery-target regressions 覆盖 local masking、PR 不要求 deploy、deploy 缺可信 spec fail closed、PR opened 后直达 merge action；Phase 8 exact candidate 112/871 PASS、typecheck/CI/Host PASS，production activation readback PASS。
- **Original status**: DONE

## GG-BL-021: 短 job 普遍需要 `grande_run → grande_run_result` 两次调用

```yaml alljobs
id: GG-BL-021
work_mode: implementation
status: done
priority: P2
phase: phase-8
```

- **DONE date**: 2026-08-23
- **Phase / task**: Phase 8 / `task-p8-20260823-001`
- **Fix**: `grande_run` response layer 使用现有 `waitForTerminalJob` 最多观察 5 秒；预算内直接返回 terminal result，超预算返回稳定 jobId + poll hint；runner 仍拥有进程 lifecycle，artifact/shutdown/timeout/RSS/recovery 语义不变。
- **Verification evidence**: short/slow regressions；Host `tools.host.test.ts` 同时验证长 job bounded wait 与短 job first-call terminal；Phase 8 Host 10 files / 172 tests PASS。
- **Original status**: DONE

## GG-BL-022: 正常 PR / verifier 流程存在不必要状态往返

```yaml alljobs
id: GG-BL-022
work_mode: implementation
status: done
priority: P2
phase: phase-8
```

- **DONE date**: 2026-08-23
- **Phase / task**: Phase 8 / `task-p8-20260823-001`
- **Fix**: TaskProgress PR projection 不再把预先 `pr_status` 当强制阶段；正常路径直接进入 `grande_pr_merge`，blocker 后才按需诊断。merge authority/exact-SHA checks 保持在 merge gate，verifier/runner 不获得 merge 权限。
- **Verification evidence**: PR #25 dogfood：direct merge → CI pending blocker → on-demand status → merge re-entry → real manual-only Host gate → receipt 后再次 merge；最终 PR #25 成功 merge，证明 continuation 减少往返但安全 gate 未退化。
- **Original status**: DONE

## GG-BL-023: 开发风险等级未正式落地，普通修改流程过重

```yaml alljobs
id: GG-BL-023
work_mode: implementation
status: done
priority: P2
phase: phase-8
```

- **DONE date**: 2026-08-23
- **Phase / task**: Phase 8 / `task-p8-20260823-001`，closeout correction `task-p8-closeout-20260823-001`
- **Fix**: 新增 `DevelopmentRiskLevel = L1 | L2 | L3` classifier；文档/非运行资源 L1、普通源码 L2、sandbox/runner/auth/gateway/host-verifier/merge/deploy/tools 等关键边界 L3，未知路径 fail closed 到 L3。`CLAUDE.md` 将对应 ceremony 写成 coding-agent 硬约束。Closeout dogfood 发现 root `CLAUDE.md` 未列入 L1 文档集合而被误判 L3，随后以最小 source/test correction 显式加入并增加回归，不扩展未知路径白名单。
- **Verification evidence**: classifier regressions + 与 existing host classifier 的 L1→none、L2→smoke、L3→full 对齐证明；Phase 8 implementation 走 L3 full/manual Host gate。Closeout 的文档 diff 首先真实暴露 `CLAUDE.md` 漏项，修复后因包含 classifier source/test correction 合理成为 L2，而不是继续承担错误的 L3 ceremony；该 correction 必须通过本任务 fresh verification/CI/merge 后才进入 canonical。
- **Original status**: DONE
