# GrandeGPT — 项目说明

让用户在 **ChatGPT 普通对话**中完成端到端代码开发任务的受控执行平台。
**S0 / S0.5 / S1 / S1.5 均已完成。S1 是第一个由 ChatGPT 经 GrandeGPT 自身实现的切片**（详见下方「当前状态」）。

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
| ~~D5~~ | ~~每 repo 一个 MCP 端点 `/mcp/<repoId>`~~ | **已被 D18 取代（2026-07-29）**——实测代价不可接受：N 个仓库 = N 个 ChatGPT 连接器 |
| D18 | **单一端点 `/mcp` + 任务绑定隔离**，`/mcp/<repoId>` 保留为兼容旧连接器的别名 | 写/跑路径从 `taskId`→`task.repoId` 推导，模型无法自由指定写到哪个仓库；只有 `grande_task_open` 与无任务浏览需要显式 `repoId`。残留风险：提示注入可诱导模型在另一个已注册仓库 `task_open`（该动作走审计、可见，但不阻止），缓解手段留待 S1 |
| D6 | **实现语言 TypeScript**，隧道用 Cloudflare Tunnel | MCP 官方 TS SDK 是参考实现 |
| D7 | **不涉及 Codex**，不读写 `~/.codex`，不上架插件目录 | 用户明确约束 |
| D8 | **S0 不做**：删除文件 / commit / push / GitHub / Checkpoint / Lease / 网络 | 保证 S0 快速拿到 ChatGPT 交互反馈 |
| D11 | **POC 先行，未通过不启动 S0** | 55–85 人日押在一个 1–2 天可验证的假设上（模型能否自主轮询）。见规格 §13 |
| D12 | **必须确认 ChatGPT 账号的训练数据设置** | Plus/Free 消费者账号**默认**用你的内容改进模型；私有代码会流经对话 |
| D16 | **S0 接入方式 = Cloudflare Tunnel + Server URL + OAuth 2.1(PKCE)** | D13/D15 已作废：OpenAI Secure MCP Tunnel 需要 Platform API key（另一套计费），与「用 chat 额度」的初衷冲突 |
| D17 | **Production 命名**：隧道 `grande-gpt` → `grande.agentjoey.ai` → `127.0.0.1:8787`，端点 `https://grande.agentjoey.ai/mcp`（D18 之后；`/mcp/<repoId>` 保留为兼容别名） | 已实测跑通 |

## 当前状态：S0 → S2 全部完成；S1 与 S2 由 ChatGPT 自举实现

**S0-A/B/C/D、S0.5、S1、S1.5、S2 均已合并到 `main`。** 581 测试通过，typecheck 干净。

**S1 是第一个由 ChatGPT 经 GrandeGPT 自身完成的切片**——9 个任务、17 个文件、外加 review 后一轮修复。记录见
[`docs/superpowers/plans/2026-07-29-s1-safe-write-layer.md`](docs/superpowers/plans/2026-07-29-s1-safe-write-layer.md)。
**GrandeGPT 可以给任意已注册 repo 用了。**

### 已实现的能力

**十三个 MCP 工具**（`src/tools.ts`；仓库始终由 `taskId` 单向推导，D18）：

| 工具 | 类型 | 作用 |
|---|---|---|
| `grande_task_status` | 只读 | 任务状态/分支/改动/最近 job；**无参调用列出所有仓库与活跃任务**（跨会话恢复靠它） |
| `grande_repo_map` | 只读 | 目录树 + 关键文件 |
| `grande_repo_search` | 只读 | 文本/正则/glob 搜索，支持 `nextCursor` 续读 |
| `grande_repo_read` | 只读 | 读文件，返回 `sha256` |
| `grande_diff` | 只读 | worktree vs base，按文件分页 |
| `grande_run_result` | 只读 | 轮询 job + 摘要日志 |
| `grande_task_open` | 写 | 建分支与 worktree（**唯一**由模型显式指定 `repoId` 之处），克隆 `depDirs` |
| `grande_repo_edit` | 写 | 一次调用改多文件：create / modify / move / **delete**（S1；后两者需 `expectedSha256`）。**事务性**：任一步失败自动回滚整批，成功返回 `checkpointId` |
| `grande_run` | 写 | 在 Seatbelt 沙箱里跑白名单 profile，立即返回 `jobId` |
| `grande_task_close` | **破坏性** | 删 worktree 与分支回收磁盘（**全表唯一** `destructiveHint: true`，ChatGPT 会弹确认框） |
| `grande_rollback` | 写 | 把 worktree 回滚到某个 checkpoint（S1；被覆盖的内容进 Trash，故 `destructiveHint: false`） |
| `grande_commit` | 写 | 提交任务 worktree 的全部改动到任务分支（S2）。**所有 git 调用带 `-c core.hooksPath=/dev/null`**，见下方安全说明 |
| `grande_sync_base` | 写 | 把 base 同步到 canonical 当前分支（S2）。用 merge 不用 rebase；冲突一律拒绝并 `merge --abort` |

