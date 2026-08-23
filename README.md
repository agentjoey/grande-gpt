# GrandeGPT

在 **ChatGPT 普通对话**中完成端到端代码开发任务的受控执行层，定位于个人开发者、小团队和中小型/轻量项目。

ChatGPT 负责理解需求、调研仓库和组织步骤；Gateway 负责授权与执行；Git worktree 隔离任务；macOS Seatbelt 沙箱执行受控 profile；Git/GitHub 与项目已有部署机制完成代码上线闭环。

> **当前状态（2026-08-23）**：S0–S3、Phase 4（S4–S7）、Phase 5（S8–S10）、Phase 5.5、Reliability & Automated Host Verifier、Phase 6 Post-Activation Hardening、Phase 7 Reliability Foundation 与 **Phase 8 Flow Simplification 均已完成并进入 canonical `main`**。
> **下一阶段：Phase 9 — Tool Surface Convergence**。Phase 9 尚未进入公开 contract 变更；必须先满足 `GG-BL-010` release-ready gate。在此之前 production contract 继续冻结为 **25 tools / toolsetEpoch=2**。
> 当前开发闭环按实际 delivery target 投影必要阶段；正常 PR 路径允许直接进入 merge gate，诊断按需展开，短 job 支持 bounded wait。

## 当前权威入口

- [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)：当前项目/production 快照、最近完成阶段和下一阶段入口。
- [`docs/BACKLOG.md`](docs/BACKLOG.md)：**backlog、优先级、roadmap 状态的唯一权威来源**。
- [`CLAUDE.md`](CLAUDE.md)：coding agent 必须遵守的当前架构、安全和执行约束。
- [`docs/chatgpt-connector-compatibility-runbook.md`](docs/chatgpt-connector-compatibility-runbook.md)：ChatGPT App tool snapshot / binding / release 与恢复 runbook。

`docs/research/**`、旧 spec/plan 与历史 closeout 文档保留当时证据和决策上下文；其中的旧 roadmap、旧工具数量、旧 runtime build 或旧 backlog status 都是历史快照，**不得覆盖上述当前权威入口**。

## 产品边界

GrandeGPT **不是大型软件工程平台**。它不建设多 repo orchestration、Jira/Linear 替代品、企业审批/RBAC/SSO、release train、Kubernetes/DevOps orchestration、observability/incident management、multi-agent organization、plugin marketplace、semantic code graph 或自动 model routing。

它也不是给 ChatGPT 一个 shell。没有 `shell_exec`、`filesystem_raw`、`git_raw`、`github_api_raw`。ChatGPT 只能使用 Gateway 注册的高层语义工具，Gateway 是唯一执行权威。

## 架构一览

```text
ChatGPT
   │  高层语义工具
   ▼
MCP Server   公网 HTTPS · 单一 /mcp · OAuth 2.1 + PKCE
   │  schema 校验与转发
   ▼
Gateway      127.0.0.1 · Policy + 审计 · 唯一执行权威
   ├──► Task / worktree / safe filesystem / Git / GitHub
   ├──► sandbox profile
   ├──► repo process lock / Host Verifier / activation evidence
   └──► 薄 capability adapter（native / MCP / plugin / skill）
```

**Task 始终是核心执行对象。** TaskBrief、CI/merge、Host verification、deployment receipt 与 activation receipt 都是围绕 Task/发布闭环的证据或投影，不升级成第二套 workflow platform。

## 当前能力基线

### Phase 4–5：完整开发闭环与日常使用

- **TaskBrief**：自然语言 / Issue / Markdown / Bug / PR feedback → repo 调研 → plan + acceptance criteria → Task。
- **Capability**：`list / inspect / invoke`，production/destructive 继续 fail-closed。
- **PR / CI / merge**：ready PR、真实 checks/statuses 与 Actions fallback、exact-head attestation、expected-SHA merge。
- **Project onboarding**：proposal → Human confirmation → apply；repo registration 不接受任意路径或权限扩张。
- **Daily operations**：`status / doctor / gc / selfcheck` 从既有可信状态投影 blocker、nextAction、readiness 与 runtime identity。

### Phase 5.5–6：可靠运行与 Automated Host Verifier

- canonical refresh 只允许 clean + fast-forward；dirty/diverged fail closed。
- production Gateway restart 采用 failure-safe launchd 路径，成功前等待 endpoint readiness。
- exact-SHA Host verification 从手工 receipt 门禁演进到 controlled auto verifier；manual-only 仍保留为受信 Human Gate，而不是通用 host shell。
- verifier 具备最小可信可观察性、`candidate / infrastructure / integrity` failure taxonomy、bounded infra retry 与 Human escalation。
- ChatGPT App/session binding drift (`GG-BL-010`) 与 verifier execution plane 明确分离；不得通过降低 annotations、绕过 Gateway 或频繁改变 tool snapshot 来“修”。

### Phase 7：Reliability Foundation（已关闭）

