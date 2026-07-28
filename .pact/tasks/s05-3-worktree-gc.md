# s05-3-worktree-gc — worktree 对账 + `grande gc` CLI

**归属**：S0.5 可用性收尾。**依赖 s05-1**（要用它接好的 `removeWorktree` 与 `CLOSED` 语义）。

## 为什么做这个（库和磁盘**现在就已经不一致**）

```
磁盘: urbanbricks/task-ub-probe-20260729-001    ← 库里有，一致
磁盘: grande-gpt/task-fix-greet-20260729-001    ← 库里没有，孤儿
库里: urbanbricks/task-ub-probe-20260729-001
```

那个孤儿是 schema v2→v3 手工迁移时清 `task` 表留下的：目录、git worktree 注册、
`grande/*` 分支都还在，DB 里没有任何一行知道它。

job 有 `reconcileRunningJobs`（`src/jobs.ts`）在启动时对账，**worktree 什么都没有**。
这是同一类缺口只堵了一半——本项目已经犯过两次「同一个修复只改一个调用点」。

## 交付物

### ① `src/worktreeGc.ts`（新模块）

**双向**对账。两个方向的语义完全不同，不要合并成一个循环：

**方向 A：磁盘有、库里没有（孤儿 worktree）**
- 扫 `layout.worktreesRoot/<repoId>/<taskId>/`
- 对每个目录，查 `getTask(db, taskId)`
- 查不到 → 孤儿。可回收
- ⚠️ 回收必须走 `git worktree remove`（经 `removeWorktree`），**不能只 `rm -rf`**——
  canonical 的 `.git/worktrees/<name>` 注册项会残留，下次同名 `git worktree add` 会
  报一个跟真实原因毫无关系的错。这条与 `src/worktree.ts:184` 已记录的教训同源
- ⚠️ 孤儿没有 DB 行，所以拿不到 `branch` 字段。需要从 canonical 反查
  （`git worktree list --porcelain` 能同时给出路径与分支）——**用 argv 数组调 git**

**方向 B：库里有、磁盘没有（幽灵 task）**
- 遍历非 `CLOSED` 的 task 行，`existsSync(t.worktreePath)` 为假
- → 把它标成 `CLOSED`，**不做任何文件系统操作**（已经没东西可删）
- 这是纯数据修复，必须与方向 A 分开计数上报

**导出**：
```ts
export interface GcPlan {
  orphanWorktrees: { repoId: string; taskId: string; path: string; branch: string | null }[];
  ghostTasks:      { taskId: string; repoId: string; worktreePath: string }[];
}
export function planGc(db, layout): GcPlan;              // 只读，绝不改任何东西
export function applyGc(db, layout, plan: GcPlan): { removed: number; closed: number };
```

**`planGc` 必须是纯只读的**——`grande gc` 默认只 plan 不 apply（见下）。

### ② `grande gc` CLI 子命令（`src/cli.ts`）

照抄同文件其它子命令的形状（`cmdAudit` 等）。

- `grande gc` —— **默认 dry-run**，只打印将要做什么，**不动任何东西**
- `grande gc --apply` —— 真正执行
- 输出要人能看懂：分「孤儿 worktree」与「幽灵 task」两段，各自列出条目与合计
- **绝不**默认执行破坏性操作。这是规格铁律三的直接推论

### ③ 启动时的对账（`src/main.ts`）

`reconcileRunningJobs` 已经在启动时跑。**在它旁边加方向 B**（幽灵 task → CLOSED）——
那是纯数据修复、零风险、且不修的话 `grande_task_status` 会一直列出根本不存在的任务。

⚠️ **方向 A（删孤儿 worktree）绝不能自动执行**。删文件必须是人显式 `--apply` 的动作。
启动时只 `console.log` 一行提示有 N 个孤儿、建议跑 `grande gc`。

## 测试要求（`tests/worktreeGc.test.ts` 新建）

用真实临时 git 仓库 + 真实 worktree（`tests/worktree.test.ts` 与
`tests/runner.test.ts` 的 `beforeEach` 就是现成范式，照抄）：

1. **孤儿被识别**：建 worktree → 删 task 行 → `planGc` 报出它
2. **`applyGc` 之后 worktree 目录消失，且 `git worktree list` 里也没了**
   （只断言目录消失是不够的——那正是 `rm -rf` 的漏洞所在）
3. **幽灵 task 被识别并置 CLOSED**，且**没有任何文件系统写操作**
4. **健康的任务不被误伤**：库磁盘都在的任务，`planGc` 两个数组都不含它
5. **`planGc` 是只读的**：调用前后 worktree 目录与 task 行**逐一比对无变化**
6. **`CLOSED` 的 task 不被当成幽灵反复处理**（幂等）
7. `grande gc` 不带 `--apply` 时**不删任何东西**——断言文件系统在命令前后一致

## 硬性约束

- **只改 `src/cli.ts`、`src/main.ts`，新建 `src/worktreeGc.ts`**。
  **不要碰 `src/tools.ts`**（s05-1 的范围）、**不要碰 `src/sandbox.ts`/`src/sbpl.ts`**（s05-2）
- 若 s05-1 还没合进你的基线，`removeWorktree` 也可以直接从 `src/worktree.ts` 用——
  它早就存在。**但不要修改它**
- **铁律二**：git 一律 argv 数组
- 路径处理必须过 `src/paths.ts` 的既有守卫。`taskId` 来自目录名（文件系统可控），
  **必须 `assertTaskId`**——一个 `../../` 形状的目录名会让回收路径逃出 worktreesRoot

## verify

`pnpm test && pnpm typecheck`

## 完成前必做

1. **Load-bearing 证明**：对测试 2（git worktree 注册项真的被清掉）和测试 5
   （planGc 只读）各做一次——改坏 → 红 → 还原 → 绿
2. 全量 `pnpm test` + `pnpm typecheck`
3. **在真实环境上 dry-run 一次**：`GRANDE_WORKSPACE=/Users/xtation/AgentWorks/GPT_Workspace
   node src/cli.ts gc`，把输出贴进报告。它应该报出
   `grande-gpt/task-fix-greet-20260729-001` 这个真实孤儿。**不要 `--apply`**，
   由 orchestrator 决定何时清