**五个 CLI 子命令**（`grande <cmd>`）：`status`、`jobs`、`audit`、`gc`、`doctor`。
`gc` 默认 dry-run，`--apply` 才执行。

**基础设施**：
- OAuth 2.1 + PKCE(S256) + DCR + refresh 轮换（含复用检测），单一 `/mcp` 端点，
  `aud` 恒从服务端配置推导；client 与 refresh token 跨重启持久化
- Cloudflare Access 门禁挡在 `/authorize` 第一行，配置缺失 fail-closed
- macOS Seatbelt 沙箱：`deny default` + `deny network*`，写只放行本任务 worktree，
  沙箱内 `git` / `pnpm` / `vitest` / `tsc` 可用
- 审计账本（PENDING→ALLOWED→EXECUTING→终态，CAS 推进），启动时 job + worktree 双向对账
- 优雅关停等在途 job 收尾（30s 上限）

**已在真实 ChatGPT 普通对话里验证通过的三件事**：

1. **AC-13（完整开发闭环）** —— `task_open → 探索 → repo_edit → run → run_result（预期失败）
   → repo_edit → run → 通过`，canonical 全程零污染。记录见
   [`docs/research/2026-07-29-ac13-observation.md`](docs/research/2026-07-29-ac13-observation.md)。
2. **D18（单一端点 + 任务绑定隔离）** —— 同一个 `https://grande.agentjoey.ai/mcp` 连接器
   操作了 grande-gpt 之外的仓库（urbanbricks），worktree 落在 `urbanbricks/` 名下、
   依赖目录克隆完整（654 个 .pnpm 包）、canonical 零污染。
3. **P-1（模型自主轮询）** —— 90 秒的 job，模型自主发起 **5 次** `grande_run_result`，
   4 次拿到 `running` 非终态后**每次都自己再取**，全程零用户消息。记录见
   [`docs/research/2026-07-29-p1-polling-observation.md`](docs/research/2026-07-29-p1-polling-observation.md)。

   ⚠️ **测 P-1 的纪律**：发出提示词后全程不再说话——任何一条用户消息都会让
   「自主轮询」与「被用户推着走」无法区分。另外网关日志必须带时间戳，
   否则只能数次数、量不出间隔。

**有界审查（2026-07-29，范围 `43ec654..HEAD`）**

不做无限制扫描——探针对准本项目**已重复犯过**的四类错误：

| 探针 | 结果 |
|---|---|
| **P-A 接线**（四次「模块写好但没接上线」） | ❌ 第五次：`awaitJobSettled` 从未被关停路径调用 |
| **P-B 反向测试**（`destructiveHint: true` 曾把 bug 钉成规范） | ✅ 注解与规格 §5.2 一致 |
| **P-C 同源漏改**（两次「修复只改一个调用点」） | ❌ `isValidResource` 守 `/authorize` 不守 refresh |
| **P-D 安全边界**（CRITICAL-1；audience 是唯一防跨应用提权的检查） | ✅ fail-closed、gate 在 `/authorize` 第一行、`/token` 的 aud 恒从服务端配置推导 |

两个 ❌ 已修（`ae81b48`），各带回归测试 + load-bearing 证明。
**教训**：接线类缺陷单元测试天然抓不到——它们检查的是「谁调用了谁」，
不是「函数算得对不对」。P-A 那个「遍历所有导出、查生产调用点」的机械探针
值得每轮都跑一次。

**S0.5 可用性收尾（2026-07-29 完成）**