- **GG-BL-007 · SQLite migration / backup / restore**：显式有序 schema migration；迁移前 verified backup；失败 rollback；managed restore；普通 backup 不包含 `secrets/`。
- **GG-BL-017 · cross-process repo write lock**：Gateway 与会写 Git/worktree 的 CLI 共享 fail-closed per-repo process lock；同 repo 互斥，不同 repo 可并行。
- **GG-BL-018 · independent CI**：GrandeGPT PR 现在有真实 GitHub Actions gate；固定 `macos-15`、Node 24、pnpm 10.33.0、frozen lockfile，运行 selfhost-safe tests、typecheck 与 tool-contract checks。
- **GG-BL-019 · durable production activation receipt**：activation evidence 绑定 target/runtime build、toolset identity、activation time、LaunchAgent/endpoint readiness 与 trusted read probe，并可在后续会话读回。

Phase 7 implementation PR #22 最终 exact head `bb9091d96ea6b0cf2197c473e0556e53cbcc68aa`：local `unit-selfhost` **109 files / 859 tests PASS**、`typecheck` PASS、GitHub Actions PASS、Host outer-test **10 files / 171 tests PASS**。implementation merge SHA：`aec10bbdd8ce01ef7cfc1eada18cb52d692bb162`。项目管理 closeout PR #23 已 merge，canonical 随后推进到 `f796b47dcaa6649b4ae9869e35cea07466ceaf09`。

### Phase 8：Flow Simplification（已关闭）

- **delivery-target projection**：新增内部 `local | pr | deploy` domain primitive 与 TaskProgress projection，只显示当前目标必要阶段；Phase 8 不新增公开 `TaskBrief.deliveryTarget` schema，该公开 contract 留给 Phase 9。
- **bounded run**：`grande_run` 最多等待固定短预算，短 job 一次调用可返回 terminal result；长 job 保留稳定 `jobId + grande_run_result` 恢复语义。
- **PR continuation**：正常路径可直接进入 `grande_pr_merge`，`grande_pr_status` 只在真实 blocker 需要诊断时展开；verifier/runner 仍无 merge 权限，每次 merge 重读 exact-SHA gates。
- **L1/L2/L3**：正式风险分级，未知路径 fail closed 到 L3；普通文档/常规修改不再机械承担 L3 ceremony。

Phase 8 implementation PR #25 exact head `e902877854e2513cfa1d6545ffb15b22cc8410f9`：`unit-selfhost` **112 files / 871 tests PASS**、`typecheck` PASS、GitHub Actions PASS、manual-only Host outer-test **10 files / 172 tests PASS**。canonical merge SHA：`217a2dadc2887046decdeb9ab3c2813060ae7d97`。production activation receipt 已由后续 Gateway 状态读回，且公开 tool identity 未变化。

## 当前公开工具面

当前 production contract：

- **25 MCP tools**
- `toolsetEpoch=2`
- `toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`

相对早期 epoch 1 / 23-tool contract，正式 onboarding release 新增 `grande_repo_add_propose` 与 `grande_repo_add_apply`。Phase 7 与 Phase 8 都没有新增、删除或重命名公开工具，也没有 bump epoch。

下一次计划中的公开 tool surface 收敛属于 Phase 9 / `GG-BL-024`。Phase 9 必须先满足 `GG-BL-010` release-ready gate，然后在一次正式 Tool Epoch 中完成，不零散改 tools/list。

开发期 schema 先在 GrandeGPT Dev 收敛；正式 tool-contract release 才刷新 Production App。出现 `Resource not found` / `tool disabled` 时，不允许绕过 Gateway 或降低安全注解；保留 Task，按 compatibility runbook Refresh/Reconnect，并在新聊天先执行 `grande_task_status` read probe。

## 当前 production Gateway

production Gateway 通过 macOS 用户级 LaunchAgent 常驻：

- label：`ai.agentjoey.grande-gateway`
- listener：`127.0.0.1:8787`
- public MCP：`https://grande.agentjoey.ai/mcp`
- issuer：`https://grande.agentjoey.ai`

常用入口：

```bash
node --disable-warning=ExperimentalWarning src/cli.ts gateway status
node --disable-warning=ExperimentalWarning src/cli.ts gateway restart
node --disable-warning=ExperimentalWarning src/cli.ts gateway stop
node --disable-warning=ExperimentalWarning src/cli.ts gateway start
```

安装/更新 LaunchAgent：

```bash
GRANDE_WORKSPACE=/absolute/path/to/GPT_Workspace \
GRANDE_ISSUER=https://grande.agentjoey.ai \
node --disable-warning=ExperimentalWarning src/cli.ts gateway install
```

`gatewayBuild` 默认来自运行 checkout 的精确 Git HEAD；它与 `toolsetEpoch` 独立。普通实现或文档 commit 会改变 Git HEAD，但只要 tool contract 不变，就不 bump epoch/digest，也不需要 Refresh Production App。

Phase 8 production activation 的已读回 receipt 证明：

```text
targetBuild = runtimeBuild = git:217a2dadc2887046decdeb9ab3c2813060ae7d97
toolsetEpoch = 2
toolsCount = 25
toolsDigest = sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815
LaunchAgent running = true
endpointReady = true
trusted read probe = HTTP 200
```

