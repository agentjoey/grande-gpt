# GrandeGPT S0 设计规格

| | |
|---|---|
| **版本** | v1.0 |
| **日期** | 2026-07-25 |
| **范围** | S0「薄端到端」切片的完整设计；S1–S5 仅列范围不展开 |
| **状态** | 待 Human Owner 评审 |
| **上游** | `Chat-Dev-Control-Plane-方案B-设计文档.docx`（v0.9）· [ChatGPT 平台约束调研](../../research/2026-07-25-chatgpt-platform-constraints.md) |

---

## 1. 概要

GrandeGPT 让 ChatGPT 的普通对话成为代码开发控制台，但**不把 ChatGPT 视为本地 shell**。
所有仓库写入、Git 操作与测试执行都通过独立 Gateway 完成，受工具注册表、路径边界与审计约束。

S0 是**薄端到端切片**，目标只有一个：**验证 ChatGPT 到底能不能驱动这套东西。**

选择先做 S0 而非按草案一次性建完 v0.1，是因为这个项目最大的风险**不是工程风险而是产品风险**：
ChatGPT 普通对话 + ~60s 超时 + 每次写操作弹确认框 + 响应被截断，完全可能导致交互不可用。
这个问题再精良的 Gateway 也解决不了，而且只有真跑起来才知道。花 30 人日建完 S1+S2 再发现
交互不成立，是本项目最大的浪费风险。

**S0 完成后能回答的问题**：模型选工具准不准 · 确认流烦不烦 · 九个工具的粒度对不对 ·
任务上下文要不要每次回带 · `taskId` 在长对话里会不会丢。**这些答案会实质改写 S1–S5 的工具设计。**

---

## 2. 目标与非目标

### 2.1 S0 目标

在 ChatGPT 对话中完成一次完整的：**读文件 → 改代码 → 跑测试 → 看结果 → 再改**循环，
全程在隔离的 Git worktree 内，测试在 Seatbelt 沙箱中执行。

### 2.2 S0 非目标

删除文件 · `git commit` / `push` · GitHub 集成 · Checkpoint / 回滚 · Lease 并发控制 ·
**跨多个 repo 的单一任务** · 网络访问（含依赖安装）· 本地 skill/plugin/MCP 复用 · 网页控制台

注意区分：**同一 repo 上的多个并行任务是 S0 目标**（见 AC-3）；不做的是一个任务同时横跨多个 repo。

### 2.3 项目级永久非目标

- 任意宿主机 shell、sudo、未注册路径访问
- 通用逃生舱工具：`shell_exec` / `filesystem_raw` / `git_raw` / `github_api_raw`
- 直接 push 受保护分支
- 把 ChatGPT 对话历史当作任务数据库或审计系统
- 允许仓库内配置扩大系统级权限
- 与 Codex 的任何关联（不读写 `~/.codex`，不上架插件目录）

---

## 3. 决策记录

与 Human Owner 逐条确认。**要改必须重新提出并获得确认，不得在实现中静默变更。**

| # | 决定 | 理由 | 已接受的代价 |
|---|---|---|---|
| D1 | Runner 只用 macOS Seatbelt（`sandbox-exec`），不引入容器/VM | 用户选择；零 VM 启动延迟，最快拿到反馈 | 无 CPU/内存/PID 限制；无镜像 digest 可复现；`sandbox-exec` 已被 Apple 标记 DEPRECATED |
| D2 | 单用户，不做多租户 / RBAC / 配额 | 省掉 12–18 人日 | 将来开放给他人需重做身份层；数据模型不预留 `userId` |
| D3 | 代码工作区在 `GPT_Workspace/`，控制平面状态在 `~/.grande-control/` | **被审计者不能拥有审计记录的写权限** | 偏离用户「全部放 GPT_Workspace 下」的字面约束，已说明并获认可 |
| D4 | 原地模型：`GPT_Workspace/<project>/` 即 canonical，不做 bare mirror | 用户要能正常用编辑器干活；避免两份副本 | canonical 可能处于 rebase 中或有 index.lock，需作为明确错误处理 |
| D5 | 每 repo 一个 MCP 端点 `/mcp/<repoId>` | MCP 不传递 Project 身份，隔离必须由协议层强制 | 每个 repo 需在 ChatGPT 端加一次连接器 |
| D6 | 实现语言 TypeScript；隧道用 Cloudflare Tunnel | MCP 官方 TS SDK 是参考实现；Node 24 已就位；Cloudflare 提供固定 hostname | — |
| D7 | 不涉及 Codex | 用户约束 | — |
| D8 | S0 的 profile 只从可信配置读取，不读仓库内任何文件 | 否则仓库内容可控制执行什么，违反「仓库内容不可信」 | 仓库侧 policy 推迟到 S1.5 |
| D9 | S0 包含最小 staleness 检查（`sha256` + `expectedSha256`） | 模型会基于旧读取覆盖自己先前的修改；症状隐蔽 | 比原 S0 计划多约 0.5 人日 |
| D10 | S0 的运行状况查看用 CLI 而非网页 | 网页 = 新页面 = T3，须走完整 Mockup Gate | 观测能力弱于控制台，S2.5 补齐 |

