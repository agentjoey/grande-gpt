# GrandeGPT S2 设计 · 本地开发闭环

**日期** 2026-07-30 · **前置** S0 / S0.5 / S1 / S1.5 已完成并合并
**上游规格** [`2026-07-25-grande-gpt-s0-design.md`](2026-07-25-grande-gpt-s0-design.md)（§10 路线图）
**实现者** ChatGPT，经 GrandeGPT 自身完成（第二次自举）

---

## 0. 自举约束

### 0.1 与 S1 相比变了什么

| | S1 时 | 现在 |
|---|---|---|
| 删除文件 | **做不到**（S1 正是要加它） | **可以**——`repo_edit` 的 `delete` op 已上线，需 `expectedSha256` |
| 写错了怎么办 | 只能重开任务 | `grande_rollback` + `checkpointId` 可回滚 |
| 验收 profile | `unit-selfhost` + `typecheck` | 不变 |

### 0.2 仍然做不到的

1. **没有 shell**（铁律二，永久非目标）。验证只能经 `grande_run` 跑已注册 profile。
2. **不能新增 profile**——白名单在控制平面，仓库内改不动（铁律一）。
3. **`unit` 在沙箱里永远绿不了**（嵌套沙箱，见 S1 计划开头）。**一律用 `unit-selfhost`。**
4. **`modify` / `delete` 必须带 `expectedSha256`**。
5. **一次 `repo_edit` 里同一路径只能出现一次。**

### 0.3 自举安全性不变

Gateway 跑 canonical 的 `main`；实现者改 worktree。**S2 加的 `grande_commit` 在合并前
对正在服务的 Gateway 不存在**，所以实现过程中它自己用不了 commit——和 S1 时用不了
`delete` 是同一个形状。产出仍由 Human Owner 提交并合并。

---

## 1. 本切片范围

规格 §10 给 S2 的定义是「worktree 生命周期、commit、base sync、Verification Attestation」。

**worktree 生命周期已在 S0.5 提前完成**（`grande_task_close` + `grande gc` 双向对账）。
本切片做剩下三件，外加一件被 commit 解锁的：

| # | 内容 |
|---|---|
| ① | `grande_commit` —— 把任务 worktree 的改动提交到任务分支 |
| ② | **Verification Attestation** —— 「这个 commit 上，这个 profile 跑过并通过了，用的是这套工具链」 |
| ③ | **commit 前必过验证** —— S1.5 policy 的 `requireGreen`，规格 §10.1 就举了这个例子，此前因为没有 commit 而无从实现 |
| ④ | **base 分歧检测与同步** —— 任务开着的时候 `main` 往前走了怎么办 |

**不做**：push、PR、GitHub（属 S3）；冲突的自动解决（见 §4.3）。

---

## 2. `grande_commit`

### 2.1 ⚠️ 安全前提：必须禁用 git hooks

**这是本切片唯一一条不做就有完整沙箱逃逸的要求。**

`git commit` 会执行 hooks，而 **commit 只能在 Gateway 进程里跑**（沙箱 `deny file-write*`
盖住了 `.git`，且 commit 本就不该在沙箱内做）。于是 hook 里的任何东西都在**沙箱之外、
以 Gateway 的身份**执行。

`.git/hooks/` 本身写不进去——`src/policy.ts` 的 `BUILTIN_PREFIXES` 硬拒 `.git/`，
且已经堵掉 `src/../.git/` 与 `vendor -> .git` 两条绕行（注释里写着都**实测写穿过**）。

**但那不够。** `core.hooksPath` 可以把 hooks 指向**仓库内被跟踪的目录**，而且这是很多
项目的正常做法（共享 hooks）。worktree 共享 canonical 的 `.git/config`，于是：

```
已注册仓库设了 core.hooksPath=.githooks   （合法、常见）
        ↓
模型用 grande_repo_edit 写 .githooks/pre-commit   （普通被跟踪文件，.git/ 的硬拒盖不到）
        ↓
grande_commit 执行它 —— 沙箱之外，Gateway 身份
```

**已实测确认这条链走得通**（2026-07-30）：提交一个 `.githooks/pre-commit`、设
`core.hooksPath=.githooks`、在 worktree 里 commit，hook 的输出如期出现在沙箱之外。

**要求**：`grande_commit` 必须用

```
git -c core.hooksPath=/dev/null commit ...
```

**不要用 `--no-verify`。** 它文档上只保证跳过 `pre-commit` 与 `commit-msg`；
`core.hooksPath` 覆写无条件杀掉**全部** hook，且对将来 git 新增的 hook 类型仍然成立。
（两者对 `pre-commit`/`post-commit`/`prepare-commit-msg` 都实测有效，选更强的那个。）

