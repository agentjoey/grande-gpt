# S2 实施计划 · 本地开发闭环（由 ChatGPT 经 GrandeGPT 执行）

**设计文档** [`../specs/2026-07-30-grande-gpt-s2-design.md`](../specs/2026-07-30-grande-gpt-s2-design.md)
**仓库** `grande-gpt` · **验收 profile** `unit-selfhost` + `typecheck`

> ## ⚠️ 不要用 `unit`
>
> 本仓库有 5 个测试文件（`sandbox` / `runner` / `server` / `tools` / `e2e`）自己要
> spawn `sandbox-exec` 或绑真实端口。在沙箱里跑它们等于**嵌套沙箱**，内层只能比外层
> 更严，**结构上不可能通过**。一律用 `unit-selfhost`。那 5 个由 Human Owner 在沙箱
> 外跑 `pnpm test` 覆盖。

> **与 S1 相比你多了两件武器**：`repo_edit` 现在支持 `delete`（需 `expectedSha256`），
> 而且每次 `repo_edit` 返回 `checkpointId`，写错了可以 `grande_rollback` 回去。
> 先读设计文档 **§0**。

---

## 开工前

```
grande_task_open { repoId: "grande-gpt", slug: "s2-local-loop", taskId: <你自己起> }
```

**每次继续工作的第一件事**：`grande_task_status` + `grande_diff`。
**不要凭记忆判断进度。**

## 通用规则

1. 改已有文件前先 `grande_repo_read` 拿 `sha256`，`modify`/`delete` 时带上。
2. 一次 `repo_edit` 里同一路径只能出现一次。
3. **每个任务结束跑 `unit-selfhost` + `typecheck`**，两个都绿才算完成。
4. 测试断言**真实状态**（文件内容、git 历史、数据库行），不是「函数返回了对象」。
5. `grande_run` 立即返回 `jobId`，用 `grande_run_result` 轮询到终态。

---

## 任务 S2-1 · `grande_commit`（**含本切片最关键的安全要求**）

**改** `src/toolsCore.ts`，**新建** `src/commit.ts`、`tests/commit.test.ts`。

### ⚠️ 先读这一段，它决定这个任务做对还是做成一个漏洞

`git commit` 会执行 hooks，而 commit 跑在 **Gateway 进程里**（沙箱之外）。
`.git/hooks/` 写不进去（`policy.ts` 的 `BUILTIN_PREFIXES` 硬拒），**但 `core.hooksPath`
可以把 hooks 指向仓库内被跟踪的目录**，而那是很多项目的正常做法。

**这条链已实测走得通**：仓库提交 `.githooks/pre-commit` + 设 `core.hooksPath=.githooks`
→ 模型用 `repo_edit` 写那个文件（普通被跟踪文件，`.git/` 的硬拒盖不到）
→ `grande_commit` 在沙箱外执行它。**这是完整的沙箱逃逸。**

**所以每一次 git 调用都必须带**：

```
git -c core.hooksPath=/dev/null ...
```

**不要用 `--no-verify`** —— 它文档上只保证跳过 `pre-commit` 与 `commit-msg`。
`core.hooksPath` 覆写无条件杀掉全部 hook，对将来新增的 hook 类型也成立。

### 要实现的

```ts
export interface CommitResult { commit: string; message: string; filesChanged: number }

/** 把 worktree 的全部改动提交到任务分支。绝不执行 hooks。 */
export function commitWorktree(
  layout: Layout, worktreePath: string, taskId: string, message: string,
): CommitResult;
```

工具侧：`grande_commit { taskId, message }`，注解
`{ readOnlyHint: false, destructiveHint: false, openWorldHint: false }`。

### 硬性要求

- **每一条 git 命令都带 `-c core.hooksPath=/dev/null`**，不只是 commit 那一条
- **身份从控制平面读**（`~/.grande-control/config/` 下新增一个字段或文件，你定形状但
  要写进注释）。用 `-c user.name=... -c user.email=...` 传，**绝不写进任何 `.git/config`**。
  配置缺失 → **fail closed**，拒绝提交并说清要配什么。**不要猜默认值**
- **不接受路径参数**，提交范围就是整个 worktree 的改动（铁律二：部分暂存是逃生舱入口）
- 无改动 → 明确报错，不产生空提交
- **message 尾注**：在模型给的正文后追加
  ```
  Grande-Task: <taskId>
  Grande-Attestation: <attestationId 或 none>
  ```
  **模型正文里若已出现这两个键，必须剥掉再追加**——否则模型能伪造「已验证」。
  这条要有测试钉住
