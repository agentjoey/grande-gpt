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

## 相关已确认问题：`grande_sync_base` 的公开语义会误导同步方向

**状态**：Open  
**优先级**：P1（语义契约 / 可诊断性；会放大本页 P0 stale-canonical 问题）

`grande_sync_base` 当前公开描述为：

> 把任务分支同步到本机 canonical HEAD。

这句话容易被理解为“把 task 的结果同步回 canonical”，但实际实现完全不会写 canonical。`src/syncBase.ts` 的真实方向是 **local canonical → task worktree**：

1. 读取 local canonical HEAD；
2. 若 canonical HEAD 已是 task HEAD 的祖先，则返回 `action=up-to-date`；
3. 若 task 没有自己的提交，则在 **task worktree** 中 `merge --ff-only <canonical>`；
4. 若双方都有提交，则仍在 **task worktree** 中 merge canonical；
5. canonical checkout 全程不被修改。

因此当前 `up-to-date` 的真实含义不是“task HEAD 与 canonical HEAD 相等”，而是：

> **task 已经包含当前 local canonical 的历史，不需要再把 canonical 合进 task。**

这个差异已经实机复现。2026-08-19 调用 `grande_sync_base` 时：

- task HEAD：`8446ff8aa2d82ff3423ea110114c3b1d8dff3788`
- canonical HEAD：`c5c4c348ce28f9132c4e8a3d2657fef3cfbfb4c2`
- 两个 HEAD 明显不同；
- 工具仍返回 `action=up-to-date`，并给出 hint：`已与本机 canonical HEAD 保持一致，无需同步。`

该 hint 的“保持一致”会进一步误导用户/模型把“canonical 是 task 的祖先”理解成“canonical 已追上 task / 两边 HEAD 一致”。在刚发生“PR 已 merge，但 local canonical 仍旧”的场景里，这尤其危险：它会掩盖真正需要解决的是 **canonical 本身 stale**，而不是 task 需要 sync base。

现有 `tests/syncBase.test.ts` 只覆盖了“task HEAD == canonical HEAD 时返回 up-to-date”的平凡情形，没有覆盖“task HEAD 领先、canonical 只是其祖先”这一条真实语义，所以当前文案误导不会被测试抓住。

最小后续修复应包括：

- 把 tool description 改成方向明确的表述，例如“把**本机 canonical HEAD 合入/快进到 task worktree**；绝不修改 canonical，也绝不 fetch”。
- 把 `up-to-date` hint 改成“不需要把当前 local canonical 合入 task；task 已包含 canonical HEAD”，避免暗示 HEAD equality。
- 响应继续保留并突出 `before` / `after` / `canonicalHead`，让调用方能直接看出两边是否相等。
- 新增回归测试：canonical 是 task 祖先但两个 HEAD 不同 → `action=up-to-date`，且用户可见 hint 不得声称“两边一致”。
- 不把 `grande_sync_base` 改造成 task → canonical 的写入工具；canonical refresh 是本页 P0 的另一条受控语义，不能混在同一个工具里。

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
- `grande_sync_base` 的公开描述明确为 canonical → task，不再让人误读为 task → canonical。
- canonical 是 task 祖先但 HEAD 不相等时，工具仍可返回 `up-to-date`，但 hint 必须准确表达“task 已包含 canonical”，不得声称两个 HEAD 已一致。
