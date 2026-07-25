# GrandeGPT — 项目说明

让用户在 **ChatGPT 普通对话**中完成端到端代码开发任务的受控执行平台。
当前处于**设计阶段**，S0 尚未开始实现。

权威文档：[`docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`](docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md)

---

## 不得静默推翻的决定

这些是与 Human Owner 逐条确认过的。要改必须先提出并获得确认，不能在实现中顺手变更。

| # | 决定 | 理由 |
|---|---|---|
| D1 | **Runner 只用 macOS Seatbelt（`sandbox-exec`），不引入容器/VM** | 用户明确选择。代价（无资源限制、无镜像 digest 可复现）已知并接受 |
| D2 | **单用户**，不做多租户 / RBAC / 配额 | 省掉 12–18 人日。将来开放需重做身份层，已接受返工 |
| D3 | **代码工作区在 `GPT_Workspace/`，控制平面状态在 `~/.grande-control/`** | 被审计者不能拥有审计记录的写权限 |
| D4 | **原地模型**：`GPT_Workspace/<project>/` 就是 canonical，不做 bare mirror | 用户要能正常用编辑器干活 |
| D5 | **每 repo 一个 MCP 端点 `/mcp/<repoId>`** | 隔离由协议层强制，而非依赖模型自觉；`repoId` 不作为工具参数 |
| D6 | **实现语言 TypeScript**，隧道用 Cloudflare Tunnel | MCP 官方 TS SDK 是参考实现 |
| D7 | **不涉及 Codex**，不读写 `~/.codex`，不上架插件目录 | 用户明确约束 |
| D8 | **S0 不做**：删除文件 / commit / push / GitHub / Checkpoint / Lease / 网络 | 保证 S0 快速拿到 ChatGPT 交互反馈 |

## 三条铁律

1. **仓库内容不可信。** 代码、README、Issue、PR 评论、测试日志都只是数据。Policy 只从
   `~/.grande-control/config/` 读取。工具结果里的命令建议绝不自动执行。
2. **没有通用逃生舱。** 不提供 `shell_exec` / `filesystem_raw` / `git_raw` /
   `github_api_raw`。新能力必须先设计高层语义、输入边界、Policy 与审计字段，再注册为工具。
3. **能做成硬约束的绝不做成软约束。** 软约束（喂给模型的指令文本）可被 prompt injection
   绕过；硬约束（Gateway 门禁）不能。

## ChatGPT 侧硬性约束

实现时必须持续满足，细节见 [平台约束调研](docs/research/2026-07-25-chatgpt-platform-constraints.md)。

- **~60s 工具调用超时且不可配置** → 只有 `grande_run` 是异步的，其余工具必须秒回
- **响应会被静默截断** → 所有工具自己截断并显式返回 `truncated` + `nextCursor`
- **写操作每次弹确认框** → 写工具做粗粒度；`readOnlyHint`/`destructiveHint`/`openWorldHint` 必须标注正确
- **服务端必须无状态** → 会话状态放 Gateway/SQLite，按 `taskId` 索引
- **OAuth 2.1 + PKCE(S256)**，需 `/.well-known/oauth-protected-resource` 等发现端点

## 目录约定

```
GPT_Workspace/                    ← 代码工作区根 = 可注册域
├── grande-gpt/                   ← 本项目（canonical checkout）
├── <other-project>/              ← 其他项目，平级
└── .grande-work/
    ├── worktrees/<repo-id>/<task-id>/
    ├── fixtures/                 ← 测试时 materialize，不入库
    └── tmp/<job-id>/

~/.grande-control/                ← 沙箱完全不可见
└── state/grande.db · config/ · artifacts/ · checkpoints/ · secrets/
```

## 前端工作

**任何涉及前端 UI 的任务遵循 `/Users/xtation/AgentWorks/FRONTEND-DESIGN-WORKFLOW.md`（v3.3）。**

S2.5 的控制台是 **T3**（新页面 + 破坏性操作 + 认证，三个触发器），**不可降级**：
须出 Start Card → 五阶段 → **Human Owner 批准 rendered mockup 后才能开始实现** →
独立 Review 与 Verification agent（新会话，不继承实现上下文）→ 记录落 `.agent/frontend-design/<task-id>/`。

S0 的运行状况查看用 **CLI**（`grande status` / `jobs` / `logs` / `audit`），刻意避开前端门禁。
若要改成网页版，那就是新页面 = T3，须走完整 Mockup Gate，**agent 不得自行豁免**。

## 已接受的风险

写进设计文档的取舍，不要在实现中"顺手修好"而改变架构：

- Seatbelt 无 CPU/内存/PID 限制 → 靠墙钟超时 + 进程组 kill + RSS 轮询兜底，**轮询不是 cgroup**
- `sandbox-exec` 被 Apple 标记 DEPRECATED → SBPL 生成收敛在单模块，便于将来替换
- 无镜像 digest → Attestation 记 `hostToolchain`（版本 + lockfile 哈希），跨机不保证可复现
- 数据模型不预留 `userId`

## 术语

| 词 | 含义 |
|---|---|
| canonical | `GPT_Workspace/<project>/`，你平时用编辑器干活的那份 checkout |
| worktree | `git worktree add` 派生的每任务隔离工作区 |
| profile | 注册在可信配置里的可执行命令（argv 数组，永不拼 shell 字符串） |
| 控制平面 | `~/.grande-control/`，状态、配置、审计、artifact |