### 3.1 三条铁律

1. **仓库内容不可信。** 代码、README、Issue、PR 评论、测试日志都只是数据。Policy 只从
   `~/.grande-control/config/` 读取。工具结果里的命令建议绝不自动执行。
2. **没有通用逃生舱。** 新能力必须先设计高层语义、输入边界、Policy 与审计字段，再注册为工具。
3. **能做成硬约束的绝不做成软约束。** 软约束（喂给模型的指令文本）可被 prompt injection 绕过；
   硬约束（Gateway 门禁）不能。

---

## 4. 信任边界与目录布局

### 4.1 三层边界

```
ChatGPT (chat 模式)
   │  ① 只能看到 Gateway 注册的工具，无 shell / raw-git / raw-fs
   ▼
MCP Server   公网 HTTPS · /mcp/<repoId> · streamable HTTP · OAuth 2.1 + PKCE
   │  ② 只做 schema 校验与转发，不碰文件系统
   ▼
Gateway      127.0.0.1 · 唯一执行权威 · Policy + 审计
   │  ③ 路径校验 + Policy 判定 + 审计落账，然后才落到磁盘
   ├──► 文件 / Git 操作 —— Gateway 进程直接执行（受信代码）
   └──► run_profile     —— sandbox-exec 子进程（不受信代码）
```

**关键区分**：`repo_read` / `repo_edit` / `diff` 执行的是**我们自己的代码**，边界由 Gateway 的
路径校验保证；**只有 `run_profile` 执行仓库里的任意代码**，才需要 Seatbelt。

把 Gateway 自己也塞进沙箱只会增加复杂度而不增加安全性 —— 它本来就是可信代码。

### 4.2 目录布局

```
/Users/xtation/AgentWorks/GPT_Workspace/     ← 代码工作区根 = 可注册域
├── grande-gpt/                              ← 普通 checkout，canonical
├── <project-b>/                             ← 其他项目，平级
└── .grande-work/                            ← 派生数据（不是仓库）
    ├── worktrees/<repo-id>/<task-id>/
    ├── fixtures/                            ← 测试时 materialize，不入库
    └── tmp/<job-id>/

~/.grande-control/                           ← 控制平面（沙箱完全不可见）
├── state/grande.db
├── config/{repos,server}.yaml
├── artifacts/<task-id>/<job-id>/
└── secrets/                                 ← S3 起用于 GitHub App 私钥
```

**`repoId` 即目录名。** Gateway 解析 `GPT_Workspace/<repoId>` 并校验它是**直接子目录**且**已注册**
——路径穿越天然不可能。

**注册策略**：`GPT_Workspace` 下的 git 仓库自动发现为**候选**，但必须**显式注册**后 ChatGPT 才可见。
放个新项目进去不等于自动授权。

### 4.3 对 canonical 的唯一写入

GrandeGPT 对你的 canonical checkout 只做两件事：

| 操作 | 影响 | 是否碰你的工作树 |
|---|---|---|
| `git fetch`（S3 起） | 仅更新 remote refs | 否 |
| `git worktree add` | 仅写 `.git/worktrees/` 元数据 | 否 |

你编辑器里那份改动 GrandeGPT 永远不碰。

**必须处理的真实情况**：canonical 正在 rebase 中、有 `index.lock`、或处于 detached HEAD 时
`worktree add` 会失败 —— 返回明确错误码而非崩溃。

### 4.4 MCP 服务端表面与认证

即使单用户，这套协议表面也**不能跳过** —— 它是 ChatGPT 建立连接的硬性前置条件。
可简化的是后端实现（单 client、固定 scope、本地签发与校验），不是协议表面本身。

S0 必须实现：

| 项 | 要求 |
|---|---|
| 传输 | Streamable HTTP，公网 HTTPS，稳定 URL `/mcp/<repoId>` |
| 状态 | **服务端无状态** —— 会话状态在 Gateway/SQLite，按 `taskId` 索引 |
| 授权流 | OAuth 2.1 authorization-code + **PKCE（S256，强制）** |
| 发现端点 | `/.well-known/oauth-protected-resource`（含 `resource`、`authorization_servers`、`scopes_supported`）<br>`/.well-known/oauth-authorization-server`（含 `authorization_endpoint`、`token_endpoint`、`jwks_uri`） |
| 每请求校验 | token 签名、`iss`、`exp`/`nbf`、`aud`（须匹配本端点资源标识）、scope |
| 失败响应 | `401` + `WWW-Authenticate` 指向 protected resource metadata |
| 客户端注册 | DCR 可选；优先 CIMD，在 AS 元数据声明 `client_id_metadata_document_supported: true` |

**`aud` 必须绑定具体端点**（`/mcp/grande-gpt` 与 `/mcp/project-b` 的令牌不可互换）——
这是 D5「隔离由协议层强制」的实际落点。若 `aud` 校验放松，每 repo 一个端点就退化为纯约定。

