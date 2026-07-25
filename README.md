# GrandeGPT

在 **ChatGPT 普通对话**中完成端到端代码开发任务的受控执行平台。

ChatGPT 负责理解目标和组织步骤；Gateway 负责授权与执行；Git worktree 隔离任务；
macOS Seatbelt 沙箱执行测试；Git 与 GitHub 提供版本、协作与最终保护。

> **状态**：设计完成，待 POC 验证。
> POC 是 S0 的**前置门禁** —— 1–2 人日验证 GPT-5.6 在 chat 模式下能否撑住这种交互
> （尤其**能否自主轮询**）。未通过则暂停项目并重新设计交互模型。
> 方向层面的风险与质疑见规格 [§13](docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md)。

## 它不是什么

不是让 ChatGPT 拿到一个 shell。没有 `shell_exec`、`filesystem_raw`、`git_raw`、
`github_api_raw`。ChatGPT 只能看到 Gateway 注册的高层语义工具，Gateway 是唯一执行权威。

## 架构一览

```
ChatGPT (chat 模式)
   │  只能看到 Gateway 注册的工具
   ▼
MCP Server   公网 HTTPS · /mcp/<repoId> · streamable HTTP · OAuth 2.1 + PKCE
   │  只做 schema 校验与转发，不碰文件系统
   ▼
Gateway      127.0.0.1 · 唯一执行权威 · Policy + 审计
   ├──► 文件 / Git 操作 —— Gateway 进程直接执行（受信代码）
   └──► run_profile     —— sandbox-exec 子进程（不受信代码）
```

## 目录约定

```
GPT_Workspace/                    ← 代码工作区根 = 可注册域
├── grande-gpt/                   ← 本项目，普通 checkout，canonical
├── <other-project>/              ← 其他项目，平级
└── .grande-work/                 ← 派生数据（worktrees / fixtures / tmp）

~/.grande-control/                ← 控制平面（沙箱完全不可见）
└── state/ · config/ · artifacts/ · checkpoints/ · secrets/
```

控制平面状态刻意放在工作区之外：**被审计者不能拥有审计记录的写权限。**

## 文档

| 文档 | 内容 |
|---|---|
| [S0 设计规格](docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md) | 完整设计、决策与取舍、验收标准、路线图 |
| [ChatGPT 平台约束调研](docs/research/2026-07-25-chatgpt-platform-constraints.md) | 官方能力边界与硬性限制（含来源） |

## 路线图

| 切片 | 内容 | 粗估（人日） |
|---|---|---|
| **POC** | **交互可行性验证：假 MCP 服务端 + 硬编码数据。未通过不启动 S0** | **1–2** |
| **S0** | 薄端到端：九工具 + Seatbelt + `/mcp/<repoId>` + CLI 调试视图 | 13–19 |
| S1 | 安全写入层：OID 校验、事务 patch、Checkpoint、Trash | 8–11 |
| S1.5 | 开发约束层：硬 policy 门禁 + 软方法论指引 | 3–4 |
| S2 | 本地开发闭环：worktree 生命周期、commit、base sync、Attestation | 11–15 |
| S2.5 | 前端控制台（T3，须过 Mockup Gate） | 10–15 |
| S3 | GitHub 闭环：GitHub App、push、Draft PR、CI | 6–9 |
| S4 | 稳固化：审计对账、僵尸恢复、保留策略 | 4–7 |
| S5 | 外部校验器接入（按需评估，很可能不做） | 0–5 |

## 设计来源

- 用户提供的 `Chat-Dev-Control-Plane-方案B-设计文档.docx`（v0.9 设计整理稿）
- 参考项目 NAS AI Ops 的双层控制思路：MCP 只发布工具，Gateway 才是执行权威
