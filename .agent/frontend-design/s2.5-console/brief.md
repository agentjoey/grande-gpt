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

## 待 Human Owner 决定

见对话中列出的四个问题（告警区文案密度、空状态「最近 7 天」的取舍、
移动端是否需要账本页、以及是否接受「不画趋势图」）。

**未开始任何 production 实现。**