后续 docs-only canonical commit 不代表 production runtime 必须重启；production activation evidence 只在真正执行 activation 时更新。

## 常用本机入口

```bash
# 新 repo：先 proposal，Human 明确确认后才 apply
node --disable-warning=ExperimentalWarning src/cli.ts repo add my-repo
node --disable-warning=ExperimentalWarning src/cli.ts repo add my-repo --apply

# readiness
GRANDE_ISSUER=https://grande.agentjoey.ai \
node --disable-warning=ExperimentalWarning src/cli.ts doctor --repo my-repo

# 日常任务 / blocker / cleanup
node --disable-warning=ExperimentalWarning src/cli.ts status

# 显式 GC reconciliation
node --disable-warning=ExperimentalWarning src/cli.ts gc

# 自举 host boundary
node --disable-warning=ExperimentalWarning src/cli.ts outer-test --task <taskId> --run
```

如果 repo 没有 `.grande/deploy.yaml`，GrandeGPT 不会为了让 readiness “变绿”而生成通用部署体系。没有真实项目需要的 MCP/plugin/skill provider 时，也不会为了覆盖类型虚构 capability 集成。

## 验证纪律

GrandeGPT 自举开发按风险分级：

1. **L1**：文档/非运行资源，使用轻量 TaskBrief 与基础一致性检查；不要求独立 spec/plan/reviewer/Host verifier。
2. **L2**：常规业务源码/bug，要求简短 TaskBrief、行为测试和有界 ordinary review；Host verification 按现有 classifier 走 none/smoke。
3. **L3**：sandbox/auth/runner/verifier/merge/deploy/tool-contract 等核心边界，要求完整设计/计划、独立 reviewer 与 full Host gates；无法分类时默认 L3。
4. 所有需要 merge 的 PR 仍要求 exact-head attestation 与真实 independent GitHub CI；Host receipt 必须绑定 exact SHA。
5. 需要 production activation 的变更必须记录 durable activation receipt，并从后续状态读取验证。

Phase 8 最终 implementation 证据：`unit-selfhost` **112 files / 871 tests PASS**、`typecheck` PASS、GitHub CI PASS、Host **10 files / 172 tests PASS**、production activation readback PASS。

## 目录约定

```text
GPT_Workspace/                    ← 可注册代码工作区根
├── grande-gpt/                   ← 本项目 canonical checkout
├── <other-project>/              ← 其他项目，平级
└── .grande-work/                 ← 派生 worktrees / fixtures / tmp

~/.grande-control/                ← 可信控制平面，沙箱不可见
└── state/ · config/ · artifacts/ · checkpoints/ · backups/ · secrets/ · skills/ · logs/
```

控制平面状态刻意放在工作区之外：**被审计者不能拥有审计记录或凭据的写权限。** `secrets/` 不进入普通 state backup。

## 下一阶段：Phase 9 — Tool Surface Convergence

Phase 9 范围以 [`docs/BACKLOG.md`](docs/BACKLOG.md) 的 `GG-BL-024` 为准。它负责一次正式 Tool Epoch 中的公开 MCP surface 收敛，包括把 Phase 8 已验证的内部 delivery-target 语义正式纳入公开 TaskBrief contract。

计划目标包括：

- `grande_repo_add_propose + grande_repo_add_apply` 收敛为单一 `grande_repo_register`，但继续保留 proposalDigest + Human Gate 语义；
- capability inspect 合入 list filter；
- deploy verify 合入可重入 deploy；
- 正常完成路径将公开 `grande_task_close` 内部化；
- public `TaskBrief.deliveryTarget` 与新的 tool identity 在同一个 epoch 一次发布，不长期保留新旧 alias。

**当前尚未满足 Phase 9 release gate。** `GG-BL-010` 仍为 P0 / MITIGATED；在其达到 backlog 定义的 release-ready 稳定门槛前，production 25-tool contract 继续冻结。

## 历史文档

历史 spec/plan/research 用于回答“当时为什么这样设计/发生了什么”，不维护当前状态。几个主要入口：

| 文档 | 内容 |
|---|---|
| [S0 设计规格](docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md) | 初始架构、风险与早期路线图 |
| [Phase 4 spec](docs/superpowers/specs/2026-08-18-grande-gpt-phase4.md) | S4–S7 的历史阶段规格 |
| [Phase 4 closeout](docs/research/2026-08-18-phase4-closeout.md) | Phase 4 当时的 23-tool 验收快照 |
| [Phase 6 closeout](docs/research/2026-08-22-phase6-post-activation-hardening-closeout.md) | Automated Host Verifier activation 后的 hardening 证据 |
| [Phase 7 plan](docs/superpowers/plans/2026-08-22-grande-gpt-phase7-reliability-foundation.md) | Reliability Foundation 实施与最终 closeout 证据 |
| [Phase 8 closeout](docs/research/2026-08-23-phase8-flow-simplification-closeout.md) | Flow Simplification implementation、dogfood、Host/CI 与 production activation 证据 |

当前项目状态请回到 [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md)；当前 backlog/roadmap 请回到 [`docs/BACKLOG.md`](docs/BACKLOG.md)。
