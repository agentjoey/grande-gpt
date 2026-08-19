# GrandeGPT

在 **ChatGPT 普通对话**中完成端到端代码开发任务的受控执行层，定位于个人开发者、小团队和中小型/轻量项目。

ChatGPT 负责理解需求、调研仓库和组织步骤；Gateway 负责授权与执行；Git worktree 隔离任务；
macOS Seatbelt 沙箱执行受控 profile；Git/GitHub 与项目已有部署机制完成代码上线闭环。

> **当前状态（2026-08-18）**：S0 → S3、Phase 4（S4–S7）与 Phase 5（S8–S10）均已完成，完整开发闭环已通过真实 GitHub / production Gateway 与轻量项目 dogfood 验收。
> 当前 Golden Path：`Request → inspect → plan → code → test → commit → push → PR → CI → merge → deploy → verify → DONE`。
> Bug / 新需求不会进入另一套维护平台，而是创建新 Task，再次走同一条闭环。

## 产品边界

GrandeGPT **不是大型软件工程平台**。它不建设多 repo orchestration、Jira/Linear 替代品、
企业审批/RBAC/SSO、release train、Kubernetes/DevOps orchestration、observability/incident
management、multi-agent organization、plugin marketplace、semantic code graph 或自动 model routing。

它也不是给 ChatGPT 一个 shell。没有 `shell_exec`、`filesystem_raw`、`git_raw`、
`github_api_raw`。ChatGPT 只能使用 Gateway 注册的高层语义工具，Gateway 是唯一执行权威。

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
   └──► 薄 capability adapter（native / MCP / plugin / skill）
```

**Task 始终是核心执行对象。** S4 的 plan/acceptance criteria 只是 TaskBrief；S6 的 CI/merge
和 S7 的 deployment receipt 都不会升级成独立 workflow platform。

## Phase 4 能力

| 切片 | 最小能力 |
|---|---|
| **S4** | 自然语言 / Issue / Markdown / Bug / PR feedback → repo 调研 → TaskBrief（plan + acceptance criteria）→ 现有 Task 开发循环 |
| **S5** | capability `list / inspect / invoke`；native 复用现有工具；MCP/plugin 复用标准 tools；skill 激活控制平面可信指令；production/destructive fail-closed |
| **S6** | ready PR → 当前 head 的 checks/statuses → 失败诊断 → 修复/重新 push → CI green/none + 当前 SHA attestation → expected-SHA merge；Checks 403 时按当前 SHA 回退 Actions |
| **S7** | merge 后读取 repo 的 `.grande/deploy.yaml`，调用已批准 profile 或 S5 capability → verify → DONE；rollback 只调用项目/平台已经声明的机制 |

Phase 4 最终为 **23 tools：9 read-only / 14 write**。配置、运行约定和门禁见
[`docs/superpowers/specs/2026-08-18-grande-gpt-phase4.md`](docs/superpowers/specs/2026-08-18-grande-gpt-phase4.md)；
最终收口与 production 验证证据见
[`docs/research/2026-08-18-phase4-closeout.md`](docs/research/2026-08-18-phase4-closeout.md)。

## Phase 5：可靠接入与日常使用

Phase 5 不增加新的生命周期平台，重点是把 Phase 4 Golden Path 在真实轻量项目里用顺。

- **S8 · Real-world Loop Hardening**：Checks API 403 回退 GitHub Actions 时，失败 workflow 可继续下钻到有限数量的 failed job / failed step，并只读取 bounded log excerpt；signed log URL 不携带 GitHub PAT。诊断增强失败会退回 workflow-level failure，不会把已知失败误报成 CI=none。
- **S9 · Project Onboarding**：`grande repo add <repoId>` 默认只生成 proposal，并检查候选是否是安全的 workspace direct child、具有有效 HEAD、且 canonical 非 detached / merge / rebase / cherry-pick / index.lock，真正具备 worktree lifecycle readiness；只有 Human Owner 显式加 `--apply` 且 readiness 仍通过时，才把 registration 与缺失的常用 run profiles 写入可信控制平面。repo 内容不能借 onboarding 扩大执行权限。ChatGPT 路径复用同一套 S9 primitive：`grande_repo_add_propose` 只读生成 proposal + digest，Human Owner 明确确认后才调用 `grande_repo_add_apply`；apply 会重新检查 readiness 与 trusted control-plane pre-state，stale/blocked 时零写入。CLI 保留为 fallback。
- **S9 · Readiness Doctor**：`grande doctor --repo <repoId>` 按 `Development / PR/CI / Deploy / Gateway` 展示 Golden Path readiness，并实际 probe GitHub credential/access 与 Gateway tools/list，而不是只看配置文件是否存在。
- **S10 · Daily Operations**：`grande status` 与 `grande_task_status` 从既有 Task / jobs / attestation / PR audit / deployment receipt 投影 `Code / Tests / PR / CI / Merged / Deploy / Verify`，显示 blocker、下一步和 completed-but-not-cleaned-up。不会因此新增十几个持久状态，也不会自动 destructive close。

常用本机入口：

```bash
# 新 repo：先看 proposal；确认后才写可信控制平面
node --disable-warning=ExperimentalWarning src/cli.ts repo add my-repo
node --disable-warning=ExperimentalWarning src/cli.ts repo add my-repo --apply