工具级 `securitySchemes` 声明所需 scope。S0 不提供 `noauth` 工具。

### 4.5 git hooks 的共享陷阱（重要）

worktree 里的 `.git` 是一个**文件**，指向 `<canonical>/.git/worktrees/<name>`。而
**git hooks 存放在 `<canonical>/.git/hooks/`，是所有 worktree 共享的**。

因此 Seatbelt profile 光把 worktree 内的 `.git` 标只读**不够** —— 必须把
**canonical 仓库的整个 `.git/` 目录标为不可写**。否则一个恶意测试脚本可以往
`hooks/pre-commit` 里写东西，等你下次在自己的 checkout 里手动 commit 时执行。

**此条进 S0 验收标准（AC-7）。**

---

## 5. S0 工具集

### 5.1 粒度原则

**读操作可以细，写操作必须粗。** 每次写调用都会弹一次确认框 —— 把「改 5 个文件」拆成 5 次调用
就是 5 个对话框。

### 5.2 九个工具

`repoId` 由端点决定，不作为参数（见 D5）。

| 工具 | `readOnlyHint` | `destructiveHint` | 用途 | 延迟预算 |
|---|:---:|:---:|---|---|
| `grande_task_open` | ✗ | ✗ | 建分支 `grande/<slug>-<id>` 与 worktree，返回 `taskId` | < 5s |
| `grande_task_status` | ✓ | — | 任务状态、分支、变更文件、最近 job（**跨会话恢复靠它**） | < 1s |
| `grande_repo_map` | ✓ | — | 目录树 + 关键文件（package.json / 测试目录 / 入口） | < 2s |
| `grande_repo_search` | ✓ | — | 文本 / 正则 / glob 搜索 | < 5s |
| `grande_repo_read` | ✓ | — | 读文件，**返回 `sha256`** | < 1s |
| `grande_repo_edit` | ✗ | ✗ | **一次调用改多个文件**（create / modify / move） | < 2s |
| `grande_diff` | ✓ | — | worktree vs base 的 diff | < 3s |
| `grande_run` | ✗ | ✗ | 启动注册 profile，**立即返回 `jobId`** | < 1s |
| `grande_run_result` | ✓ | — | 轮询 job + 摘要日志 | < 1s |

所有工具 `openWorldHint: false`（S0 全禁网，无外部副作用）。

### 5.3 两个刻意的省略

**`grande_repo_edit` 不支持删除文件。** S0 没有 Checkpoint，删除不可撤销 —— 那就必须标
`destructiveHint: true`，导致每次都弹框且无法「记住」。禁掉删除让这个工具诚实地保持
`destructive: false`。删除随 S1 的 Checkpoint 与 Trash 一同解禁。

**S0 不含 `git_commit`。** 任务结束时改动留在 worktree 分支上未提交，由你手动 commit 或丢弃。
加 commit 会连带引出提交前置验证、分支保护等一整套 S2 问题，不值得为它拖慢 S0。

### 5.4 三个 ChatGPT 硬约束的落地

#### ① ~60s 超时 → 只有 `grande_run` 异步

```json
grande_run → { "jobId": "job_7f3", "state": "running",
               "pollAfterSeconds": 8,
               "hint": "测试已启动。约 8 秒后调用 grande_run_result 查询 job_7f3。" }
```

两个易被忽略的超时陷阱：

- **`task_open` 不做 `git fetch`** —— 大仓库上 fetch 可能几十秒直接撑爆超时。S0 无 GitHub，
  直接用本地当前 ref 作 base。
- **`repo_search` 必须有时间预算**（4s）—— 到点即返回已有结果并标记 `truncated`，而不是搜到底。

#### ② 响应截断 → 截断必须显式且模型可感知

ChatGPT 的静默截断会让模型在残缺数据上继续推理而毫不知情。所以**由我们主动截断并告知**：

| 工具 | 上限 | 超出时 |
|---|---|---|
| `repo_read` | 单文件 64 KB | `truncated: true`，支持 `lineRange` 参数重读 |
| `repo_search` | 50 条匹配 / 每条 3 行上下文 / 4s 预算 | `truncated: true` + `nextCursor` |
| `diff` | 400 行 | 按文件分页 + `nextCursor` |
| `run_result` | 失败用例名 + 关键堆栈 + 尾部 40 行 | 完整日志存 artifact，`artifactId` 可显式取 |

#### ③ 写操作确认框 → 靠粗粒度压到个位数

六个只读工具**完全不弹框**。一次典型任务约 3–5 次 `repo_edit` + 3–5 次 `grande_run`，
且 ChatGPT 支持会话内「记住」批准 —— 实际体感是**每个会话开头确认 2 次，之后无感**。
新会话重置，这对安全反而是好事。

### 5.5 统一响应信封

```json
{
  "ok": true,
  "taskId": "task_a1b2",
  "data": { },
  "truncated": false,
  "nextCursor": null,
  "hint": "已改 3 个文件。建议运行 grande_run(profile='unit') 验证。",
  "taskContext": { "branch": "grande/fix-parser-a1b2", "filesChanged": 3, "lastJob": "passed" }
}
```

