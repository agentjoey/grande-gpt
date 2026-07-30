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
  ① §7 A/B/C 三项确认        ← 【当前卡在这里】
  ② rendered mockup 批准      ← 未开始 production 实现前的硬门禁
  ③ 发布批准（候选 build + 验证证据之后）
```

## 状态

`Draft` —— 阶段① 规范基本完成，卡在 Human Owner 对 §7 A/B/C 的确认。

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

## 下一步

Human Owner 确认 §7 A/B/C → 进入阶段② Mockup Gate。