### 2.2 提交身份必须诚实

commit 的 author/committer **不得冒充人类用户**。GrandeGPT 产出的提交必须一眼可辨。

- 身份从**控制平面**读（`~/.grande-control/config/`），不从仓库、不从宿主 git 全局配置
- 用 `git -c user.name=... -c user.email=...` 传，**不写进任何 `.git/config`**
- 配置缺失 → **fail closed**，拒绝提交并说明要配什么。不要猜一个默认值

### 2.3 接口

```
grande_commit { taskId, message }
注解 { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
```

`destructiveHint: false`：提交到任务分支不覆盖任何东西，且 worktree 与分支整体仍可由
`grande_task_close` 回收。**不可逆的只有 `task_close`。**

- **提交范围 = 整个 worktree 的改动**，不接受路径参数。理由同铁律二：部分暂存需要
  表达「哪些文件」的语义，那是 `git add -p` 那一类逃生舱的入口。要分批提交就分批改。
- `message` 由模型给，但**必须追加一段不可伪造的尾注**（任务 id、attestation id），
  见 §3.3。
- 没有任何改动时 → 明确报错，不要产生空提交。

---

## 3. Verification Attestation

### 3.1 要回答的问题

「这个 commit，验证过吗？怎么验的？在什么环境上？」

规格 §868 已经点出根本限制：**没有镜像 digest，跨机不可复现**。所以 attestation
记的是 `hostToolchain`（版本 + lockfile 哈希），**不声称跨机可复现**——它是一份
「本机在此时此刻确实跑过、结果如此」的如实记录，不是可移植的证明。

**不要把它写成「证明」。** 诚实的措辞是「本机验证记录」。

### 3.2 记什么

```
attestation
  attestationId
  taskId
  commit            ← 被验证的 commit sha（关键：不是「跑测试时的工作区」，是提交后的 sha）
  profile           ← 哪个 profile
  jobId             ← 对应的 job
  exitCode
  startedAt / endedAt
  hostToolchain     ← { node, pnpm, lockfileSha256 }
```

**`commit` 字段是整个设计的关键**。目前 `grande_run` 跑的是**未提交的工作区**，
所以「验证过」这句话没有可锚定的对象。S2 之后要能说清：**是哪个 sha 通过了验证。**

时序上只有一种诚实的做法：

```
grande_run（跑在工作区）→ 通过 → grande_commit → 拿到 sha
                                      ↓
                    attestation 绑定这个 sha（因为提交内容 == 刚跑过的工作区内容）
```

**必须校验这个等价关系**：commit 之后，若工作区在 `run` 与 `commit` 之间又被改过，
那次验证就不对应这个 sha。判据是 `grande_run` 启动时记录的工作区状态与 commit 时的
是否一致（例如比对 `git status --porcelain` 的哈希，或记录 run 时的文件集合摘要）。
**不一致就不要签发 attestation**，如实说明原因。

### 3.3 commit message 的尾注

`grande_commit` 在模型给的 message 之后追加：

```
<模型给的正文>

Grande-Task: <taskId>
Grande-Attestation: <attestationId 或 none>
```

模型给的正文里若出现这两个键，**必须剥掉再追加**——否则模型可以伪造一条
「已验证」的尾注。这是一条硬要求，要有测试钉住。

---

## 4. base 分歧检测与同步

### 4.1 问题

任务从 `main` 的某个 `baseCommit` 分叉。任务开着的几小时里 `main` 可能往前走了。
模型对此**完全无感**——`grande_diff` 比的是 worktree vs base，不是 vs 当前 `main`。

### 4.2 检测（先做这个）

`grande_task_status` 增加：

```
base: { baseCommit, behind: <落后几个 commit>, diverged: <bool> }
```

**只报告，不自动做任何事。** 光是让模型知道「你的 base 已经落后 12 个 commit」就有价值。

### 4.3 同步：只做安全的那部分

`grande_sync_base { taskId }`：

| 情形 | 行为 |
|---|---|
| 已是最新 | 无操作，如实返回 |
| 可快进（任务分支没有新提交） | 快进 |
| 需合并且**无冲突** | 合并，产生一个 merge commit |
| **有冲突** | **拒绝**，返回 `MERGE_CONFLICT` 并列出冲突文件 |

**冲突不自动解决，这是有意的。** 模型没有 shell、没有 `git mergetool`；一次半完成的
rebase/merge 会把 worktree 留在模型无法理解也无法退出的状态。**宁可拒绝也不要制造
一个走不出去的现场。**

