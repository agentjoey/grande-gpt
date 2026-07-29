# GrandeGPT S1 + S1.5 设计

**日期** 2026-07-29 · **前置** S0 与 S0.5 已完成并在真实 ChatGPT 上跑通
**上游规格** [`2026-07-25-grande-gpt-s0-design.md`](2026-07-25-grande-gpt-s0-design.md)（§10 路线图）

> **本切片的实现者是 ChatGPT，经 GrandeGPT 自身完成。** 这是一次真实的自举测试：
> 用 S0/S0.5 建成的十个工具去开发 S1。设计里凡是「实现者做不到」的东西都必须提前
> 消除——见 §0。

---

## 0. 自举约束：实现者能做什么、不能做什么

这一节不是背景说明，是**设计约束**。违反它的任务在真实环境里根本执行不了。

### 0.1 为什么这样做是安全的

| 事实 | 后果 |
|---|---|
| Gateway 进程跑的是 **canonical checkout 上的 `main`** | 实现者把 worktree 里的代码改坏，**正在用的工具不受影响**——它用的是 `main` 的代码 |
| `grande_run unit` 在 **worktree 内**跑 `pnpm test` | 改坏了立刻红，这正是我们要的反馈回路 |
| worktree 与 canonical 物理隔离（D4） | 实现失败最坏结果是丢一个 worktree，`grande_task_close` 一键回收 |

**这条隔离性质是本次自举可行的全部依据。** 合并到 `main` 之前，任何改动都不会影响
正在服务的 Gateway。

### 0.2 实现者的硬限制（设计必须绕开）

1. **不能删除文件。** `grande_repo_edit` 在 S1 之前没有 `delete` op——而 S1 正是要加它。
   **本切片的任何任务都不得要求删除已有文件。** 需要「移除」的语义一律用 `move` 到
   一个明确的废弃位置，或直接留着不动。
2. **没有 shell。** 没有 `shell_exec`（铁律二，永久非目标）。所有验证只能经
   `grande_run` 跑已注册 profile。grande-gpt 目前只有两个：`unit`（`pnpm test`）与
   `typecheck`（`pnpm typecheck`）。**设计不得依赖任何第三个命令。**
3. **不能新增 profile。** profile 白名单在控制平面（`~/.grande-control/config/`），
   仓库内改不动（铁律一）。需要新 profile 必须由 Human Owner 在控制平面加。
4. **`modify` 必须带 `expectedSha256`。** 先 `grande_repo_read` 拿哈希再改。
   跳步会得到 `STALE_FILE`。
5. **一次 `repo_edit` 里同一路径只能有一个操作。** 需要「改两次」就拆成两次调用。
6. **~60s 工具超时。** `grande_run` 立即返回 `jobId`，用 `grande_run_result` 轮询。
   已实测模型会自主轮询到终态（P-1 PASS）。

### 0.3 跨会话恢复

上下文会腐化。**每个任务开工前的第一件事是 `grande_task_status`**（带 `taskId`），
它返回分支、已改文件、最近 job；再用 `grande_diff` 看已经做了什么。
**不要凭记忆判断进度。**

---

## 1. S1 安全写入层

### 1.1 目标与现状差距

规格 §10 给 S1 的定义是「OID 校验、事务 patch、Checkpoint、Trash、删除解禁」。
把它对到当前代码：

| 项 | 现状 | S1 要做到 |
|---|---|---|
| Trash | 不存在（没有删除，也就没有回收站） | 删除的文件进控制平面回收站，可取回 |
| Checkpoint | 不存在 | 每批 `repo_edit` 写盘前快照受影响文件，可整批回滚 |
| 事务 patch | `repoEdit` 已经是「先全校验、再全写」两阶段，但**写阶段中途失败没有回滚**——第 1 个文件已落盘，第 2 个失败，现场是半完成的 | 写阶段任一失败 → 自动回滚到本批开始前 |
| 删除解禁 | `repo_edit` 只有 create / modify / move | 加 `delete`，经 Trash |
| OID 校验 | `expectedSha256`（内容字节的 sha256）已实现并生效 | **本切片不做，见 §1.6** |

### 1.2 事务性不是独立特性，是 Checkpoint 的一个用法

**先说清楚这一点，免得实现者去造两套机制。**

POSIX 上跨多个文件的原子写是做不到的：`rename` 单文件原子，多文件之间没有屏障。
所谓「事务 patch」在本架构里的诚实实现只有一条路：

