# S2.5 控制台 · Brief（canonical 记录）

```md
Workflow: 3.3
Task: GrandeGPT S2.5 —— 运维控制台（三页面 + 分档破坏性操作）
Role: Primary Agent
Tier / 理由: T3 —— 同时命中三个触发器：新页面/路由、破坏性操作、认证。不可降级
Canonical record: .agent/frontend-design/s2.5-console/（本目录）
  设计正文：docs/superpowers/specs/2026-07-30-grande-gpt-s2.5-console.md
Branch / worktree: 尚未开分支（仍在阶段① 规范）
Mockup Gate: Required（T3 新页面，工作流 §6② 硬要求）
Review path: 独立 Review Agent（新会话，不继承实现上下文）+ 独立 Verification Agent
Human checkpoints:
  ① §7 A/B/C 三项确认        ✅ 已完成（2026-07-31）
  ② rendered mockup 批准      ← 【当前位置】未开始 production 实现前的硬门禁
  ③ 发布批准（候选 build + 验证证据之后）
```

## 状态

`Approved`（阶段① 规范）—— A/B/C 已定，范围与设计方向已确认。
下一个门禁是阶段② 的 rendered mockup 批准。

**未开始任何 production 实现。** 工作流 §6② 对 T3 的要求是「Human Owner 批准
rendered result 之后才能开始 production 实现」，agent 不得自行豁免。

## 本轮（2026-07-31）新增的事实

三项都来自读代码/实测，不是推断：

1. **`grande revoke --yes` 已实现** —— §3.1 的 D4「无入口」已过时。但它只切
   access token，refresh 仍需手工（拆成 D4 / D4b）。控制台在这里的价值是把
   两步合成一个「彻底断开」。
2. **`readOnlyPaths` 已配置** —— `deny.yaml` 现在承载它，所以 D3「改配置」的
   风险等级实际上升了：改错等于放宽沙箱外执行面。
3. **磁盘占用不能用 `du`，会高估约 40 倍** —— 见 §3.5。实测：`du` 说 597M 的
   一份 `node_modules`，克隆它时卷可用空间只掉 15M。这不是数字不好看的问题，
   是**会驱使用户去删有用的东西来腾出根本不存在的空间**。已写进状态矩阵。

## 2026-07-31 的三项决定

| # | 决定 | 影响 |
|---|---|---|
| A | **「控制台不只是功能控制，也是 dashboard。重新设计。」** | §2 整节重写。上一版从「暴露哪些破坏性操作」出发，页面只有名字没有内容——写着「体检报告」的方向，做的却是操作清单。重写后从**真实账本**出发，§3.3 改为「操作挂在它所属的观察对象上」，不做独立操作面板 |
| B | 加 `/connections` 第四页 | oauth 三张表有了归宿；「彻底断开」（access + refresh 两步）有了落脚点 |
| C | `console.agentjoey.ai` 独立域名 + 独立 Tunnel | `aud` 天然不同，可单独吊销，控制台挂了不影响 MCP |

## 重设计过程中查出的三件事（都来自查真实库，不是设想）

1. **31 failed / 31 passed 的「50% 失败率」是 TDD 的正常节奏**，不是故障。
   朴素 dashboard 会把它渲染成红色告警——纯噪音，且会训练人忽略告警。
   由此定下本设计最重要的约束：**说不清判据的指标不该做成告警**（§6.2）。
2. **账本里有两行真实异常，躺了一天多没人知道**：一行卡在 `INTENT`、
   一行 `decision=PENDING` 而 `state=FAILED`。判据清晰、不需阈值、不会误报——
   这类才配当告警。**我是为了写这份设计去查才发现的，这就是 dashboard 的理由。**
3. **`attestation` 表 0 行** —— S2 的功能做完合并了，3 次 commit 一次都没签发。
   dashboard 修不了它，但正是该让人看见的事实。

## 下一步

阶段② Mockup Gate：四个页面 × 状态矩阵 × 桌面/移动，**用真实数据填充**，附渲染截图。

---

# 阶段② Mockup Gate · revision 1（2026-07-31）

## 制品

`mockup/` 下 8 个 HTML + 7 张渲染截图。预览方式：
`python3 -m http.server 8123` 于该目录，浏览器开 `http://127.0.0.1:8123/overview.html`。

| 文件 | 覆盖 |
|---|---|
| `overview.html` | `/` 有告警状态（2 条真实异常） |
| `overview-empty.html` | `/` 空状态 = 主状态（§6.1 有意图的设计选择） |
| `task.html` | `/tasks/:id` job 时间线 + checkpoint 链 + 杀 job |
| `audit.html` | `/audit` 筛选 + 异常高亮 |
| `connections.html` | `/connections` refresh 链 + 彻底断开 |
| `*-mobile.html` | 移动端分支（断点提为永真 + 容器锁 390px 以便渲染真实的移动 CSS 分支） |

## 数据来源：全部真实，无 Lorem ipsum

截图里每个数字都取自 2026-07-31 的控制平面：236 条审计、103 个 job、
两条真实卡态异常（`op_5e3ed471` / `op_f815ee64`）、3 个 OAuth client、
7 条 refresh（含一条仍绑在 D18 之前 `/mcp/grande-gpt` 别名上的）、
`attestation` 0 行、卷可用 67 GiB。

## 设计红线自查（工作流 §7）

无米色/奶油底（用中性灰 `#fafafa`，刻意避开暖色）· 无 gradient text ·
无 border-left 色条 · 无玻璃拟态 · 无 hero-metric 大数字 · 无 01/02/03 编号眉标 ·
无同尺寸卡片无限重复。单色 + 单一强调色（琥珀 `#b45309`，**只用于告警**）；
`passed`/`failed`/`killed` 用字重与位置区分而非颜色。签名元素只有一处：首屏健康区。