- 用 **merge 不用 rebase**：rebase 冲突会停在「rebase 进行中」这个模型无法安全退出的
  状态；merge 冲突可以整体 `--abort` 回到干净。
- 冲突时必须 `git merge --abort`，**保证 worktree 回到操作前的状态**。这是行为断言，
  要有测试。
- 同步前必须先建 checkpoint（S1 已有），失败可回滚。

---

## 5. commit 前必过验证（S1.5 的 `requireGreen`）

规格 §10.1 举的硬约束例子里就有「commit 前必过 `unit`」。此前没有 commit，无从实现。

`.grande/policy.yaml` 增加：

```yaml
requireGreenBeforeCommit: [unit-selfhost]    # profile 名字的列表
```

`grande_commit` 执行前检查：列出的每个 profile，**在当前工作区状态上**都有一条通过的
attestation。没有 → `POLICY_DENIED`，消息里说清缺哪个 profile。

**沿用 S1.5 的「只能收紧」语义**：全局与 repo 取并集，repo 只能加不能减。这条不可妥协。

---

## 6. 验收标准

行为性断言，断言文件系统与数据库的真实状态。

### 6.1 commit

| # | 断言 |
|---|---|
| AC-S2-1 | **hooks 不执行**：仓库里有被跟踪的 `.githooks/pre-commit`（会写一个标记文件）且 `core.hooksPath=.githooks`，`grande_commit` 之后**标记文件不存在**。这是本切片最重要的一条 |
| AC-S2-2 | commit 的 author/committer 来自控制平面配置；配置缺失 → 拒绝提交，**且不产生任何 commit** |
| AC-S2-3 | 无改动时拒绝，不产生空提交 |
| AC-S2-4 | message 里模型自带的 `Grande-Attestation:` 行被剥掉，最终 message 里该键只出现一次且值由服务端决定 |
| AC-S2-5 | commit 写审计账本 |

### 6.2 Attestation

| # | 断言 |
|---|---|
| AC-S2-6 | `run` 通过 → `commit` → attestation 的 `commit` 字段等于**新提交的 sha** |
| AC-S2-7 | `run` 之后、`commit` 之前工作区又被改动 → **不签发 attestation**，并说明原因 |
| AC-S2-8 | `hostToolchain` 三个字段都有真实值（不是空串、不是 `"unknown"`） |

### 6.3 base sync

| # | 断言 |
|---|---|
| AC-S2-9 | `main` 前进后，`task_status` 的 `behind` 是**真实的落后数**（构造 3 个 commit，断言 3） |
| AC-S2-10 | 可快进时快进，worktree 内容正确更新 |
| AC-S2-11 | **有冲突时拒绝，且 worktree 逐字节回到操作前**（`git merge --abort` 生效）。这是行为断言，不是「返回了错误码」 |
| AC-S2-12 | 无冲突合并成功后，两边的改动都在 |

### 6.4 requireGreen

| # | 断言 |
|---|---|
| AC-S2-13 | 未跑过验证 → `grande_commit` 被拒，**不产生 commit** |
| AC-S2-14 | 跑过并通过 → 放行 |
| AC-S2-15 | **只能收紧**：repo policy 试图移除全局的 `requireGreenBeforeCommit` 条目 → 该条目仍生效 |

### 6.5 四类探针（每轮必跑）

**P-A 接线** · **P-B 反向测试** · **P-C 同源漏改** · **P-D 安全边界**
（含义见 S1 设计文档 §3.3）

### 6.6 Load-bearing 证明（必做三条）

| # | 改坏什么 | 应该红的 |
|---|---|---|
| 1 | 去掉 `-c core.hooksPath=/dev/null` | AC-S2-1 |
| 2 | 冲突时不 `merge --abort` | AC-S2-11 |
| 3 | attestation 不校验「run 与 commit 之间工作区未变」 | AC-S2-7 |

**通不过 load-bearing 的测试等于没有测试。**

---

## 7. 给 Human Owner 的问题

1. **提交身份用什么？** §2.2 要求从控制平面读且 fail closed。需要你定 name/email。
   建议形如 `GrandeGPT <grande@localhost>`——一眼可辨是机器提交，且不冒充你。
2. **`requireGreenBeforeCommit` 默认开还是关？** 我建议**全局默认关、按 repo 开**，
   因为它会让「先提交一个 WIP 再跑测试」这种正常做法失效。但你可能更想要它默认开。
3. **S2 之后是否仍不 push？** 规格 §2.3 的永久非目标是「直接 push 受保护分支」，
   push 到任务分支属 S3。本切片按「完全不 push」写。