```
写盘前 → 建 checkpoint（快照本批受影响的每个路径）
逐个写 → 任一步抛错 → 用 checkpoint 回滚 → 把原始错误抛出去
全部成功 → 返回 checkpointId（供之后人工/模型主动回滚）
```

所以实现顺序是 **Trash → Checkpoint → 接进 repoEdit（事务性随之而来）→ delete**。
反过来先做「事务 patch」会发现无从下手。

### 1.3 Trash

**位置**：`~/.grande-control/trash/<taskId>/<ISO8601>-<seq>/<相对路径>`

放控制平面**不放 worktree**：worktree 是 git 检出，回收站放进去会污染 `grande_diff`，
而 D4 承诺 worktree 的 diff 就是这次任务的改动。同理它也不能放 canonical。

**保留策略**：S1 **不做自动清理**。`grande_task_close` 也不清 trash——任务关掉之后
文件反而更需要能取回。清理交给 S4 的保留策略，或 `grande gc` 的一个显式子命令。

**取回**：S1 不提供「从 trash 取回」的工具。回滚走 Checkpoint（覆盖绝大多数场景）；
trash 是最后的保险，人工从控制平面目录取。**不要为它设计工具**——工具面越小越好，
而这条路径的真实使用频率还没有任何数据支撑。

### 1.4 Checkpoint

**位置**：`~/.grande-control/checkpoints/<taskId>/<checkpointId>/`

**只快照本批受影响的路径**，不是整个 worktree。`repo_edit` 一批通常 1–5 个文件，
全量快照对 597M 依赖的仓库是不可接受的开销。

**必须记录「文件此前不存在」这个状态。** 否则 `create` 的回滚无从判断该删还是该还原：

```
checkpoint 目录布局
  manifest.json     每个路径一行：{ path, existedBefore: bool, sha256?: string }
  files/<相对路径>  existedBefore=true 的原始内容
```

回滚语义：
- `existedBefore: true` → 用 `files/` 里的副本覆盖回去
- `existedBefore: false` → 把现在这个文件移进 **Trash**（不是直接删——铁律：能恢复就恢复）

**checkpointId 必须在 `repo_edit` 的返回里**，否则模型没法回滚自己刚做的事。

### 1.5 delete op

```ts
| { op: "delete"; path: string; expectedSha256: string }
```

**`expectedSha256` 必填，与 `modify` 一致。** 理由同 §规格 370：不是防并发，是防
模型基于陈旧认知删掉一个它以为还是旧内容的文件。**没读过就不许删。**

`grande_repo_edit` 的 `destructiveHint` **维持 `false`**。规格 §5.2 当初把它定成
`false` 的理由是「改文件在任务 worktree 里可回滚」；加了 delete 之后这个理由**更强**
而不是更弱——delete 同时经 Trash 与 Checkpoint 两层。真正不可逆的只有
`grande_task_close`（全表唯一 `destructiveHint: true`）。

### 1.6 「OID 校验」本切片不做——理由与替代

规格 §10 的 S1 条目里有「OID 校验」。**我建议本切片不做，并说明为什么。**

那一行是在**任何实现存在之前**写进路线图表的。现在 `expectedSha256`（内容字节的
sha256）已经实现、已经在生产里挡下过陈旧写入。git OID 相对它的唯一增量是
「能与 git 的 index/HEAD 直接比对而不必读文件内容」——那是 **commit 与 base sync**
的需求，属于 S2，不属于「安全写入」。

在 S1 里加一层 OID 只会得到两套并存的陈旧检测，各有各的边界条件。

**如果 Human Owner 认为我理解错了那一行的意图，请说明，我按新的理解重做。**
本文档其余部分不依赖这个决定。

### 1.7 S1 新增工具

只加一个：

| 工具 | 类型 | 入参 | 作用 |
|---|---|---|---|
| `grande_rollback` | 写（`destructiveHint: false`） | `{ taskId, checkpointId }` | 把 worktree 回滚到该 checkpoint 建立时的状态 |

`destructiveHint: false` 是对的：回滚本身产生新的 checkpoint（回滚也能被回滚），
且被覆盖的内容进 Trash。

---

## 2. S1.5 开发约束层

### 2.1 立意

规格 §10.1：**硬约束不可被 prompt injection 绕过，软约束可以。** 这是本项目的立意
（铁律三），也是 GrandeGPT 区别于「给模型一份 CLAUDE.md」的全部价值。

| | 硬约束（Gateway 门禁） | 软约束（指令文本） |
|---|---|---|
| 实现 | Policy 引擎拦截工具调用 | 方法论文本返回给模型 |
| 模型能绕过 | **不能** | 能——忽略即可 |
| prompt injection 能绕过 | **不能** | **能** |