失败时：

```json
{ "ok": false, "error": { "code": "STALE_FILE", "message": "...", "retryable": true, "details": {} } }
```

两个字段值得单独说明：

- **`hint`** —— 引导模型的下一步。MCP 服务端无状态、模型又容易忘工作流，`hint` 是最有效的
  低成本纠偏手段，比堆长工具描述管用（工具描述还有 ~5000 token 总预算要守）。
- **`taskContext`** —— 每个响应都回带，让 `taskId` 与分支状态**持续出现在上下文里**，
  避免模型聊到第 20 轮把 `taskId` 弄丢。丢了也有兜底：错误信息直接列出活跃任务供选择。

### 5.6 Staleness 检查（D9）

`grande_repo_read` 返回每个文件的 `sha256`。`grande_repo_edit` 修改**已有文件**时必须携带
`expectedSha256`，不匹配返回 `STALE_FILE`（创建新文件不需要）。

即使单用户无并发，模型自己也会踩：读了文件 → 改了 → 跑了测试 → 又基于**最初那次读**的内容
再改一次，覆盖掉第一次的修改。这是长会话里必然出现的困惑源，症状极隐蔽（"我明明改了啊"）。

完整的事务性多文件 patch、Checkpoint、Trash 仍留在 S1。

---

## 6. Seatbelt 沙箱与 `run_profile`

### 6.1 Profile 注册

```yaml
# ~/.grande-control/config/repos.yaml   ← 沙箱不可见
repos:
  grande-gpt:
    path: grande-gpt              # 相对 GPT_Workspace；Gateway 校验必须是直接子目录
    depDirs: [node_modules]       # worktree 创建后用 clonefile 继承
    profiles:
      unit:
        argv: ["npm", "test", "--", "--run"]
        timeoutSeconds: 300
      unit-file:
        argv: ["npm", "test", "--", "--run", "{{file}}"]
        argSchema:
          file: { type: worktree-path, mustExist: true }
      lint:      { argv: ["npm", "run", "lint"],     timeoutSeconds: 120 }
      typecheck: { argv: ["npx", "tsc", "--noEmit"], timeoutSeconds: 180 }
```

三条硬规则：

1. **只有 argv 数组，永不拼 shell 字符串。** 没有 shell 就没有管道、重定向、命令注入、`$()`。
2. **只从可信配置读，不读仓库内任何文件**（D8）。
3. **`{{file}}` 这类参数按类型校验**（worktree 内的相对路径、必须存在），校验后作为**独立
   argv 元素**传入。因为不经 shell，元字符没有意义。

`unit-file` 变体让模型能只跑单个测试文件而非整套。实际开发里这能把反馈循环从几分钟压到几秒，
对 ChatGPT 这种高延迟交互特别重要。

### 6.2 SBPL 生成

每个 job 动态生成，不复用静态文件：

```scheme
(version 1)
(deny default)
(deny network*)                                    ; S0 全禁网

(allow file-read*)                                 ; 读放宽，见下方说明
(deny  file-read*   (subpath "<controlRoot>"))     ; 审计与配置对被审计者不可见
(deny  file-read*   (subpath "<workspaceRoot>/.grande-work/worktrees"))
(allow file-read*   (subpath "<worktree>"))        ; 再放回自己的

(allow file-write*  (subpath "<worktree>"))        ; 只有本任务 worktree 可写
(allow file-write*  (subpath "<jobTmp>"))
(deny  file-write*  (subpath "<canonical>/.git"))  ; ← §4.5：hooks 为所有 worktree 共享
(deny  file-write*  (subpath "<worktree>/.git"))

(allow process-exec (subpath "/usr/bin") (subpath "/bin") (subpath "/opt/homebrew"))
(allow process-fork)
(allow sysctl-read)
```

**SBPL 裁决语义（已实测，2026-07-25 本机 macOS 26.5.1）**：**按最具体规则优先，不是按书写顺序。**

| 实测场景 | 结果 |
|---|---|
| `allow file-read*` 后接 `deny (subpath X)` | X 被拒 —— 具体 deny 胜过泛 allow |
| `deny (subpath X)` 后接 `allow file-read*` | X **仍被拒** —— 顺序不影响，具体者胜 |
| `deny (subpath P)` + `allow (subpath P/child)` | **child 可读，P 下其余被拒** |

第三行正是上面策略依赖的模式：先 deny `worktrees` 父目录，再 allow 本任务 worktree，
即可实现"只见自己、不见他人"。**采用嵌套写法而非逐个 deny 其他 worktree**，因为前者是静态的、
自动覆盖将来新建的 worktree，后者需要在每次 job 启动时枚举。

**网络拒绝已实测**：`(deny network*)` 下 DNS 解析失败，直连 IP 亦在 socket 层即刻被拒
（curl exit 7，0 ms）；无沙箱对照正常连通。

**关于 `file-read*` 放宽**：读权限相对宽松（除控制平面根与其他任务 worktree 外），而非逐目录
白名单。理由是 node/npm/tsc 会读大量意想不到的系统路径，白名单会陷入无穷调试；而**S0 全禁网
意味着读到的东西出不去**。这是有意识的取舍，不是疏漏。

