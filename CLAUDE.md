# GrandeGPT — 项目说明

让用户在 **ChatGPT 普通对话**中完成端到端代码开发任务的受控执行层，定位于个人开发者、小团队和中小型/轻量项目。

**当前状态（2026-08-18）：S0 → S3 与 Phase 4（S4–S7）均已完成并合并到 `main`，完整开发闭环已通过真实 GitHub 与 production Gateway 实机验收。**

当前权威入口：

- [`README.md`](README.md) —— 当前产品定位、能力与 production 运维入口；
- [`docs/superpowers/specs/2026-08-18-grande-gpt-phase4.md`](docs/superpowers/specs/2026-08-18-grande-gpt-phase4.md) —— S4–S7 当前规格；
- [`docs/research/2026-08-18-phase4-closeout.md`](docs/research/2026-08-18-phase4-closeout.md) —— Phase 4 最终验收与收口证据。

早期 [`docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md`](docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md) 与本文件后半的 dated observations 保留为历史决策/事故上下文；其中旧 roadmap、工具数量、Draft PR 等描述不是当前产品状态。

---

## 不得静默推翻的决定

这些是与 Human Owner 逐条确认过的。要改必须先提出并获得确认，不能在实现中顺手变更。

| # | 决定 | 理由 |
|---|---|---|
| D1 | **Runner 只用 macOS Seatbelt（`sandbox-exec`），不引入容器/VM** | 用户明确选择。代价（无资源限制、无镜像 digest 可复现）已知并接受 |
| D2 | **单用户**，不做多租户 / RBAC / 配额 | GrandeGPT 定位于个人开发者/小团队，不扩成企业平台 |
| D3 | **代码工作区在 `GPT_Workspace/`，控制平面状态在 `~/.grande-control/`** | 被审计者不能拥有审计记录的写权限 |
| D4 | **原地模型**：`GPT_Workspace/<project>/` 就是 canonical，不做 bare mirror | 用户要能正常用编辑器干活 |
| ~~D5~~ | ~~每 repo 一个 MCP 端点 `/mcp/<repoId>`~~ | **已被 D18 取代（2026-07-29）** |
| D18 | **单一端点 `/mcp` + 任务绑定隔离**，`/mcp/<repoId>` 保留兼容别名 | 写/跑路径从 `taskId → task.repoId` 推导；只有 `grande_task_open` 与无任务浏览显式指定 `repoId` |
| D6 | **实现语言 TypeScript**，隧道用 Cloudflare Tunnel | MCP 官方 TS SDK 是参考实现 |
| D7 | **不涉及 Codex**，不读写 `~/.codex`，不上架插件目录 | 用户明确约束 |
| D16 | **接入方式 = Cloudflare Tunnel + Server URL + OAuth 2.1(PKCE)** | 不依赖 OpenAI Platform API key |
| D17 | **Production 命名**：`grande.agentjoey.ai` → `127.0.0.1:8787`，主端点 `https://grande.agentjoey.ai/mcp` | 已实测跑通 |

## 当前状态：Phase 4 已完成

Golden Path：

```text
Request
→ inspect repo
→ TaskBrief / acceptance criteria
→ code + local verify
→ commit + push
→ ready PR
→ CI status / diagnosis
→ expected-SHA merge
→ approved deploy
→ verify
→ DONE
```

Bug、新需求、Issue 与新的 PR feedback 重新创建 Task，继续走同一条闭环；不建设独立 Requirement Management、Release、Incident 或 Deployment Platform。

### 当前工具面

**23 个 MCP tools：9 read-only / 14 write。** Task 始终是核心执行对象，仓库由 `taskId` 单向推导。

核心开发工具：

- `grande_task_status` / `grande_repo_map` / `grande_repo_search` / `grande_repo_read`
- `grande_task_open` / `grande_repo_edit` / `grande_rollback` / `grande_diff`
- `grande_run` / `grande_run_result`
- `grande_commit` / `grande_sync_base` / `grande_push`
- `grande_pr_open` / `grande_pr_status` / `grande_pr_merge`
- `grande_deploy` / `grande_deploy_verify` / `grande_deploy_rollback`
- `grande_capability_list` / `grande_capability_inspect` / `grande_capability_invoke`
- `grande_task_close`

Phase 4 的关键更新：