三项都是「不做就会坏」的地基，不是功能增强：`grande_task_close`（worktree 无限累积
——2 个任务已占 722M）、沙箱内 `git`（不修就没法用 GrandeGPT 开发 GrandeGPT）、
`grande gc` 双向对账（库与磁盘**当时已经不一致**，有一个孤儿 worktree）。
已用 `grande gc --apply` 完成首次真实回收：722M → 635M，git 注册项与分支一并清掉，
活跃任务无误伤，重跑幂等。

**已知遗留**（按优先级）：

| # | 问题 | 状态 |
|---|---|---|
| 1 | `task_close` 的守卫写 `j.state === "running"` 而非用 `jobs.ts` 的 `TERMINAL` 集合 | 今天行为等价（`JobState` 6 值、`TERMINAL` 占 5），将来加状态会漏。**同源漏改**形状 |
| 2 | GC 方向 A 只认「完全没有 task 行」。`CLOSED` 但目录残留（`removeWorktree` 在 `branch -D` 抛错）两个方向都看不见 | 由 w1 在 s05-3 报告里主动提出，规格合规，候选第三种情形 |
| 3 | `grande_repo_search` 的 `truncated` 信号被模型忽略过一次（未跟进 `nextCursor`） | 观察项，**单次样本**，不足以定性 |
| 6 | `repoEdit` 里 `const taskId = basename(root)` | 引入「`root` 最后一段必须是合法 taskId」这个**签名上看不见的前置条件**。安全上无洞（`root` 来自库里的 `task.worktreePath`，且 `createCheckpoint`/`moveToTrash` 都会再 `assertTaskId`），但脆。应改为显式传 `taskId` |
| 7 | `repoEdit` 里调 `loadLayout()` | 原本只依赖入参的函数现在读全局配置，测试与复用都变难 |
| 8 | 历史 S0 文档仍写着 `repo_edit` 不支持 delete | 已被 S1 规格取代；实现者主动标注过，未做全仓历史文档改写 |
| 9 | **备份（Backlog，不着急）** —— 目标：本地 NAS。两件独立的事，优先级相反：① **控制平面 `~/.grande-control/`（26M）不在任何 git 仓库、无版本控制**，其中审计账本按定义不可重建；⚠️ `secrets/` 绝不能进备份仓库，需要排除方案。② `grande-gpt` 代码无 remote——注意**设计文档也在这个仓库里**，机器挂了一起丢 | Human Owner 已定：放 backlog，走本地 NAS |
| 10 | **GitHub PAT 授权范围比设计的宽** —— 实测能访问 6 个仓库，只有 `urbanbricks-poc` 是已注册的。非当前可利用（`grande_push` 只能推已注册 repo 的 remote），但第二层防线宽于设计 | 建议改成只勾 `urbanbricks-poc`。另：fine-grained PAT 的权限授予**从 API 读不到**，Contents/PR 是否给对需在设置页确认 |
| 11 | **`unit-selfhost` 排除的 5 个文件，其不变量在自举时完全失去保护** | S2 实测撞上：工具计数从 11 变 13，`tools.test.ts` 的计数不变量红了而实现者看不见。这次后果轻，下次可能是安全断言。**建议加一个 `grande outer-test` CLI 子命令**，让「该跑外层了」有机制提醒，而不是靠人记得 |
| 4 | **`tools/list` 未进日志**；且没有「客户端视角」自检手段 | 见下方「ChatGPT 权限档」一节。2026-07-29 那次故障全靠自签 token 手查才定位 |
| 5 | `GET /.well-known/openid-configuration → 404` | ChatGPT 会探这个路径。我们提供的是 RFC 8414 的 `/.well-known/oauth-authorization-server`，OAuth 流程正常完成，**不影响功能**。记下以防将来某客户端真的需要 |

### ⚠️ ChatGPT 权限档会「列出」但「拒绝调用」写工具（2026-07-29 实测）

**症状**：模型能列出 `grande_task_open` 等工具，调用却报
`Resource not found: GrandeGPT.grande_task_open`，而**服务端日志里连一条请求都没有**。
只读工具（`readOnlyHint: true`）全部正常。

**根因**：ChatGPT 在 `Allow low-risk actions` 档下拒绝调用 `readOnlyHint: false` 的工具。
**修法：把连接器权限改成 `Allow all actions`。**