**环境变量必须清洗** —— 你的 shell 环境里很可能有 `GITHUB_TOKEN`、各种 `*_API_KEY`。
子进程只传 `PATH`、`HOME=<jobTmp>/home`、`LANG`、`TMPDIR=<jobTmp>`，其余一律不传，
并剥离所有 `DYLD_*`（防 dylib 注入）。

### 6.3 依赖目录：不处理就跑不起来

`git worktree add` 创建的是**干净 checkout，没有 `node_modules`**（被 gitignore）。
而 S0 禁网装不了。

**方案**：worktree 创建后用 **APFS clonefile**（`cp -Rc`）从 canonical 克隆 `depDirs`。
COW 意味着 N 个并发 worktree 不会 N 倍占盘。

**实测结果（2026-07-25，本机）**：文件系统确为 APFS；符号链接完好保留；
速度约为普通 `cp -R` 的 **2 倍**（0.18s vs 0.35s / 2000 文件 / 7.8 MB）。
**主要收益是零额外磁盘占用，不是速度** —— 早期描述曾夸大为「近乎瞬时」，此处更正。

两个必须在实现时实测的坑：

- **pnpm**（本机装有 10.33）的 `node_modules` 大量符号链接指向全局 store。若指向 worktree 外，
  **SBPL 必须放行对该 store 的只读访问**，否则 require 全挂。
- `.bin/` 下的相对符号链接实测保留；**绝对符号链接会指回 canonical，需检查**。

**S0 不提供联网的依赖安装 profile。** 依赖由用户在 canonical 里手动装好，worktree 继承。
这样 S0 完全不需要设计网络白名单。

### 6.4 Job 生命周期

```
grande_run
 → 校验 profile 已注册、task 处于 READY
 → 生成 SBPL → 建 jobTmp → clonefile 依赖
 → spawn(sandbox-exec, { detached: true })      ← 新进程组，关键
 → 立即返回 { jobId, pollAfterSeconds, hint }

后台
 → 采集 stdout/stderr（字节上限，超限截断并停止采集）
 → 超时 → kill(-pgid, SIGTERM) → 5s → kill(-pgid, SIGKILL)
 → 每 2s 轮询进程组 RSS 与进程数，超阈值同样杀
 → 结束 → 落 artifact → 解析摘要 → 更新 job 状态
```

**必须杀整个进程组**（`kill(-pgid)`）而非只杀 `sandbox-exec`。`npm test` 会派生一串子进程，
只杀父进程会留下孤儿继续吃 CPU —— 这是这类系统最常见的泄漏源。

### 6.5 资源兜底

Seatbelt 完全没有资源限制，这是 D1 的代价：

| 维度 | 手段 | 可靠性 |
|---|---|---|
| 墙钟 | `timeoutSeconds` 到点杀进程组 | **可靠** |
| 输出量 | stdout/stderr 字节上限，超限截断并停止采集 | **可靠** |
| 内存 | 每 2s 轮询进程组总 RSS，超阈值杀 | **不可靠** —— 2s 窗口内可冲高 |
| 进程数 | 同上轮询，fork bomb 兜底 | **不可靠** —— 同上 |
| 磁盘 | job 结束检查 worktree 增量，超限告警 | S0 只告警不杀 |

**诚实结论：轮询不是 cgroup，快速 fork bomb 仍能造成短时影响。**

实现时先实测 `RLIMIT_AS`（`ulimit -v`）对 Node 24 是否可用 —— 可用则作为第一道防线，
轮询降为第二道。macOS 上 `RLIMIT_AS` 与现代分配器/JIT 配合常有问题，**实测再定，不预先承诺**。

后续硬化方向（不进 S0）：用独立 Unix 用户跑沙箱，`ulimit -u` 就能真正生效而不影响主账号。

### 6.6 日志与 artifact

完整 stdout/stderr 落 `~/.grande-control/artifacts/<taskId>/<jobId>/`。
返回给 ChatGPT 的**只有摘要**：

```json
{ "state": "failed", "exitCode": 1, "durationMs": 12400,
  "failedTests": ["parser > handles empty input"],
  "tail": ["...最后 40 行..."],
  "artifactId": "art_9f2",
  "truncated": true,
  "hint": "2 个用例失败。需要完整日志可用 artifactId 分页取。" }
```

S0 的失败解析**只做 exit code + 尾部日志 + 可配置的失败行正则**，不做各测试框架的结构化解析器
—— 那个留 S2，届时用 `--reporter=json` 会更可靠。

---

## 7. 错误模型