# 单 repo Golden Path readiness
GRANDE_ISSUER=https://grande.agentjoey.ai \
node --disable-warning=ExperimentalWarning src/cli.ts doctor --repo my-repo

# 日常任务 / blocker / cleanup 视图
node --disable-warning=ExperimentalWarning src/cli.ts status

# stale worktree/task 仍由现有 GC 显式对账；不会自动 destructive close
node --disable-warning=ExperimentalWarning src/cli.ts gc
```

如果 repo 没有 `.grande/deploy.yaml`，Doctor 会明确显示 `Deploy ✗`；GrandeGPT 不会为了让 readiness 变绿而生成通用部署体系。没有真实项目需要的 MCP/plugin/skill provider 时，也不会为了“覆盖类型”虚构 capability 集成。

## ChatGPT App 稳定性与发布分层

ChatGPT App 采用明确的开发/生产分离，避免开发期频繁 schema 变化污染稳定会话：

- **GrandeGPT Dev**：只用于开发和验证新的 tool contract，指向 development/staging Gateway。开发期间可以频繁修改 schema、Scan/Refresh Tools，并始终用新聊天验证 binding。
- **GrandeGPT Production App**：只指向稳定 production Gateway。普通实现 patch 不 Refresh App；只有正式 **tool-contract release** 才更新 Production App 的 tools snapshot。

GrandeGPT 对 server toolset 使用四个兼容性字段：`gatewayBuild / toolsetEpoch / toolsCount / toolsDigest`。
`toolsDigest` 只覆盖稳定排序后的 tool name、input schema 与 annotations；`toolsetEpoch` 也只在这三类 contract 真正改变时 bump。实现代码、日志、CLI 文本等 patch 即使产生新的 `gatewayBuild`，只要 tool contract 未变，就保持同一 epoch/digest，**不 Refresh App**。

当前 onboarding MCP 是一次正式 tool-contract release：**25 tools**，`toolsetEpoch=2`。相对 epoch 1 / 23-tool contract 只新增 `grande_repo_add_propose` 与 `grande_repo_add_apply` 两只本地工具；open-world 与 destructive 高风险名单不扩张。部署该 release 后必须 Scan/Refresh Tools，并在**新聊天**先执行 `grande_task_status` read probe，确认 server-side `toolsetEpoch=2 / toolsCount=25 / toolsDigest` 与 App snapshot 对齐后，再调用新的 apply 写工具。

开发期的新 schema 先在 GrandeGPT Dev 收敛；正式发布时才 bump epoch、部署 production、Scan/Refresh Tools，并在**新聊天**先执行 `grande_task_status` read probe。出现 `Resource not found` / `tool disabled` 时，不允许绕过 Gateway 或降低安全注解来恢复调用；保留 task，Refresh/Reconnect 后在新聊天 resume。

完整诊断、release 与恢复步骤见 [`docs/chatgpt-connector-compatibility-runbook.md`](docs/chatgpt-connector-compatibility-runbook.md)。

## Production Gateway

production Gateway 通过 macOS 用户级 LaunchAgent 常驻：登录后自动启动，异常退出由 `launchd` 拉起，
仍只监听 `127.0.0.1:8787`，由现有 Cloudflare Tunnel 暴露 `https://grande.agentjoey.ai/mcp`。

