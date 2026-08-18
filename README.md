# GrandeGPT

在 **ChatGPT 普通对话**中完成端到端代码开发任务的受控执行层，定位于个人开发者、小团队和中小型/轻量项目。

ChatGPT 负责理解需求、调研仓库和组织步骤；Gateway 负责授权与执行；Git worktree 隔离任务；
macOS Seatbelt 沙箱执行受控 profile；Git/GitHub 与项目已有部署机制完成代码上线闭环。

> **当前状态（2026-08-18）**：S0 → S3 与 Phase 4（S4–S7）均已完成并合并到 `main`，完整开发闭环已通过真实 GitHub 与 production Gateway 实机验收。
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
`state=running`。

## 历史文档

以下文档保留历史决策上下文；其中早期 roadmap、工具数量和 PR 策略可能已被 Phase 4 取代。

| 文档 | 内容 |
|---|---|
| [S0 设计规格](docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md) | 初始架构、风险与早期路线图（历史决策上下文，不再代表当前 roadmap） |
| [S1 设计](docs/superpowers/specs/2026-07-29-grande-gpt-s1-design.md) | Safe filesystem / checkpoint / trash / rollback / policy |
| [S2 设计](docs/superpowers/specs/2026-07-30-grande-gpt-s2-design.md) | Local development loop |
| [S3 设计](docs/superpowers/specs/2026-07-30-grande-gpt-s3-design.md) | GitHub push / PR 的历史切片设计；Phase 4 已将新 PR 从 Draft 改为 ready，以移除人工闭环断点 |