| 错误码 | 含义 | 建议重试 |
|---|---|---|
| `INVALID_INPUT` | Schema 或参数无效 | 修正参数 |
| `UNAUTHORIZED` | Token 无效或过期 | 重新授权 |
| `POLICY_DENIED` | 触发路径 / profile / repo 边界 | 否 |
| `REPO_NOT_REGISTERED` | repoId 未注册或非直接子目录 | 否 |
| `TASK_NOT_FOUND` | `taskId` 不存在 —— **错误信息须列出活跃任务** | 用正确 taskId 重试 |
| `STALE_FILE` | `expectedSha256` 不匹配 | 重新读取后重试 |
| `CANONICAL_BUSY` | canonical 处于 rebase / index.lock / detached HEAD | 用户处理后重试 |
| `WORKTREE_DIRTY` | 操作要求干净 worktree | 先处理修改 |
| `PROFILE_NOT_FOUND` | profile 未注册 | 否 |
| `JOB_TIMEOUT` | 超过 `timeoutSeconds` | 拆分或调整 profile |
| `RESOURCE_EXHAUSTED` | RSS / 进程数 / 输出量超限被杀 | 拆分任务 |
| `NETWORK_DENIED` | 尝试联网（S0 恒禁） | 否 |

`TASK_NOT_FOUND` 的错误信息必须列出活跃任务及其分支与变更数 —— 这是 `taskId` 丢失时的兜底路径，
比干巴巴报错有用得多。

---

## 8. 数据模型与本地观测

### 8.1 数据模型（S0 最小集）

SQLite，位于 `~/.grande-control/state/grande.db`。

```
task
  taskId TEXT PK · repoId · branch · baseCommit · worktreePath
  state  TEXT              -- CREATING | READY | RUNNING | CLOSED
  createdAt · updatedAt · stateVersion INTEGER

job
  jobId TEXT PK · taskId FK · profile · argv JSON
  state TEXT               -- running | passed | failed | timeout | killed | cancelled
  pgid INTEGER · exitCode · startedAt · endedAt
  artifactPath · summary JSON

audit
  opId TEXT PK · taskId · tool · inputDigest
  decision TEXT            -- ALLOWED | DENIED
  state    TEXT            -- INTENT | EXECUTING | SUCCEEDED | FAILED
  pathsTouched JSON · at TIMESTAMP
```

**`audit` 先写 `INTENT` 再执行**（草案 §14.1 的做法）。业务执行与审计不是单一事务，
但未完成状态可被后台恢复器发现并核对（恢复器本身属 S4）。

S0 不含：`lease`、`checkpoint`、`trash`、`userId`。

### 8.2 CLI 调试视图（D10）

S0 的运行状况查看用 CLI 而非网页 —— 网页 = 新页面 = T3，须走完整 Mockup Gate（见 §10.2）。
CLI 直接读同一个 SQLite 与 artifact 目录，**只读，不提供任何变更能力**。

| 命令 | 输出 |
|---|---|
| `grande status` | 活跃 task：分支、worktree、变更文件数、状态、最近 job |
| `grande jobs [--task <id>]` | job 列表：profile、状态、耗时、exit code |
| `grande logs <jobId> [--full]` | 摘要日志；`--full` 直出 artifact 完整内容 |
| `grande audit [--task <id>]` | 审计流水：opId、工具、Policy 决策、触及路径 |
| `grande doctor` | 环境自检：`sandbox-exec` 可用性、APFS、已注册 repo 的路径与 profile 有效性、隧道连通性 |

`grande doctor` 值得单列 —— S0 的失败大多来自环境（隧道断了、profile 里的命令不存在、
canonical 处于 rebase 中），一条命令给出可执行诊断，比让人去猜快得多。

CLI 与 Gateway **共享同一份读取逻辑**，避免两处实现对状态的解释不一致。

---

## 9. S0 验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| AC-1 | ChatGPT 无法访问未注册 repo 或 `GPT_Workspace` 之外的任意路径 | 自动化：构造越界路径参数，断言 `POLICY_DENIED` |
| AC-2 | 所有修改发生在任务 worktree，canonical 工作树零变化 | 自动化：任务前后对 canonical `git status` 取快照比对 |
| AC-3 | 两个任务可并行操作同一 repo 而不共享工作目录 | 自动化：并发开两任务，断言 worktree 路径不同且互不可见 |
| AC-4 | 文件在读取后被改动时返回 `STALE_FILE`，不静默覆盖 | 自动化：read → 外部改动 → edit，断言错误码 |
| AC-5 | 所有代码执行在 Seatbelt 沙箱内，**默认无法访问网络** | 自动化：fixture 内放一个联网测试，断言失败且错误为网络拒绝 |
| AC-6 | 沙箱内进程无法读取 `~/.grande-control/**` | 自动化：fixture 测试尝试读 `state/grande.db`，断言被拒 |
| AC-7 | 沙箱内进程无法写 `<canonical>/.git/hooks/**` | 自动化：fixture 测试尝试写 hook，断言被拒且文件未创建 |
| AC-8 | 超时的 job 连同其全部子进程被终止，无孤儿残留 | 自动化：profile 跑一个派生子进程的死循环，超时后断言进程组内无存活 PID |
| AC-9 | 所有工具响应超限时显式标记 `truncated`，且提供可用的续读路径 | 自动化：构造超大文件 / 大量匹配，断言字段存在且续读有效 |
| AC-10 | 每个 mutation 有 `opId`、Policy 决策与可查询的审计状态 | 自动化：执行后查 `audit` 表 |
| AC-11 | Gateway 重启后 task 状态可恢复；重启前处于 `running` 的 job 按存储的 `pgid` 探活对账 —— 进程组已消失则置为 `interrupted`，仍存活则重新接管监控 | 自动化：跑 job 中途重启 Gateway，断言两种情形下状态均正确且无 job 永久停留在 `running` |
| AC-12 | 环境变量清洗生效：沙箱内看不到宿主的 `*_TOKEN` / `*_API_KEY` | 自动化：注入假 token 到 Gateway 环境，fixture 测试断言读不到 |
| **AC-13** | **在真实 ChatGPT 对话中完成一次「读 → 改 → 跑测试 → 看失败 → 再改 → 通过」完整循环** | **人工**：对 fixture 仓库与 grande-gpt 各做一次，记录对话轮数、确认框次数、模型选错工具的次数 |