```bash
# 状态 / 重启 / 停止 / 启动
node --disable-warning=ExperimentalWarning src/cli.ts gateway status
node --disable-warning=ExperimentalWarning src/cli.ts gateway restart
node --disable-warning=ExperimentalWarning src/cli.ts gateway stop
node --disable-warning=ExperimentalWarning src/cli.ts gateway start
```

安装/更新 LaunchAgent 时需要显式提供 production 环境：

```bash
GRANDE_WORKSPACE=/absolute/path/to/GPT_Workspace \
GRANDE_ISSUER=https://grande.agentjoey.ai \
node --disable-warning=ExperimentalWarning src/cli.ts gateway install
```

Gateway build identity 默认来自运行 checkout 的精确 Git HEAD（`git:<40-char HEAD>`）；正式 release 系统也可以通过 `GRANDE_GATEWAY_BUILD` 显式覆盖。这个 build identity 与 `toolsetEpoch` 独立，Gateway restart 后会重新识别当前运行 checkout。

## 目录约定

```text
GPT_Workspace/                    ← 代码工作区根 = 可注册域
├── grande-gpt/                   ← 本项目，普通 checkout，canonical
├── <other-project>/              ← 其他项目，平级
└── .grande-work/                 ← 派生数据（worktrees / fixtures / tmp）

~/.grande-control/                ← 控制平面（沙箱完全不可见）
└── state/ · config/ · artifacts/ · checkpoints/ · secrets/ · skills/ · logs/
```

控制平面状态刻意放在工作区之外：**被审计者不能拥有审计记录或凭据的写权限。**

## 验证纪律

自举开发使用 `unit-selfhost + typecheck`。`unit-selfhost` 刻意排除自身需要再起沙箱或绑定真实端口的
外层测试；合并自举产出前仍必须在宿主执行 `grande outer-test --run`，不能把 selfhost 的绿灯误当成
全部安全不变量已经覆盖。

Phase 4 最终 closeout 的已记录验证为：`unit-selfhost` **53 files / 566 tests**、`typecheck` 通过、
host `outer-test` **5 files / 132 tests**、production `selfcheck` **HTTP 200 / 23 tools**、LaunchAgent
`state=running`。Phase 5 的分支验收继续沿用同一纪律；最终结果以该 Phase 的 merge/production closeout 为准。

## 历史文档

以下文档保留历史决策上下文；其中早期 roadmap、工具数量和 PR 策略可能已被 Phase 4 取代。

| 文档 | 内容 |
|---|---|
| [S0 设计规格](docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md) | 初始架构、风险与早期路线图（历史决策上下文，不再代表当前 roadmap） |
| [S1 设计](docs/superpowers/specs/2026-07-29-grande-gpt-s1-design.md) | Safe filesystem / checkpoint / trash / rollback / policy |
| [S2 设计](docs/superpowers/specs/2026-07-30-grande-gpt-s2-design.md) | Local development loop |
| [S3 设计](docs/superpowers/specs/2026-07-30-grande-gpt-s3-design.md) | GitHub push / PR 的历史切片设计；Phase 4 已将新 PR 从 Draft 改为 ready，以移除人工闭环断点 |
