# s05-1-taskclose — `grande_task_close` 工具 + worktree/分支回收 + `task_open` 成功信号

**归属**：S0.5 可用性收尾。**不引入新能力，只把已经写好但没接上线的东西接上。**

## 为什么做这个（不是猜的，是实测数据）

```
worktree 累积:  2 个任务 = 722M（urbanbricks 单个约 600M，每任务克隆一次 node_modules）
                没有任何回收路径 —— 用几天就会占满盘
removeWorktree: src/worktree.ts:197 已实现、已测试，src/ 里【零个】生产调用者
TaskState:      "CLOSED" 在 src/tasks.ts:5 的类型里，src/ 里【零处】写入 —— 状态不可达
```

这是本项目第 **6** 次「模块写好但没接上线」。前五次分别是 `reconcileRunningJobs`、
`audit.ts`、`accessGate.ts`、`grande_task_open` 的审计、`awaitJobSettled`。

## 交付物

### ① `grande_task_close` 工具（`src/tools.ts`）

新增第 10 个工具。**严格照抄现有写工具的形状**（参考 `grande_task_open` 与
`grande_repo_edit` 在同一文件里的注册块）：

- **注解**：`{ readOnlyHint: false, destructiveHint: true, openWorldHint: false }`
  - ⚠️ **这一处 `destructiveHint: true` 是对的，不要照着别的写工具改成 false。**
    规格 §5.2 要求写工具是 `false`，是因为「改文件」在任务 worktree 里可回滚；
    而 close 会**删掉 worktree 与分支**，那是真正不可逆的。这是唯一一个
    `destructiveHint: true` 的工具。ChatGPT 的 `Allow low-risk actions` 档会
    对它弹确认框——**这正是我们要的**。
- **入参**：`{ taskId: string }`，`required: ["taskId"]`。**不接受 `repoId`**——
  仓库由 `taskId` 经数据库单向推导（D18）。
- **行为**（顺序不可换）：
  1. `getTask(db, taskId)`；不存在 → `StateError("TASK_NOT_FOUND", ...)`
  2. 若 `t.state === "CLOSED"` → 幂等成功返回，**不**报错、**不**再次删除
  3. **检查该任务有没有还在跑的 job**：`listJobs` 里属于该 taskId 且 state 非终态的
     → 抛 `StateError("JOB_RUNNING", ...)`，消息里带上 jobId，提示先等它结束。
     **不要**去杀 job——那是另一个语义，不在本任务范围
  4. `beginAudit(db, { taskId, tool: "grande_task_close", input: { taskId } })` → `h.allowed()`
  5. `removeWorktree(layout, { repoId: t.repoId, worktreePath: t.worktreePath, branch: t.branch })`
  6. `updateTaskState(db, taskId, "CLOSED")`
  7. `h.ok()`（照抄同文件其它写工具收尾审计的写法）
- **返回**：走 `ok()` 信封，`data` 至少含 `{ taskId, repoId, branch, worktreePath, freedBytes? }`。
  `freedBytes` 可选——如果拿不到就不要放进去，**不要编一个数**。

### ② `task_open` 的成功信号（`src/tools.ts`）

**实测问题**（`docs/research/2026-07-29-ac13-observation.md` §④）：模型把
`grande_task_open` 调了**两次**，第二次因 taskId 重复被 `INVALID_INPUT` 拒。
说明第一次成功后它仍不确定操作是否生效。

改法：`grande_task_open` 成功返回的 `hint` 必须**明确宣告任务已建立并可用**，
并点名下一步该带 `taskId` 调什么。现在的 hint 措辞请先读出来再改——
**只改 hint 字符串，不改任何逻辑**。

### ③ 补 `docs/superpowers/specs/2026-07-25-grande-gpt-s0-design.md` §5.2 的工具表

表格现在是 9 行，加第 10 行 `grande_task_close`。第 2、3 列（readOnly / destructive）
分别是 `✗` / `✓`——它是全表唯一一个 destructive 为真的。

## 测试要求（`tests/tools.test.ts`）

每条都必须是**行为性断言，断言文件系统与数据库的真实状态**，不是形状断言：

1. `task_close` 之后 **worktree 目录在磁盘上消失**，且 canonical 里的 `grande/*` 分支
   也消失（用 `git worktree list` 与 `git branch --list` 实断）
2. `task_close` 之后 task 行的 `state` 是 `"CLOSED"`
3. **重复 close 幂等**：第二次调用成功返回，不抛错、不因为 worktree 已经不在而炸
4. **有 job 在跑时拒绝**：起一个非终态 job，close 抛 `JOB_RUNNING`，且
   **worktree 仍在磁盘上**（拒绝必须是无副作用的）
5. `TASK_NOT_FOUND`：不存在的 taskId
6. `task_close` 写了审计账本（`decision=ALLOWED` 且 state 到达终态）
7. 注解断言：`destructiveHint === true`，且**其余三个写工具仍然是 `false`**
   （防止有人「统一」成一样的）

## 硬性约束

- **铁律二**：git 一律 argv 数组，绝不拼 shell 字符串。`removeWorktree` 已经是这样，
  不要在它之外另起 git 调用
- **不改 `src/worktree.ts` 的 `removeWorktree` 实现**。它已通过测试，本任务只是接线。
  如果你认为它有 bug，**在报告里写出来，不要顺手改**
- **不要碰 `src/cli.ts`**——那是 s05-3 的范围，并发会冲突
- **不要碰 `src/sandbox.ts` / `src/sbpl.ts`**——那是 s05-2 的范围

## verify

`pnpm test && pnpm typecheck`

## 完成前必做

1. **Load-bearing 证明**：至少对测试 1（worktree 真的被删）和测试 4（有 job 在跑时
   拒绝且无副作用）各做一次——把实现改坏，确认对应测试变红，再还原确认变绿。
   把「改坏成什么样、红在哪一行」写进报告
2. 全量 `pnpm test` + `pnpm typecheck`
3. 报告里如实写：哪些是你实测的，哪些是你推断的
