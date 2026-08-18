# Backlog — PR 已 merge，但 local canonical main 仍旧

**状态**：Open · repeated production observation  
**优先级**：P0（闭环可靠性）  
**范围**：GrandeGPT GitHub merge → 下一 Task 基线

## 问题

GrandeGPT 已多次出现同一类闭环缺陷：GitHub PR 已成功 merge 到 remote `main`，但本机 canonical checkout `GPT_Workspace/<repo>/` 仍停留在旧 HEAD。由于 `grande_task_open` 以本机 canonical HEAD 为新 Task 的 base，而 `grande_sync_base` 也明确“绝不 fetch”，后续 Task 可能在用户没有察觉的情况下从过期代码开始。

这不再视为一次性观察。至少已经在以下流程重复出现：

1. Phase 4 closeout PR 已在 GitHub merge，但本机 canonical README/closeout 文档仍是 merge 前状态，直到人工同步 remote `main`。
2. 2026-08-19 Phase 5 production follow-up backlog PR #7 已 merge；紧接着读取 local canonical 时，刚合并的 `docs/research/2026-08-19-phase5-production-followup-backlog.md` 仍不存在，再次复现同一问题。

## 影响

- 新 Task 可能从 stale canonical HEAD 创建 worktree，遗漏刚 merge 的代码/文档。
- 后续 `grande_sync_base` 只能同步到同样 stale 的 local canonical，不能自行修复。
- Agent 容易误判“PR merged = local canonical 已更新”，导致重复开发、冲突、错误 gap analysis 或不必要的人类介入。
- 破坏 Golden Path 在连续多 Task 场景下的闭环：`merge → 下一 Task` 之间仍存在隐藏的人工作业。

## 期望行为

GrandeGPT 必须让“remote PR 已 merge，但 local canonical 未跟上”成为**显式状态**，不能静默继续。

最小修复方向优先考虑：

1. 在成功 `grande_pr_merge` 后，对该 repo 的 canonical/default branch 做受控 refresh；或提供等价的高层 `canonical refresh` 语义。
2. refresh 只允许固定 `origin` + 当前 canonical/default branch，禁止任意 remote/ref。
3. 仅允许 **fast-forward-only**；canonical 有未提交改动、分叉、非预期 branch 或无法证明安全时必须 fail closed。
4. **禁止** `reset --hard`、force、自动覆盖用户 canonical 改动。
5. 即使暂时不自动 refresh，`grande_task_open` 也应在能可靠判断 remote/local 不一致时拒绝从 stale canonical 静默开新 Task，并给出可操作提示。
6. 修复后需要真实 GitHub/host 级行为验证：PR merge 后独立检查 local canonical HEAD 已更新，且破坏 refresh 机制时测试/探针必须变红。

## 非目标

- 不引入 raw git / shell escape hatch。
- 不把 `task_open` 变成无界、可能超过 ChatGPT 工具超时的大仓库 `git fetch`。
- 不自动处理 dirty/diverged canonical；这些情况必须交还 Human Owner 决策。
- 不建设多 remote / multi-repo sync 平台。

## 完成判据

- 连续两个 Task 场景下，Task A 通过 GrandeGPT merge 后，Task B 不会基于 merge 前的旧 canonical HEAD 启动。
- dirty/diverged canonical 下 refresh 明确拒绝且无副作用。
- remote/local staleness 有可观察诊断，不再依赖 Human 事后发现 README/文件缺失。