- S4：`grande_task_open` 可附带 TaskBrief（source/findings/plan/acceptance criteria），不新增 Requirement 对象；
- S5：提供薄 capability `list / inspect / invoke`，production/destructive 必须显式放行；
- S6：新 PR 固定 **ready (`draft:false`)**；CI/attestation 绑定当前 head SHA；Checks API 403 时回退同一 `head_sha` 的 Actions workflow runs；merge 携带 expected head SHA；
- S7：deploy/verify 只调用 repo 声明且控制平面批准的 profile/capability，只有 deploy + verify 成功才 DONE；
- production Gateway：macOS 用户级 LaunchAgent `ai.agentjoey.grande-gateway`，登录自启 + KeepAlive，仍只监听 `127.0.0.1:8787`。

`openWorldHint=true` 的当前精确名单：
`grande_push`、`grande_pr_open`、`grande_pr_status`、`grande_pr_merge`、`grande_deploy`、`grande_deploy_verify`、`grande_deploy_rollback`、`grande_capability_list`、`grande_capability_inspect`、`grande_capability_invoke`。

`destructiveHint=true` 的当前精确名单：
`grande_task_close`、`grande_pr_merge`、`grande_deploy`、`grande_deploy_rollback`、`grande_capability_invoke`。

### 当前 CLI

**9 个顶层 CLI 子命令**：`status`、`jobs`、`audit`、`doctor`、`gateway`、`gc`、`outer-test`、`revoke`、`selfcheck`。

`gateway` 下提供 `install / start / stop / restart / status / uninstall`，用于管理 production LaunchAgent。

### 验证纪律与最终证据

自举开发继续使用 `unit-selfhost + typecheck`，合并前必须在宿主执行 `grande outer-test --run`。
Phase 4 closeout 的最终证据：

- `unit-selfhost`：**53 files / 566 tests passed**；
- `typecheck`：passed；
- host `outer-test`：**5 files / 132 tests passed**；
- Node v24.14.0 默认 strip-only production runtime regression：passed；
- production `selfcheck`：**HTTP 200 / 23 tools**；
- LaunchAgent：`state=running`，真实 Node listener 位于 `127.0.0.1:8787`；
- PR #1/#2/#3 全部 merged，#2/#3 由 GrandeGPT 自己完成 `pr_status → pr_merge`。

### 基础设施

- OAuth 2.1 + PKCE(S256) + DCR + refresh 轮换（含复用检测），单一 `/mcp` 端点；
- Cloudflare Access 门禁挡在 `/authorize` 第一行，配置缺失 fail-closed；
- macOS Seatbelt：`deny default` + `deny network*`，写只放行本任务 worktree；
- 审计账本（PENDING→ALLOWED→EXECUTING→终态，CAS 推进），启动时 job + worktree 双向对账；
- production Gateway 由 launchd 常驻，日志写入 `~/.grande-control/logs/`。

---

## 历史观察与事故复盘