### 2.2 `.grande/policy.yaml`：只能收紧，不能放宽

**这是整个 S1.5 唯一一条不可妥协的不变量。**

repo policy 文件住在**仓库里**（`<worktree>/.grande/policy.yaml`），而铁律一说
「仓库内容不可信」。二者唯一能共存的方式是：**repo policy 只能让规则更严，永远不能
更松。** 一个被投毒的仓库最多把自己锁死，不能给自己开权限。

合并语义必须是这个形状：

```
生效规则 = 全局规则 ⊕ repo 规则

其中 ⊕ 对每一类规则的定义：
  拒绝类（denyPrefixes、readOnlyPaths）  → 并集（repo 只能加，不能减）
  允许类（如果将来有）                    → 交集（repo 只能减，不能加）
  配对要求（pairedEdits）                 → 并集（repo 只能加更多要求）
```

**必须有一条测试直接钉住这条**：构造一个试图放宽全局规则的 repo policy，
断言生效规则**没有被放宽**。这条测试是 S1.5 的验收核心，见 §3.2。

### 2.3 S1.5 的硬约束规则集

只做两条。**不要在没有真实使用数据的情况下扩大规则集**——现在只有 2 个仓库、
个位数任务，多做的规则全是猜的。

**① `readOnlyPaths: [glob]`** —— 匹配的路径禁止写入（create/modify/move/delete 全禁）

现有的 `deny.yaml` 只有 `prefixes`（前缀匹配）。`readOnlyPaths` 用 glob，能表达
`.github/workflows/**` 这种。全局与 repo 的规则取并集。

**② `pairedEdits: [{ when: <glob>, require: <glob> }]`** —— 改了 A 就必须也改 B

规格 §10.1 的例子是「改 `src/**` 必须同时改 `tests/**`」。判定的作用域是
**整个任务**（不是单次 `repo_edit` 调用）：模型很可能先写实现再写测试，分两次调用，
那是正常的。所以：

- 检查点在 **`grande_run`** 而不是 `repo_edit`——「跑测试之前，配对要求必须已满足」
- 判据是 `grande_diff` 的已改文件集合（相对 base commit），不是单次 ops
- 违反 → `POLICY_DENIED`，错误消息里**列出缺哪一类文件**

这个设计的关键在于**它不阻碍中间过程，只在「要验证了」这一刻把关**。放在
`repo_edit` 上会让模型第一次写实现就被拒，制造一个没有出路的死循环。

### 2.4 软约束：方法论文本 + 词汇映射

规格 §10.1 结尾：「软约束侧需做 Claude Code → GrandeGPT 的工具词汇映射，
否则模型会去调用不存在的工具。」

**这是个真实且具体的问题**：现成的方法论文本（TDD 流程、调试方法论）都是给
Claude Code 写的，里面是 `Read` / `Edit` / `Bash` / `Grep`。原样喂给 ChatGPT，
它会去调用不存在的工具，然后困惑。

**交付形态**：控制平面里一份 `~/.grande-control/config/guidance.yaml`，
按 repo 可选，内容是纯文本；Gateway 在 **`grande_task_open` 的返回**里带上它。

不做新工具。理由：`task_open` 是每个任务的必经第一步，把指引放这里保证模型一定看到；
新加一个 `grande_guidance` 工具则要指望模型主动去调，而它没有理由主动调。

**词汇映射表**（写进文档，供人工撰写 guidance 时对照）：

| Claude Code | GrandeGPT |
|---|---|
| `Read` | `grande_repo_read`（返回 `sha256`，改文件时要带上） |
| `Edit` / `Write` | `grande_repo_edit`（一次可改多个文件） |
| `Grep` / `Glob` | `grande_repo_search` |
| `Bash("pnpm test")` | `grande_run` + `grande_run_result` 轮询 |
| `Bash("git diff")` | `grande_diff` |
| 任意其它 `Bash` | **没有对应物**——只能跑已注册 profile |

---

## 3. 验收标准

**每一条都必须是行为性断言**——断言文件系统与数据库的真实状态，不是形状断言。
本项目吃过亏：有一条测试的名字就叫「写工具 `destructiveHint: true`」，把 bug 钉成了
规范，活过七轮审查。

### 3.1 S1