**这与 AC-13 那轮矛盾**——同一档位下 `repo_edit`/`run` 当时跑完了完整开发闭环，
期间我们没动过工具注解。所以这是 **ChatGPT 侧的平台行为变化**，不是本项目的 bug。
**不要为了绕过它把写工具的 `readOnlyHint` 改成 `true`**：那是对客户端撒谎，会让
ChatGPT 的权限机制整体失效——而我们主动依赖那一层（`task_close` 的
`destructiveHint: true` 让它在低风险档下被正确隐藏，就是它在工作）。

#### 排查方法（这次绕了三个错误假设才找到，下次直接照做）

**第一步永远是看服务端日志，判断请求到底有没有到。** 这是区分「客户端没发」与
「服务端拒了」的唯一可靠办法，而后者在日志里必然留痕、前者必然无痕。

**「服务端全绿、日志无失败、用户侧完全不可用」是一个真实的盲区形态。**
一旦确认请求没到达，问题在客户端，**不要再在服务端找**。

拿到「部分工具能用、部分不能」之后，**先比对 `tools/list` 里两组工具的结构差异，
把变量隔离到只剩一个，再动手**。用库里的签名密钥自签一枚本地 token 就能直接问：

```
POST http://127.0.0.1:8787/mcp  {"jsonrpc":"2.0","id":1,"method":"tools/list"}
  Authorization: Bearer <用 ~/.grande-control/secrets/oauth-key 自签>
```

这次比对下来，能用与不能用的两组在顶层键、`type`、`required` 形状上**完全相同**，
唯一差别就是 `readOnlyHint`——一条命令就锁定了变量。翻转它做单变量实验即可判决。

被这次实测**排除**的三个假设（别再重猜）：
① 注册循环中途抛错导致后续工具没注册 —— 10 个全在 `tools/list` 里
② `tools/list` 响应被 ChatGPT 静默截断 —— 只有 8.2KB，远低于 POC 实测的 ~73,896 字节
③ 权限档被误设成 `Allow read actions` —— 用户确认是 `Allow low-risk actions`

还有一个中间判断也错了：从「读工具到达、写工具从不到达」直接跳到「被过滤」，
**漏掉了第三种可能——工具在客户端的表里、但调用路由不到**。
判别办法：让模型直接列出它能看见的全部工具名。

#### 由此暴露的两个待办

| # | 缺口 |
|---|---|
| 1 | **`tools/list` 没有进日志。** 现在只有 `POST /mcp → 200`，看不出客户端取过几次工具表、拿走了什么。这次全靠自签 token 手查才拿到服务端视角 |
| 2 | **没有「客户端视角」的自检手段。** 目前唯一办法是让模型自己报它看得见什么——这不该是排查时才临时想起来的招 |

### ⚠️ git hooks 是沙箱之外的代码执行入口（S2，2026-07-30 实测）

`git commit` / `git merge` 会执行 hooks，而**这些命令只能跑在 Gateway 进程里**
（沙箱 `deny file-write*` 盖住 `.git`）。于是 hook 里的任何东西都在**沙箱之外、
以 Gateway 身份**执行。

`.git/hooks/` 本身写不进去（`policy.ts` 的 `BUILTIN_PREFIXES` 硬拒，且已堵掉
`src/../.git/` 与 `vendor -> .git` 两条绕行）。**但 `core.hooksPath` 能把 hooks
指向仓库内【被跟踪的】目录**——那是很多项目的正常做法（共享 hooks），而
`repo_edit` 写得了那种普通文件。**实测确认这条链走得通。**

**所以 `src/` 里每一条 git 调用都必须带 `-c core.hooksPath=/dev/null`。**
不要用 `--no-verify`——它文档上只保证跳过 `pre-commit` 与 `commit-msg`；
hooksPath 覆写无条件杀掉全部，对将来 git 新增的 hook 类型也成立。
目前 `commit.ts` / `syncBase.ts` / `baseStatus.ts` / `attestation.ts` 四处都有，
**新增任何 git 调用点时必须一并加上**（这是 P-C 同源漏改的高危形状）。

#### 沙箱本身也挡这条，但那让测试成了假阴性

沙箱的 `process-exec` 白名单只放行 execRoots 与 `node_modules/.bin`，所以
worktree 里的 hook 会 `execvp() failed: Operation not permitted`，git 拿到 EPERM
后**静默当作「没有 hook」继续**。这是纵深防御的好消息，但意味着：

**AC-S2-1（hook 不执行）在 `unit-selfhost` 里无论有没有防护都绿。**
这条 load-bearing 证明**只能在沙箱外做**。S2 那轮实现者正确地在此停机、拒绝用
形状断言凑数，由 reviewer 在沙箱外补完。