**以下内容按原日期保留。数字、工具数量、roadmap 和策略描述是当时快照；与当前状态冲突时，以本文件顶部、README、Phase 4 规格和 closeout 为准。**

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
| ~~1~~ | ~~`task_close` 的守卫写 `j.state === "running"`~~ **已修（2026-08-06）**。`jobs.ts` 的 `TERMINAL` 改为从 `contract.ts` 推导并导出 | 机械扫描找出的**不止那一处**：`toolsCore.ts` 的 task_close 守卫与 run_result 的 hint、`runner.ts` 的 jobReport、`consoleRoutes.ts` 的 kill 路由，共 4 处。其中 kill 路由的 `!== "running"` 方向是反的——新增非终态会被当成「已结束」而拒绝杀。`tests/jobStatePattern.test.ts` 扫 `src/` 钉住这条 |
| 2 | GC 方向 A 只认「完全没有 task 行」。`CLOSED` 但目录残留（`removeWorktree` 在 `branch -D` 抛错）两个方向都看不见 | 由 w1 在 s05-3 报告里主动提出，规格合规，候选第三种情形 |
| 3 | `grande_repo_search` 的 `truncated` 信号被模型忽略过一次（未跟进 `nextCursor`） | 观察项，**单次样本**，不足以定性 |
| ~~6~~ | ~~`repoEdit` 里 `const taskId = basename(root)`~~ **已修（2026-08-06）**：新增必填的第五个形参 `ctx: EditContext`（`{layout, taskId}`）| 生产调用点只有一个（`toolsCore.ts`），原注释说的「避免扩散到所有既有调用点」指的其实是 28 处测试。行为证据：故意让 `basename(root)` 与 `ctx.taskId` 不一致，checkpoint 跟着 ctx 走 |
| ~~7~~ | ~~`repoEdit` 里调 `loadLayout()`~~ **已修（2026-08-06）**，与 #6 同一个 `ctx` 参数 | `repoFile.ts` 现在只 `import type { Layout }`，不再读全局配置 |
| 8 | 历史 S0 文档仍写着 `repo_edit` 不支持 delete | 已被 S1 规格取代；实现者主动标注过，未做全仓历史文档改写 |
| 9 | **备份（Backlog，不着急）** —— 目标：本地 NAS。两件独立的事，优先级相反：① **控制平面 `~/.grande-control/`（26M）不在任何 git 仓库、无版本控制**，其中审计账本按定义不可重建；⚠️ `secrets/` 绝不能进备份仓库，需要排除方案。② `grande-gpt` 代码无 remote——注意**设计文档也在这个仓库里**，机器挂了一起丢 | Human Owner 已定：放 backlog，走本地 NAS |
| 10 | **PAT 配置已确认正确**（截图核对）：Repository access 只有 `agentjoey/urbanbricks-poc`、无 user permissions、Repository permissions 是 metadata:R + code/commit statuses/deployments/PR:RW，2026-10-28 过期 | ⚠️ **`deployments` 与 `commit statuses` 写权限本切片用不到**，可以收掉（低优先）。另：`GET /user/repos` **不能**用来验证 fine-grained 授权范围——公开仓库对任何已认证 token 都可读（实测该 token 能读 `torvalds/linux`），该端点会把「公开可读」和「已授权」混在一起。**权限授予只能在设置页看** |
| ~~11~~ | ~~**`unit-selfhost` 排除的 5 个文件，其不变量在自举时完全失去保护**~~ **已加 `grande outer-test`（2026-07-30）** | S2 实测撞上：工具计数从 11 变 13，`tools.test.ts` 的计数不变量红了而实现者看不见。这次后果轻，下次可能是安全断言。**建议加一个 `grande outer-test` CLI 子命令**，让「该跑外层了」有机制提醒，而不是靠人记得 |
| ~~12~~ | ~~**`readOnlyPaths` 一条规则都没配**，实测 `grande_repo_edit` 能写 `.github/workflows/**`~~ **已配（2026-07-30）** | 全局规则写在 `~/.grande-control/config/deny.yaml` 的 `readOnlyPaths`（该文件此前只有 `prefixes`）。判定原则：**内容会在沙箱之外被执行或被信任的路径一律只读**。12 条双向探针实测（8 拒 + 4 放行无误伤）。存档副本 [`docs/reference/control-plane-config/deny.yaml`](docs/reference/control-plane-config/deny.yaml)。⚠️ 有意保留的缺口：`package.json` 的 `postinstall`/`prepare` 同样在沙箱外执行，但设成只读会让绝大多数正常任务做不了 |
| ~~13~~ | ~~**schema 校验失败折叠成 `INTERNAL`。**~~ **已修（2026-08-06）**：新增 `src/argCheck.ts`，在 `tools.ts` 的**唯一出口**给每个 handler 前置校验。`{taskId, edits: []}` 现在返回 `INVALID_INPUT`：「缺少必填参数：ops；不认识这些参数：edits。（名字写错了？）该工具接受的参数是：ops、taskId。」 | **三类问题必须一起报**——只说「缺少 ops」的话，传了数组却被告知「缺数组」的人只会以为格式不对，看不出真正的问题是名字写错了。`INTERNAL` 兜底本身未削弱（`tests/errors.test.ts` 直接钉住），只是不再被参数错误触发 |
| ~~14~~ | ~~**没有「连 refresh token 一起吊销」的命令。**~~ **已做（2026-08-05）**：控制台 `/connections` 的「彻底断开」= epoch + 清 refresh 两步合一，经 Gateway 执行并进审计账本。CLI 的 `grande revoke` 仍只做前一步 | `grande revoke` 只切 access token；refresh 仍能换新的 | 单用户下影响有限（refresh 也在你自己机器上），但「彻底断开」目前仍要手改 `oauth_refresh`。`revoke` 的输出已明说这一点，不假装断干净了 |
| ~~4~~ | ~~**`tools/list` 未进日志**；且没有「客户端视角」自检手段~~ **已做（2026-08-07）**：① `[rpc]` 方法级日志（方法名 + id，tools/list 另带工具数）；② `grande selfcheck` —— 自签一枚 60 秒 token，向【正在运行的】网关问一次 tools/list，按 `readOnlyHint` 分组打印全表 | `tools/list` 由 SDK 内部应答，`registerTool` 的回调只在 `tools/call` 触发，所以 `[tool]` 那行天然看不到它。日志**不记参数**（`[tool]` 已记过，再记一遍等于把文件内容写两次）。selfcheck 必须走真实 HTTP：中间隔着 bearer 校验、epoch 检查、MCP 序列化，分叉恰恰是要找的东西 |
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