- 写审计账本
- **铁律二**：git 一律 argv 数组

### 测试

1. **AC-S2-1（最重要）**：仓库里放一个**被跟踪的** `.githooks/pre-commit`，内容是
   「写一个标记文件到 worktree 之外」，并 `git config core.hooksPath .githooks`。
   `grande_commit` 之后**断言那个标记文件不存在**。
   这是行为断言——不要写成「命令行里包含 hooksPath」那种形状断言
2. **AC-S2-2**：身份配置缺失 → 拒绝，且 `git log` 里**没有新 commit**
3. **AC-S2-3**：无改动 → 报错，无空提交
4. **AC-S2-4**：模型 message 里自带 `Grande-Attestation: forged` → 最终 message 里
   该键**只出现一次**且值不是 `forged`
5. **AC-S2-5**：写了审计账本
6. commit 之后 `git log -1` 的 author/email 等于控制平面配置的值

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S2-2 · Verification Attestation

**新建** `src/attestation.ts`、`tests/attestation.test.ts`；改 `src/db.ts`（新表）。

### 要实现的

一张新表 + 签发函数：

```
attestation(
  attestationId, taskId, commit, profile, jobId,
  exitCode, startedAt, endedAt, hostToolchain   -- JSON
)
```

`hostToolchain` = `{ node, pnpm, lockfileSha256 }`，三个都要**真实值**。

### 硬性要求

- **`db.ts` 的 `SCHEMA_VERSION` 必须 +1。** 本项目有版本门禁，加表不升版本会让下次
  启动直接拒绝（这是设计如此，不是 bug）
- **核心校验**：attestation 绑定的是**提交后的 sha**，而 `grande_run` 跑的是未提交的
  工作区。只有在「run 之后到 commit 之间工作区没再变过」时，这个绑定才成立。
  **变过就不签发**，如实说明原因。判据你自己定（例如 run 启动时记录
  `git status --porcelain` 的哈希，commit 时比对），但要在注释里写清判据是什么
- **措辞诚实**：这是「本机验证记录」，**不是可移植的证明**。没有镜像 digest 就没有
  跨机可复现（规格 §868）。不要在任何返回值或文档里写「证明」「保证」

### 测试

1. **AC-S2-6**：`run` 通过 → `commit` → attestation 的 `commit` 字段 == 新 sha
2. **AC-S2-7**：`run` 之后改了工作区再 `commit` → **不签发**，原因明确
3. **AC-S2-8**：`hostToolchain` 三个字段都非空、不是 `"unknown"`
4. schema 版本已 +1，且旧版本库启动时被门禁拒绝（沿用既有的版本测试形状）

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S2-3 · base 分歧检测

**改** `src/toolsCore.ts`（`grande_task_status`）、对应测试。

### 要实现的

`grande_task_status` 的返回增加：

```
base: { baseCommit, behind: number, diverged: boolean }
```

- `behind` = canonical 的默认分支比 `baseCommit` 多几个 commit
- `diverged` = 任务分支也有自己的新提交（双向都走了）

**只报告，不做任何事。**

### 硬性要求

- 用 `git rev-list --count` 一类，**argv 数组**
- ⚠️ **注意 merge commit 会让计数超出直觉**。本仓库实测：`git rev-list --count HEAD~3..HEAD`
  返回的是 **4** 而不是 3——`HEAD~3` 走的是第一父级，而范围里的 merge commit 把另一侧
  的祖先也带了进来。你要的语义是「canonical 相对 `baseCommit` **多出**多少个 commit」，
  正确的形状是 `git rev-list --count <baseCommit>..<canonical分支>`（两点，从共同祖先算），
  **不是** `HEAD~N..HEAD`。测试夹具用线性历史能通过，真实仓库有 merge 就会错——
  所以**测试里要专门造一个带 merge 的历史**验这一条
- canonical 处于异常状态（detached HEAD 等）时不要崩，如实返回未知
- **不要为此调 `git fetch`**（规格 §5.4①：大仓库上 fetch 可能几十秒，撑爆 60s 超时）

### 测试

1. **AC-S2-9**：在 canonical 上造 3 个 commit → `behind === 3`（断真实数字，不是 `> 0`）
2. 任务分支也有提交时 `diverged === true`
3. 没有分歧时 `behind === 0`

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S2-4 · `grande_sync_base`

**新建** `src/syncBase.ts`、`tests/syncBase.test.ts`；改 `src/toolsCore.ts`。