**AC-13 是 S0 真正的目标**，其余 12 条是它的安全前提。AC-13 的观察记录（尤其是模型选错工具的
情况与 `taskId` 是否丢失）**直接决定 S1–S5 的工具设计**，必须成文留存而非口头结论。

### 9.1 验收仓库

- **fixture 仓库** —— 在测试时 materialize 到 `.grande-work/fixtures/`，含少量文件、
  一个快速测试套、一个故意失败的用例、一个联网测试（供 AC-5）、一个尝试越权的测试（供 AC-6/7/12）。
  保证确定性与可重复。
- **grande-gpt 自身** —— 人工 dogfooding，暴露真实交互问题。

---

## 10. 路线图

| 切片 | 内容 | 粗估（人日） |
|---|---|---|
| **S0** | 薄端到端：九工具 + Seatbelt + `/mcp/<repoId>` + CLI 调试视图 | 13–19 |
| S1 | 安全写入层：OID 校验、事务 patch、Checkpoint、Trash、删除解禁 | 8–11 |
| S1.5 | 开发约束层：硬 policy 门禁 + 软方法论指引 | 3–4 |
| S2 | 本地开发闭环：worktree 生命周期、commit、base sync、Verification Attestation | 11–15 |
| S2.5 | 前端控制台（**T3**，须过 Mockup Gate） | 10–15 |
| S3 | GitHub 闭环：GitHub App、push、Draft PR、CI | 6–9 |
| S4 | 稳固化：审计对账、僵尸恢复、保留策略 | 4–7 |
| S5 | 外部校验器接入（按需评估，很可能不做） | 0–5 |

**合计 55–85 人日**，与草案 49–72 的区间基本吻合，多出的主要是控制台。

### 10.1 S1.5 开发约束层的设计取向

| | 硬约束（Gateway 门禁） | 软约束（指令文本） |
|---|---|---|
| 实现 | Policy 引擎拦截工具调用 | 方法论文本返回给模型 |
| 模型能否绕过 | **不能** | 能 —— 忽略即可 |
| prompt injection 能否绕过 | **不能** | **能** |
| 例子 | 改 `src/**` 必须同时改 `tests/**`；`.github/workflows/**` 只读；commit 前必过 `unit` | TDD 流程、调试方法论、设计 workflow |

每 repo 一个 `.grande/policy.yaml`，**只能收紧不能放宽**全局 Policy（沿用草案 §9.2 原则）。
软约束侧需做 Claude Code → GrandeGPT 的工具词汇映射，否则模型会去调用不存在的工具。

### 10.2 S2.5 控制台的流程要求

按 `FRONTEND-DESIGN-WORKFLOW.md`（v3.3）§3，控制台同时命中三个 T3 触发器：
**新页面/路由**（所有新页面即 T3）、**破坏性操作**（worktree 清理 / task 关闭 / Policy 修改）、
**认证**（控制台自身需鉴权）。**不可降级。**

须出 Start Card → 五阶段 → **Human Owner 批准 rendered mockup 后才能开始 production 实现** →
独立 Review 与 Verification agent（新会话，不继承实现上下文）→ 记录落
`.agent/frontend-design/<task-id>/`。

### 10.3 关于 S5：为什么很可能不做

用户已明确 MCP / plugin 的定位是「做开发相关的约束」而非能力扩展。约束 = policy + 指令，
Gateway 原生就能提供，不需要代理本地 MCP 服务器。

而代理本地 MCP 在本架构下风险很高：本机挂载的服务器包括 Gmail、Google Drive、Telegram、
Notion、**computer-use（整个桌面控制）**、**claude-in-chrome（已登录的真实浏览器）**。
一旦代理，「Gateway 是唯一执行权威且能力面最小」当场瓦解，且仓库内容的 prompt injection
就能触达这些系统。此外聚合多上游会让工具数暴涨、撞上 ~5000 token 描述预算，
**反而降低模型选工具的准确率**。

因此 S5 的建议是：**做之前先重新评估到底还需不需要。** 若确需，规则是默认全禁 →
逐服务器 + 逐工具白名单 → 永不代理任何在 workspace 之外产生副作用的东西。