#### 由此暴露的两个待办 —— **已补（2026-08-07，遗留 #4）**

| # | 缺口 | 现在 |
|---|---|---|
| 1 | **`tools/list` 没有进日志。** 只有 `POST /mcp → 200`，看不出客户端取过几次工具表、拿走了什么 | `[rpc]` 一行记方法名 + id，`tools/list` 另带工具数 |
| 2 | **没有「客户端视角」的自检手段。** 唯一办法是让模型自己报它看得见什么——这不该是排查时才临时想起来的招 | `grande selfcheck` |

**`grande selfcheck` 就是当年那一步的固化。** 它自签一枚 60 秒 token（签名密钥本来就在
`~/.grande-control/secrets/`，能跑 `grande` 的人一直做得到，这不打开新的门），向**正在
运行的**网关问一次 `tools/list`，然后按 `readOnlyHint` 分两组打印——那正是当年把三个
假设收敛到一个变量的那张表。首次实测输出：

```
HTTP 200 · 11326 字节 · 15 个工具：6 只读 / 9 写
触网工具  grande_push、grande_pr_open
破坏性工具 grande_task_close
```

11,326 远低于 POC 实测的 ~73,896 字节上限——**「响应被静默截断」那个假设一条命令就否掉了**。
⚠️ 它**必须**连真实运行的网关，连不上就说连不上：直接 `buildTools()` 打印一遍是「我们以为
客户端看到什么」，而中间隔着 bearer 校验、epoch 检查、MCP 序列化，分叉恰恰是要找的东西。
⚠️ 那枚 token **绝不打印、绝不写盘**——一枚有效 bearer 落进终端回滚区，等于把「只有本机
能做」变成「谁看过这块屏幕都能做」。

### Token epoch：让「吊销」名副其实（2026-07-30，schema v5）

`verifyBearer` 原先**一次库都不查**——只验签名/issuer/aud/过期。access token 是 8 小时
无状态 JWT，而 `assertApproved`（Cloudflare Access）**只挂在 `/authorize`**，`/mcp` 只有
bearer 一道。后果：一枚泄漏的 token 能从公网调用全部 15 个工具、最长 8 小时，
**而当时没有任何 revoke 能力**（`吊销` 只出现在 refresh 链的复用检测里，
且吊销 refresh 完全不影响已发出的 access token）。

现在签发时写入 `epoch` claim，`verifyBearer` 每次与库里的当前值比对。
**每请求一次 SQLite 读，不缓存**——缓存多久 revoke 就迟多久生效，那正是本特性要消灭的。

三个有意的取舍：
- **全局，不分 client**（D2 单用户，今天只有一个 client）
- **claim 缺失一律拒绝**，不当作「老 token 放行吧」——上线前签发的恰恰是最该切断的一批
- **refresh token 不受影响**，它们仍能换出新 access token。`revoke` 的预演输出明写了这点，
  否则会让人以为一条命令就断干净了。要连 refresh 一起断目前仍需手工（见遗留表）

⚠️ 跨进程可见性是这个特性成立的前提（网关长跑，`revoke` 是另一个进程），
已实测：WAL 下独立进程写入后，网关同一个连接**下一次读立即**看到新值。

### 全局写入门禁：只读路径（2026-07-30 首次实际配置）

生效文件是 **`~/.grande-control/config/deny.yaml`**（不是 `policy.yaml`——那个名字不存在）。
它同时承载 `prefixes`（AC-14 拒绝表）与 S1.5 的 `readOnlyPaths` / `pairedEdits`。
仓库内的 `<repo>/.grande/policy.yaml` 只能在其上**继续收紧**。

**判定原则只有一条：内容会在沙箱之外被执行或被信任的路径，一律只读。**
沙箱管得住 `grande_run`，管不住 GitHub runner、你本人在 canonical 里的 git 操作、
你手工跑的 `pnpm install`。当前 8 条规则分四组：CI（`.github/workflows|actions/**`）、
宿主 git hooks（`**/.husky|.githooks/**`）、门禁自身（`.grande/policy.yaml`）、
安装期执行（`**/.npmrc`、`**/.pnpmfile.cjs`）。