## Human Owner decision（2026-08-01）

**批准 rendered result（mockup revision 1）。** 绑定 target commit `383fb6e`。

我提出的四个开放问题未被逐条回答，因此按我在提问时写明的倾向执行，**并记录在此
以便日后追溯**——若其中任何一条与你的实际意图不符，任务转 `Reopened`：

| # | 问题 | 按此执行 |
|---|---|---|
| 1 | 告警块的「判据」文案是否太长 | **保留**。它是逼设计阶段回答「这真的异常吗」的那个约束，删掉就退回成计数 |
| 2 | 空状态的「最近 7 天」 | **保留但收窄**：只留「被 Policy 拒绝」这条有信息量的，其余三个数字降为一行摘要 |
| 3 | 移动端是否需要账本页 | **需要，但只给「仅异常」视图**；236 行流水在手机上翻不动 |
| 4 | 趋势图 | **不做**。样本量太小，曲线是噪音的可视化 |

阶段② 完成，进入阶段③ 组件实现。

## 实现位置（2026-08-01 决定）

**`GPT_Workspace/grande-console/`，独立目录，不放进 `grande-gpt/`。**

放进 grande-gpt 会把 Next.js / React / Tailwind 拖进一个目前只有 6 个运行时依赖
的仓库；而 `depDirs` 会把 `node_modules` 克隆进每个 worktree，`unit-selfhost`
与 `outer-test` 的工具链也会跟着变——**那是在动一个正在工作的自举系统**。
设计 §5.1 本来就定了独立进程，独立目录是它的自然延伸。

代价：设计文档留在 grande-gpt。两边交叉引用。
附带好处：它本身可以注册成一个 repo，将来让 GrandeGPT 自己维护它。

---

# Reopened（2026-08-01）：增加图形化 dashboard

Human Owner：「为 Console 增加一些图形化的 dashboard，来展示 grande 运行状况。」

这推翻了设计 §2.3 的「不做趋势图表」，按工作流 §4 任务转 `Reopened`。

## 我当时反对的是什么、不反对什么

**反对成立的部分保留**：审计数据只跨 **2 天**（07-29 的 92 条、07-30 的 144 条）。
时间趋势线上只有两个点——连起来的「趋势」是伪造的，不做。

**反对不成立的部分收回**：我当时把「图表」整个否掉了，那是过度。
**构成与分布不需要长时间跨度**，103 个 job、236 条审计足够支撑：

| 图 | 回答的问题 | 样本 |
|---|---|---|
| Job 结果构成（按 profile 堆叠） | 跑的是什么、结果如何 | 103 |
| 时长分布（直方图） | 快慢分布，超时兜底触发过几次 | 103 |
| **RED-GREEN 节奏条**（按任务） | **这个任务是在正常迭代还是卡住了** | 每任务 |
| 工具构成 | 模型实际在用哪些能力 | 236 |

**第三个是这次真正的收获。** 我在文档里用文字论证「31 失败/31 通过是 TDD 不是故障」，
而一条按时间排列的红绿相间条**直接把这件事画出来**——连续红块 = 卡住，红绿相间 = 健康。
判据从「读一段解释」变成「看一眼形状」。

## 偏离工作流 §6③ 的说明

图表用**服务端渲染的 SVG/CSS**，没走 shadcn chart（recharts）。理由：
① 这些是静态构成图，不需要交互，走 recharts 要引入 client component 与约 50KB JS，
而这是个按需打开的运维工具；② shadcn chart 是 recharts 的包装，不是本项目缺的 primitive；
③ 服务端渲染能保持与其余页面一致的密集单色语言。

**颜色纪律不变**：passed 用深墨、failed 用中灰、killed 用强调色（琥珀）。
强调色仍然只给「需要你动手」的东西——超时被杀是真的出了事，TDD 的失败不是。

---

# 写路径：方案 A（2026-08-01 Human Owner 决定）

**控制台调 Gateway 的新 API，Gateway 仍是唯一执行权威。**

## 为什么 A 是对的

铁律二说「没有通用逃生舱，新能力必须先设计高层语义、输入边界、Policy 与审计字段，
再注册为工具」。B（控制台自己开可写连接）会造出第二个执行权威——那正是铁律二要防的。
C（纯只读）则让 §3.3「操作挂在观察对象上」整节作废。

A 的额外好处：每个操作**自动进审计账本**，因为它走的还是 Gateway 那条路径。
控制台自己写库的话，控制台做的事反而不留痕——一个观察工具在账本上隐身，很荒谬。

## 需要 Gateway 新增的（下一个切片，尚未实现）

| 操作 | 语义 | 现状 |
|---|---|---|
| 杀 job | 向进程组发 TERM | 只能手工 `kill -TERM -<pgid>` |
| 回滚到 checkpoint | 已有 `grande_rollback` MCP 工具，需要 HTTP 入口 | MCP 层有，控制台够不着 |
| gc 回收 | 已有 `grande gc --apply` | CLI 有，且看不到「将要删什么」 |
| 彻底断开 | epoch 递增 **+** 清 refresh（两步） | `grande revoke` 只做前一步 |
| 标记为已知 | 向账本**追加**一条人工确认，不改原行 | 无 |

**认证是必须先解决的**：控制台与 `/mcp` 的 `aud` 不同（这是刻意的，防止拿 MCP 令牌
访问控制台）。所以这些端点不能挂在 `/mcp` 下，要一套独立的、按控制台 `aud` 校验的路由。

**未实现。本轮交付的是纯只读版本。**