### 沙箱读放行已收紧为显式白名单（2026-07-29，`95eec1b`）

原先 `(allow file-read*)` 无条件放行。规格 §425「读放宽」是有意设计，但威胁模型
只覆盖了「写」与「网络」，漏掉了这条实测走通的链：**沙箱内读宿主文件 → 写进
worktree → 模型 `grande_repo_read` 读走 → 出到 ChatGPT**。

**改 `src/sbpl.ts` 的读规则前必读的四条实测结论**（每条都在代码注释里，别再踩一遍）：

1. **Seatbelt 是「后匹配者胜」，不是「最具体者胜」。** `allow jobTmp` 写在
   `deny controlRoot` 之前，jobTmp 就读不到——尽管它明显更具体。症状骗人：git 照常
   工作，node 在 `InitializeOncePerProcess` 直接 SIGABRT，栈里只有 dyld。
   规格 §444 那句「具体 deny 胜过泛 allow」是巧合（deny 恰好写在后面）。
2. **execRoots 必须可读，不只可执行。** PATH 查找、读 shebang、dyld 读二进制都走
   `file-read*`。漏掉的症状是 `env: pnpm: No such file or directory`——像 PATH 配错。
3. **`/etc` 与 `/private/etc` 两条都要写**（git 用前者、curl 用后者）；`/var` ↔
   `/private/var` 同理，且漏掉后者时报的是**写**失败、真正缺的是对 `/var` 的**读**。
4. **execRoots 的祖先链也要补。** Node 解析 CJS 模块对每级 realpath，走到 `/Users`。
   生产布局里 worktree 恰好也在 `/Users` 下，**只有测试夹具才暴露**——不要因为生产
   上碰巧不复现就省掉。

验收探针（13 条，`tests/sbpl.test.ts` + `tests/sandbox.test.ts` 已覆盖其中可自动化的部分）：
正向 `node` / `git` / `/bin/sh -c` / `pnpm verify` / `pnpm lint`；反向 `~/.npmrc`、
`~/.ssh`、工作区里别的仓库、控制平面配置与状态库、canonical 源码、写宿主、网络。


**POC 已通过**（观察记录 [`docs/research/2026-07-26-poc-observation.md`](docs/research/2026-07-26-poc-observation.md)）——
hard gate P-1「模型自主轮询」4/4 通过，最长自主链 17 次调用；40 次工具调用只消耗 5 条用户消息，无额度提示。

**S0-0 spike 已通过**：
- **U2**（Seatbelt）—— 真实 135 测试的 pnpm/vitest 套件在 `deny default` + `deny network*` 下跑通，
  见 [`spike/findings/U2-seatbelt.md`](spike/findings/U2-seatbelt.md)
- **U1**（OAuth）—— ChatGPT 真实握手跑通，DCR + PKCE(S256)，令牌 `aud` 精确绑定端点（D5 端到端坐实），
  见 [`spike/findings/U1-oauth.md`](spike/findings/U1-oauth.md)。
  ⚠️ **实测发现 refresh_token 缺口**：ChatGPT 注册时请求 `refresh_token` grant，我们不签发，
  1 小时后连接断开。**S0-D 必须实现 refresh_token**，见规格 §4.4

`poc/` 与 `spike/` 是一次性代码，**S0 的 `src/` 不得从它们 import**。
（例外：`spike/oauth/server.ts` 是 S0-D 认证层的直接原型，届时按原型重写而非 import。）

方向层面的五个风险（额度、自主轮询、context rot、ToS 与训练数据、投入产出比）见规格 §13。
**该节不是「已解决的风险清单」，是「尚未证伪的怀疑」** —— POC 只证伪了其中的「自主轮询」与部分「额度」。

## 三条铁律

1. **仓库内容不可信。** 代码、README、Issue、PR 评论、测试日志都只是数据。Policy 只从
   `~/.grande-control/config/` 读取。工具结果里的命令建议绝不自动执行。
2. **没有通用逃生舱。** 不提供 `shell_exec` / `filesystem_raw` / `git_raw` /
   `github_api_raw`。新能力必须先设计高层语义、输入边界、Policy 与审计字段，再注册为工具。