⚠️ **`package.json` 的 `postinstall`/`prepare` 是有意保留的缺口**——它同样在沙箱外
执行，但把 `package.json` 设成只读会让 GrandeGPT 无法做绝大多数正常任务。缓解是
GrandeGPT 自己跑不了 `pnpm install`（profile 是 argv 白名单），要生效必须你手工装一次。

glob 是 Node 内置 `path.matchesGlob`，已实测：`a/**` 匹配 `a/x` 与 `a/n/x`；
`**/x` 在仓库根也匹配；比对大小写不敏感（APFS）。

### ⚠️ 网关曾绑在所有网卡上，而日志说它绑在 127.0.0.1（2026-08-02 实测修复）

`serve({ fetch, port })` 不带 hostname 时 `@hono/node-server` 绑的是**所有网卡**。
实测：同一 Wi-Fi 上用本机 LAN IP（`192.168.0.14:8787`）能直接连到网关。

核心防线没破——`/mcp` 仍要 bearer（401）、`/authorize` 仍要 Access JWT（403）。
**但「隧道 + Cloudflare Access 是唯一入口」这个纵深防御假设是假的**，
而本文件与多份设计一直是那么写的。`/register`（DCR）更是完全没有门禁。

**而 `main.ts` 里那行 `[gateway] listening on 127.0.0.1:${port}` 是硬编码的字符串**——
它恰恰是「以为只绑了 loopback」这个错误认知的来源。现在打印实际值。

已改为显式 `hostname: "127.0.0.1"`（`GRANDE_HOST` 可覆盖，留给测试）。
`tests/server.test.ts` 有一条行为断言：从本机 LAN IP 连不上、从 loopback 连得上，
带 load-bearing 证明（拆掉 hostname 即变红）。隧道不受影响——
`~/.cloudflared/grande-gpt.yml` 指的是 `http://localhost:8787`。

**这是「文案说一套、实现是另一套」在 grande-gpt 里的一例。** 同期在 console 里
连续出现四次（告警判据、节奏条配色、图表状态集合、CSS 注释的覆盖范围）。
教训：**凡是在注释/日志/文案里断言实现行为的地方，都要有一条测试钉住那句话**，
否则它只是一句愿望。

⚠️ **第 7 次（2026-08-06，`argCheck.ts`）**：我在注释里写「『缺少 ops』和『不认识
edits』要一起说」，紧接着的实现却在第一条命中就 `throw` 了。**先写的测试逮住了它**
——这是这条教训第一次真的起了作用，而不是事后才被发现。

⚠️ **第 8 次（2026-08-06，`repoFile.test.ts`）**：我写了一条测试断言
`repoEdit.length === 5`，注释说它「同时钉住了五个参数和五个都必填」。
**后半句是假的**：`Function.length` 只对 `x = 默认值` 敏感，对 TS 的 `x?: T`
不敏感——类型层的 `?` 在 strip-types 之后被整个抹掉。实测把签名改成
`ctx?: EditContext` 之后 `.length` 仍是 5，那个文件 37 条测试全绿。

**是 load-bearing 证明抓住的**，不是审查。教训因此要加一句：
**写完「这条测试钉住了 X」之后，必须真的把 X 破坏一次看它红不红**——
否则你钉住的可能只是你以为的那件事。这条对形状/结构类断言尤其重要，
它们最容易在「看起来对」和「真的对」之间滑过去。

### ⚠️ 测试替身会让整整一层变成 no-op（S3 宿主验收，2026-07-30）

`grande_push` 从未真正推成功过一次，而 606 个测试全绿。原因不是漏改、不是空转测试，
而是 **S3 的测试全部推向本地 bare 仓库——那里根本不需要认证，`Authorization` 头被
完全忽略。** AC-S3-4「push 后 bare 仓库的 sha 等于任务分支的 sha」在认证完全错误的
情况下照样通过。断言正确、非空转、也没写错，只是它验证的东西里**不包含认证**。

**一般化：凡是「用本地替身代替远端」的测试，都要问一句「这个替身是否让某一层变成了
no-op」。** 本地 bare remote 让认证层变 no-op；本地 fixture 让网络层变 no-op；
`/dev/null` 让写入层变 no-op。这类缺陷单元测试天然抓不到，**必须有一次真实对端的
端到端验证**，而且要**从对端独立核对**，不能只看工具自己的返回值。

同类形状已知三个：①「模块写好但没接上线」（出现 5 次，P-A 探针）②「沙箱内 hook 拿
EPERM 导致 hook 测试假阴性」（S2/S3）③ 本条。

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
└── state/grande.db · config/ · artifacts/ · checkpoints/ · secrets/ · logs/
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