### 要实现的

```
grande_sync_base { taskId }
注解 { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
```

| 情形 | 行为 |
|---|---|
| 已最新 | 无操作，如实返回 |
| 可快进 | 快进 |
| 需合并且无冲突 | 合并，产生 merge commit |
| **有冲突** | **拒绝**，返回 `MERGE_CONFLICT` 并列出冲突文件 |

### 硬性要求

- **用 merge 不用 rebase。** rebase 冲突会把 worktree 停在「rebase 进行中」——模型
  没有 shell，退不出去。merge 冲突可以整体 `--abort` 回到干净
- **冲突时必须 `git merge --abort`**，保证 worktree 逐字节回到操作前。
  **这是行为断言，不是返回个错误码就算**
- 操作前先建 checkpoint（S1 已有 `createCheckpoint`），失败可回滚
- 同样带 `-c core.hooksPath=/dev/null`（merge 也有 hooks）
- **不 fetch**

### 测试

1. **AC-S2-10**：可快进时快进，worktree 内容正确更新
2. **AC-S2-11**：造一个真冲突 → 拒绝，**且 worktree 逐字节回到操作前**（逐文件比对内容）
3. **AC-S2-12**：无冲突合并成功后，两边的改动都在
4. 已最新时无操作，不产生多余 commit

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S2-5 · `requireGreenBeforeCommit`

**改** `src/repoPolicy.ts`、`src/toolsCore.ts`、对应测试。

### 要实现的

`.grande/policy.yaml` 增加 `requireGreenBeforeCommit: [<profile 名>]`。
`grande_commit` 执行前检查：列出的每个 profile 在**当前工作区状态**上都有一条通过的
attestation。没有 → `POLICY_DENIED`，说清缺哪个。

### 硬性要求

- **沿用「只能收紧」语义**：全局与 repo 取并集，repo 只能加不能减。
  这是 S1.5 唯一不可妥协的不变量，**不要为新字段另写一套合并规则**——
  用现有的 `mergePolicy`
- 拒绝时**不产生 commit**（无副作用）
- 错误消息列出缺哪个 profile，否则模型不知道该做什么

### 测试

1. **AC-S2-13**：未跑过验证 → 拒绝，`git log` 里无新 commit
2. **AC-S2-14**：跑过并通过 → 放行
3. **AC-S2-15**：repo policy 试图移除全局条目 → 该条目**仍生效**
4. 没配置时 `grande_commit` 不受影响

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

# 全部完成后

## 自查（写进报告）

1. **P-A 接线**：每个新增导出是否都有**生产**调用点？逐个列出调用它的文件
2. **P-B 反向测试**：有没有把「当前行为」当规范来断言的？尤其注解与错误码
3. **P-C 同源漏改**：**每一条 git 调用**是否都带了 `-c core.hooksPath=/dev/null`？
   commit、merge、以及你新加的任何一条。**漏一条就是一个洞**
4. **P-D 安全边界**：AC-S2-1 的 hook 抑制在**行为层面**成立吗，还是只断言了命令行字符串

## Load-bearing 证明（必做三条）

改坏 → 确认对应测试变红 → 还原 → 确认变绿。**报告里写清「改坏成什么样、红在哪一行、
报什么错」。**

| # | 改坏什么 | 应该红的 |
|---|---|---|
| 1 | 去掉 `-c core.hooksPath=/dev/null` | AC-S2-1 |
| 2 | 冲突时不 `merge --abort` | AC-S2-11 |
| 3 | attestation 不校验「run 与 commit 之间工作区未变」 | AC-S2-7 |

## 报告要写什么

- 每个任务做了什么、动了哪些文件
- 三条 load-bearing 的**实际输出**（不要只写「通过」）
- 四类探针的自查结果
- **哪些是你实测的、哪些是你推断的**——分开写
- 你认为设计文档写错或写漏的地方

---

## 遇到问题怎么办

- **卡住**：`grande_task_status` + `grande_diff` 看清现状，别凭记忆
- **文档与代码矛盾**：**以代码为准**，并在报告里写出矛盾点。文档是我写的，可能有错。
  S1 那轮你就正确地指出过一处，那次是对的
- **需要新 profile / 做不到的事**：在报告里说明为什么卡住，不要绕路硬上
- **改坏了**：`grande_rollback` 回到某个 `checkpointId`；实在不行 `grande_task_close`
  重开。worktree 是隔离的，正在运行的 Gateway 不受影响