| # | 断言 |
|---|---|
| AC-S1-1 | `repo_edit` 删除一个文件后，**worktree 里文件消失**，且 **trash 目录下能找到内容完全相同的副本** |
| AC-S1-2 | `delete` 不带 `expectedSha256` → `INVALID_INPUT`；带**错误**的 sha → `STALE_FILE`；两种情况下**文件都还在原处** |
| AC-S1-3 | 一批 3 个 op、第 2 个写盘失败 → **三个文件全部回到批前状态**（逐一比对内容），错误如实抛出而不是被吞 |
| AC-S1-4 | `grande_rollback` 之后，**每个受影响路径的内容逐字节等于 checkpoint 建立前** |
| AC-S1-5 | 回滚一个 `create`（批前不存在的文件）→ 文件从 worktree 消失，**且出现在 trash 里** |
| AC-S1-6 | `repo_edit` 的返回里有 `checkpointId`，且用它调 `grande_rollback` 确实生效 |
| AC-S1-7 | checkpoint 只包含**本批受影响的路径**——断言 worktree 里其它文件没有被快照 |
| AC-S1-8 | `grande_repo_edit` 的 `destructiveHint` 仍为 `false`，`grande_task_close` 仍为 `true`（防「统一成一样」的回归） |

### 3.2 S1.5

| # | 断言 |
|---|---|
| AC-S15-1 | **只能收紧**：repo policy 试图移除一条全局 `readOnlyPaths` → 生效规则里**该条仍在**。这条是 S1.5 的核心验收 |
| AC-S15-2 | repo policy **新增**一条 `readOnlyPaths` → 生效规则里出现该条（收紧方向必须真的生效，不能一刀切忽略整个文件） |
| AC-S15-3 | 写入被 `readOnlyPaths` 匹配的路径 → `POLICY_DENIED`，且**文件系统无任何改动** |
| AC-S15-4 | `pairedEdits` 未满足时 `grande_run` 被拒，错误消息**列出缺哪一类文件**；满足后放行 |
| AC-S15-5 | `pairedEdits` **不阻碍 `repo_edit`**——只改实现不改测试的那次 edit 必须成功 |
| AC-S15-6 | `.grande/policy.yaml` 语法错误 → **fail closed**（按只有全局规则处理并**报错**），不是静默忽略 |
| AC-S15-7 | `grande_task_open` 的返回里带上了 guidance 文本（若该 repo 配置了） |

### 3.3 四类探针（本项目重复犯过的错误，每轮都要跑）

| 探针 | 判据 |
|---|---|
| **P-A 接线** | 每个新增导出都有**生产**调用点，不是只有测试引用。已犯 5 次 |
| **P-B 反向测试** | 没有任何测试把「当前行为」当成规范来断言——尤其注解、错误码这类 |
| **P-C 同源漏改** | 同一个修复的所有调用点都改了。已犯 2 次 |
| **P-D 安全边界** | §2.2 的「只能收紧」在**代码层面**成立，不只是文档里写着 |

### 3.4 Load-bearing 证明（必做）

对下面三条，**把实现改坏，确认对应测试变红，再还原确认变绿**，并在报告里写出
「改坏成什么样、红在哪一行」：

1. AC-S1-3（部分失败自动回滚）—— 去掉回滚逻辑
2. AC-S1-5（回滚 create 走 trash）—— 改成直接删除
3. AC-S15-1（只能收紧）—— 把合并语义改成「repo 覆盖全局」

**通不过 load-bearing 的测试等于没有测试。**

---

## 4. 不做什么

| 项 | 为什么 |
|---|---|
| OID 校验 | §1.6。`expectedSha256` 已覆盖 S1 的实际需求；OID 的价值在 S2 |
| 从 trash 取回的工具 | §1.3。工具面要小；这条路径的真实使用频率零数据 |
| trash / checkpoint 的自动清理 | 属 S4 保留策略。S1 只管**存下来** |
| 更多硬约束规则 | §2.3。只有 2 个仓库、个位数任务，多做的都是猜的 |
| `commit` 前必过 `unit` | 需要 commit，属 S2 |
| 任何新 profile | §0.2。控制平面才能改 |

---

## 5. 给 Human Owner 的两个问题

1. **§1.6 的 OID 校验**：我建议本切片不做。如果那一行的意图不是我理解的那样，请指出。
2. **S1.5 是否应该排在 S1 之前**？它是项目立意（做约束）、只要 3–4 人日、不依赖 S1
   任何东西；而 S1 解决的是「删除文件不安全」，但目前的实际用法里模型压根没删过文件。
   本文档按规格原顺序写（S1 → S1.5），两者的任务清单相互独立，换序不需要改文档。