---

## 11. 已知缺口与已接受风险

| 缺口 | 影响 | 处置 |
|---|---|---|
| Seatbelt 无 CPU/内存/PID 限制 | 失控测试可拖垮整机 | 墙钟超时 + 进程组 kill + RSS 轮询；**明确记为不可靠** |
| `sandbox-exec` 被 Apple 标记 DEPRECATED | 未来某版 macOS 可能移除 | SBPL 生成收敛在单模块，替换面可控 |
| 无镜像 digest | 跨机不可复现 | Attestation 改记 `hostToolchain`（版本 + lockfile 哈希） |
| 单用户假设 | 将来开放需重做身份层 | 数据模型不预留 `userId`，接受返工 |
| 沙箱验证覆盖不完整 | 已实测：写拒绝 · 读嵌套 deny/allow · 网络拒绝（DNS 与直连 IP）· APFS clonefile。**未测**：全禁网下 node/npm/tsc 的实际可运行性、pnpm store 符号链接 | 列入 §12.1 待实测清单，S0 第一周内验证 |
| Gateway 进程本身未沙箱化 | Gateway 被攻破则边界失效 | 有意为之 —— Gateway 是可信代码；风险由「不引入通用逃生舱」控制 |

---

## 12. 待实测与待决策

### 12.1 S0 实现期间必须实测

| # | 待验证 | 为什么重要 |
|---|---|---|
| 1 | 实际账号能否连接 developer mode 自建连接器并执行写操作 | 整个方案的前提 |
| 2 | 工具调用超时的真实数值 | 决定 `pollAfterSeconds` 与各工具延迟预算 |
| 3 | 响应多大开始被截断 | 决定各工具的字节 / 条数上限 |
| 4 | 全禁网 + `deny default` 下 node / npm / tsc 能否正常运行 | 决定 `file-read*` 与 `process-exec` 的实际放行范围（网络拒绝本身已实测确认） |
| 5 | pnpm 全局 store 符号链接在沙箱下的行为 | 不放行则 require 全挂 |
| 6 | `RLIMIT_AS` 对 Node 24 是否可用 | 决定资源兜底的第一道防线 |
| 7 | 九个工具下模型的选择准确率 | **S0 的核心待验证问题** |
| 8 | 长对话中 `taskId` 的保持情况 | 决定 `taskContext` 回带策略是否足够 |

### 12.2 尚未决策

| 决策项 | 建议默认 | 需确认 |
|---|---|---|
| `hint` 文案语言 | 中文（与对话一致） | 是否需要英文以提高模型遵循度 |
| CLI 命名 | `grande` | 是否与现有命令冲突 |
| fixture 仓库的技术栈 | Node + vitest | 是否需要覆盖 Python |
| Cloudflare Tunnel 的域名 | 用 `trycloudflare` 临时域名起步 | 是否要绑自有域名。⚠️ 临时域名每次重启都会变，而 ChatGPT 要求稳定 URL —— 若频繁重启则需尽早绑定自有域名 |

### 12.3 S0 完成后的强制动作

**不直接进入 S1。** 先依据 AC-13 的观察记录复审九个工具的粒度、`hint` 策略与 `taskContext`
回带方式，把结论写回本规格，再开始 S1。S0 的产出是「一个能跑的系统」**和**「一份关于
ChatGPT 能否驱动它的证据」，后者才是决定 S1–S5 形态的输入。

---

## 附录 A. 与草案 v0.9 的主要差异

| 项 | 草案 v0.9 | 本规格 | 原因 |
|---|---|---|---|
| 宿主 | 单台 Linux 主机 | macOS 本机 | 用户决定 |
| 沙箱 | Rootless Docker + 镜像 digest | Seatbelt `sandbox-exec` | 用户决定（D1） |
| 仓库模型 | bare mirror + worktree | 原地 canonical + worktree | 用户要能正常用编辑器（D4） |
| 套餐前提 | Business / Enterprise / Edu | Plus / Pro 亦可 | 官方文档校正 |
| MCP 端点 | 单一端点 | 每 repo 一个 `/mcp/<repoId>` | MCP 不传 Project 身份，隔离须协议层强制（D5） |
| 用户模型 | 单用户或小范围内部用户 | 严格单用户 | 用户决定（D2） |
| 工具数量 | 约 40 个 | S0 九个 | 先验证交互再扩展 |
| 首个里程碑 | v0.1 完整本地开发（~30 人日） | S0 薄端到端（13–19 人日） | 产品风险大于工程风险，需尽早暴露 |
| 控制台 | 未列入 MVP | S2.5，T3 流程 | 用户要求 |

## 附录 B. 参考资料

- 用户提供：`Chat-Dev-Control-Plane-方案B-设计文档.docx`（v0.9 设计整理稿，2026-07-25）
- [ChatGPT 平台约束调研](../../research/2026-07-25-chatgpt-platform-constraints.md)（含全部官方来源链接）
- `/Users/xtation/AgentWorks/FRONTEND-DESIGN-WORKFLOW.md` v3.3（S2.5 控制台适用）