3. **能做成硬约束的绝不做成软约束。** 软约束（喂给模型的指令文本）可被 prompt injection
   绕过；硬约束（Gateway 门禁）不能。

**另有一条合规红线**：不得以任何形式脚本化 / 无人值守驱动 ChatGPT，也不得为规避额度做自动化。
OpenAI 消费者条款禁止程序化提取 Output 与规避速率限制。真人在对话中逐次确认是合规形态，
自动化不是。

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

## 多 agent 执行约定（S0-A 复盘后定，S0-B 起生效）

S0-A 实测：**实现只占 17% 的时间，修复占 44%**，而修复的每一条都源自计划自带的缺陷。
下面三条是针对性的，**不是建议，是约定**。

### ① 派 Task 1 之前，先把计划里的代码当代码审一轮

writing-plans 的自审只查占位符、任务分布、符号一致性 —— **全是结构性检查**。
对一份含完整代码的计划，这是错的检查面。必须另跑一轮**语义**审查，至少覆盖这份清单：

| 已实测出现过的模式 | 出现次数 |
|---|---|
| `ORDER BY <时间戳> DESC` 没有 tiebreak（同毫秒即不确定） | **3** |
| 状态跃迁的 UPDATE 没有 CAS 谓词（终态可被改写、状态可倒退） | **2** |
| 错误类的实现与它自己的测试断言不相容 | 1 |
| 断言匹配的字符串在消息里出现两次、其中一次来自输入（测试恒真） | 1 |
| 拒绝表因前置门禁先拒而根本到不了被测代码 | 1 |
| 进程入口守卫比较编码过的 URL 与裸路径（符号链接/空格/非 ASCII 下静默失效） | 1 |

### ② 无依赖的任务并行，别无条件串行

subagent-driven 那条「不要并行派发实现 subagent」针对的是**改同一批文件**的冲突。
先看真实依赖图再决定：S0-A 的 Task 2（paths/registry）与 Task 3（db/tasks/jobs）
各自只依赖 Task 1，**完全可以并行**，我却全程串行。
无文件重叠时用 `isolation: "worktree"` 并行派发。

### ③ 审查必须限定范围 —— 无限制审查是效率杀手

S0-A 实测：审查平均 **17.5 万 token 审一个约 2 万字节的 diff（约 9 倍）**，
最终修复轮 **61.8 万 token / 327 次工具调用**。厚度确实换来了真实的 bug，但水分明显。

派审查 agent 时**必须**：

- 给 **diff 文件路径**，禁止「自行探索仓库」——要读别的文件必须是我在 prompt 里点名的
- 给一份**有界的探针清单**（「验证这 3 件事」），不要开放式的「找找有没有问题」
- **不要让审查者重跑实现者已跑过的测试**——实现者的报告就是测试证据
- 明确写 **不在本轮范围**的内容，并说明它去了哪里（下一个切片 / 已记录）

**修复轮新增了代码就要再过一次复审。** S0-A 有四轮修复因为「审查已给过结论」跳过了复审，
最终整支审查在其中两轮各找到一个缺陷，**其中一个是修复本身引入的回归**。

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

<!-- pact:begin (managed by pactify — edit outside this block) -->
# pact protocol

This repo uses the **pact protocol** (v1). Seats (who does what) are listed in
`.pact/PROJECT.md` and `.pact/STATE.yml`.

**Your identity — bind it to this working copy first.** Your seat is resolved
from `PACT_AGENT_ID` (env), else the untracked `.pact/seat` file. Set the
file once per working copy:
```bash
pactify seat use <your-seat-id>   # from the roster in .pact/PROJECT.md
```
For concurrent seats in the same repo, use a separate git worktree per seat.

**Primary — MCP:** the `pact` MCP server is wired into your config. Use its tools
(projects / status / join / assign / checkpoint / accept / changes / merge / validate) and
resources (`pact://state`, `pact://log`). Cold start: call `status`, then `join`
(registers your seat and checks out your feature branch). Every action tool takes an
optional `project` (a name from `projects`) to act on another registered repo without
restarting — default is this repo.

**Fallback — shell** (if MCP is unavailable):
```bash
pactify seat use <your-seat-id>   # if not already bound
pactify join --roles <your-roles>
```
then `pactify help` for the verbs.

**The two rules:** a worker cannot self-accept (only the task's reviewer accepts); a
feature cannot merge until all its tasks are accepted.
<!-- pact:end -->
