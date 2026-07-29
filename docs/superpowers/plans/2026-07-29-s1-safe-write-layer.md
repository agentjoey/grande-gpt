# S1 + S1.5 实施计划（由 ChatGPT 经 GrandeGPT 执行）

**设计文档** [`../specs/2026-07-29-grande-gpt-s1-design.md`](../specs/2026-07-29-grande-gpt-s1-design.md)
**仓库** `grande-gpt` · **验收 profile** `unit-selfhost` + `typecheck`

> ## ⚠️ 不要用 `unit` —— 它在沙箱里【永远绿不了】
>
> **这是自举的结构性上限，不是 bug，也不是你的代码有问题。**
>
> 本仓库有 5 个测试文件自己要 spawn `sandbox-exec`（它们测的就是沙箱本身）或绑真实
> 端口。在沙箱里跑它们等于**嵌套沙箱**，而内层沙箱只能比外层更严，**永远拿不回外层
> 拒掉的权限**。典型报错长这样，看起来像权限配错，实际是结构性的：
>
> ```
> Error: EPERM: operation not permitted, scandir '.../.grande-control/derived/tmp'
>   ❯ assertOnDiskSpelling src/sandbox.ts
> Error: listen EPERM: operation not permitted 0.0.0.0
> ```
>
> **实测基线（2026-07-29，沙箱内跑全量）：524 个测试中 40 个失败，全部落在这 5 个文件：**
> `tests/sandbox.test.ts` · `tests/runner.test.ts` · `tests/server.test.ts` ·
> `tests/tools.test.ts` · `tests/e2e.test.ts`
>
> **所以：一律用 `unit-selfhost`**（控制平面里已配好，排除这 5 个文件；沙箱外实测
> 20 文件 / 394 测试全绿）。它排除了什么、为什么排除，明写在
> `~/.grande-control/config/profiles.yaml` 的注释里——**不是静默丢弃**。
>
> 那 5 个文件由 Human Owner 在沙箱**外**跑 `pnpm test` 覆盖，**合并前不可跳过**。
>
> 好消息：`tests/repoFile.test.ts`（30 tests）在沙箱内**通过**——那正是 S1-3 要改的
> 文件，你的改动验得了。
>
> *（这条最初写错成「`unit` 必须绿」，会卡死每一个任务。是实现者跑出红灯、拒绝
> 在红灯下往下做、并把「新回归 vs 既有环境问题」两种可能交回来判断，才暴露出来的。
> 那个判断是对的。）*

> **给实现者**：先完整读一遍设计文档的 **§0（自举约束）**，它列出了你做不到的事。
> 尤其：**你不能删除文件**、**没有 shell**、**验收只能用 `unit-selfhost` + `typecheck`**。

---

## 开工前

```
grande_task_open  { repoId: "grande-gpt", slug: "s1-safe-write", taskId: <你自己起> }
```

拿到 `taskId` 之后**每一步都带上它**。

**每次继续工作的第一件事**（新会话、或不确定进度时）：

```
grande_task_status { taskId }      ← 分支、已改文件、最近 job
grande_diff        { taskId }      ← 已经做了什么
```

**不要凭记忆判断进度。** 上下文会腐化，`grande_diff` 是权威。

---

## 通用规则（每个任务都适用）

1. **改已有文件前先 `grande_repo_read` 拿 `sha256`**，`modify` 时带上。跳步会 `STALE_FILE`。
2. **一次 `repo_edit` 里同一路径只能出现一次。** 要改两次就分两次调用。
3. **每个任务结束时必须跑 `unit-selfhost` 与 `typecheck` 两个 profile**，两个都绿才算完成。
   **不要用 `unit`**——见文档开头的警告，它在沙箱里结构上不可能全绿。
4. **不要删除任何文件。** 需要废弃就留着不动，或 `move` 到明确位置。
5. **测试必须断言真实状态**（文件系统内容、数据库行），不是「函数返回了一个对象」。
6. `grande_run` 立即返回 `jobId`，用 `grande_run_result` 轮询到终态。

---

# S1 · 安全写入层

实现顺序不可换：**Trash → Checkpoint → 接进 repoEdit → delete → rollback 工具**。
设计文档 §1.2 解释了为什么——「事务 patch」不是独立特性，是 Checkpoint 的一个用法。

---

## 任务 S1-1 · Trash 模块

**新建** `src/trash.ts`、`tests/trash.test.ts`。**只写新文件，不碰任何既有文件。**

### 要实现的

```ts
export interface TrashEntry { trashPath: string; relativePath: string; movedAt: number }

/**
 * 把 worktree 里的一个文件移进控制平面回收站。
 * 目标位置：<controlRoot>/trash/<taskId>/<ISO时间戳>-<序号>/<相对路径>
 * 目录结构原样保留（a/b/c.ts 进去还是 a/b/c.ts），方便人工取回时看得懂。
 */
export function moveToTrash(
  layout: Layout, taskId: string, worktreeRoot: string, relativePath: string,
): TrashEntry;
```

### 硬性要求

- **`taskId` 必须过 `assertTaskId`**（`src/paths.ts`）。它会被拼进文件系统路径，
  一个 `../../` 形状的值能把文件写到控制平面之外。本项目在 `runner.ts` 里踩过同一个坑。
- **`relativePath` 必须过 `src/paths.ts` 现有的相对路径守卫**，不要自己写一套。
- 源文件不存在 → 抛 `TrashError("FILE_NOT_FOUND", ...)`，**不要静默返回**。
- 同一任务多次删同一路径不能互相覆盖——时间戳后面的序号就是为这个。

### 测试（`tests/trash.test.ts`）

1. 移进去之后，**worktree 里文件消失**，**trash 里的副本内容逐字节相同**
2. trash 路径在 `layout.controlRoot` 之下，**不在** `layout.workspaceRoot` 之下
3. 同一路径删两次，**两个副本都在**，内容各自正确（不是后者覆盖前者）
4. 嵌套路径 `a/b/c.ts` 的目录结构在 trash 里保留
5. `taskId` 为 `../evil` → 抛错，且**控制平面之外没有产生任何文件**
6. 源文件不存在 → `FILE_NOT_FOUND`

### 验收
`grande_run unit-selfhost` 与 `typecheck` 均绿。

---

## 任务 S1-2 · Checkpoint 模块

**新建** `src/checkpoint.ts`、`tests/checkpoint.test.ts`。**只写新文件。**

### 要实现的

```ts
export interface CheckpointManifestEntry {
  path: string;            // worktree 相对路径
  existedBefore: boolean;  // 关键：create 的回滚靠它判断该删还是该还原
  sha256?: string;         // existedBefore=true 时的内容哈希
}

/** 快照给定路径在【当前】的状态。只快照传进来的这些路径，不是整个 worktree。 */
export function createCheckpoint(
  layout: Layout, taskId: string, worktreeRoot: string, relativePaths: readonly string[],
): string;  // 返回 checkpointId

/** 回滚到该 checkpoint。返回实际改动的路径列表。 */
export function restoreCheckpoint(
  layout: Layout, taskId: string, worktreeRoot: string, checkpointId: string,
): string[];
```

### 硬性要求

- 落盘布局：`<controlRoot>/checkpoints/<taskId>/<checkpointId>/manifest.json` +
  `files/<相对路径>`（只存 `existedBefore=true` 的）
- **`existedBefore: false` 的回滚必须走 `moveToTrash`，不能直接删。**
  设计文档 §1.4：能恢复的就恢复。这是 AC-S1-5，会被 load-bearing 证明验。
- `restoreCheckpoint` 对不存在的 `checkpointId` → 抛 `CheckpointError("NOT_FOUND", ...)`
- `taskId` 同样过 `assertTaskId`

### 测试（`tests/checkpoint.test.ts`）

1. 快照 → 改文件 → 回滚 → **内容逐字节等于快照时**
2. 快照一个**不存在**的路径 → 之后创建它 → 回滚 → **文件从 worktree 消失，且出现在 trash 里**
3. `createCheckpoint` **只快照传入的路径**——worktree 里另一个文件不在 `files/` 下（AC-S1-7）
4. `manifest.json` 里 `existedBefore` 对两种情况都正确
5. 未知 `checkpointId` → `NOT_FOUND`
6. 同一任务连续两次 checkpoint，两个都可独立回滚（互不干扰）

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S1-3 · 接进 repoEdit：事务性

**改** `src/repoFile.ts`、`tests/repoFile.test.ts`。

### 现状

`repoEdit`（`src/repoFile.ts`，搜函数名定位——**不要依赖行号**，你自己的编辑会让它漂移）已经是两阶段：先全校验、再全写。
**但写阶段中途失败没有回滚**——第 1 个文件已落盘、第 2 个失败，现场半完成。

### 要改成

```
阶段一：全校验（保持不变）
阶段二前：createCheckpoint(受影响的所有路径)
阶段二：逐个写盘
   ├─ 全部成功 → 返回结果，带上 checkpointId
   └─ 任一抛错 → restoreCheckpoint 回滚 → 把【原始错误】重新抛出
```

### 硬性要求

- `EditResult` 增加 `checkpointId: string` 字段（AC-S1-6）
- **回滚失败不能掩盖原始错误。** 回滚本身抛错时，记录它，但抛出去的仍是**导致这批
  失败的那个原始错误**——那才是调用方需要看到的。
- 受影响路径要包含 `move` 的 **from 和 to 两个**

### 测试（`tests/repoFile.test.ts` 追加）

1. **AC-S1-3**：3 个 op、第 2 个写盘失败 → **三个文件全部回到批前状态**（逐一比对内容），
   原始错误如实抛出
   - 怎么造失败：把第 2 个 op 的目标路径先建成**目录**，`writeFileSync` 会抛 `EISDIR`。
     **已实测确认**（`fs.mkdirSync(p)` 之后 `fs.writeFileSync(p, "x")` → `code: "EISDIR"`），
     这个手法可靠，不用另找办法
2. 全部成功时返回的 `checkpointId` 非空，且用它 `restoreCheckpoint` 确实能回滚
3. 既有的 repoFile 测试**全部仍绿**（不要为了新功能改坏旧行为）

### 验收
`unit-selfhost` + `typecheck` 均绿。**这个任务改的是所有写操作都要经过的核心路径——
既有测试一条都不许红。**

---

## 任务 S1-4 · delete op

**改** `src/repoFile.ts`、`src/tools.ts`、`tests/repoFile.test.ts`、`tests/tools.test.ts`。

### 要实现的

```ts
| { op: "delete"; path: string; expectedSha256: string }
```

- `expectedSha256` **必填**，语义与 `modify` 完全一致：不匹配 → `STALE_FILE`
- 删除动作 = `moveToTrash`，不是 `unlinkSync`
- `pathsOf`（`src/repoFile.ts` 里的辅助函数，返回一个 op 涉及的所有路径）要认识 `delete`
- 校验分支（`repoEdit` 里那句 `op.op !== "create" && op.op !== "modify" && ...`）要放行 `delete`
- `src/tools.ts` 里 `grande_repo_edit` 的 **JSON Schema 与 description 都要更新**，
  让模型知道有这个 op、知道它要 `expectedSha256`

### 硬性要求

- **`grande_repo_edit` 的 `destructiveHint` 维持 `false`。** 设计文档 §1.5 给了理由：
  delete 同时经 Trash 与 Checkpoint 两层，可恢复。**不要顺手改成 `true`**——
  `grande_task_close` 是全表唯一的 `true`，那条测试会红。

### 测试

1. **AC-S1-1**：删除后 worktree 里文件消失，trash 里副本内容相同
2. **AC-S1-2**：不带 `expectedSha256` → `INVALID_INPUT`；带错的 → `STALE_FILE`；
   **两种情况下文件都还在原处**（拒绝必须无副作用）
3. 删一个不存在的文件 → `FILE_NOT_FOUND`，无副作用
4. `delete` 与 `create`/`modify` 混在同一批里正常工作
5. **AC-S1-8**：`grande_repo_edit` 的 `destructiveHint` 仍为 `false`，
   `grande_task_close` 仍为 `true`

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S1-5 · `grande_rollback` 工具

**改** `src/tools.ts`、`tests/tools.test.ts`。

### 要实现的

第 11 个工具：

```
name: "grande_rollback"
入参: { taskId: string, checkpointId: string }   两个都必填
注解: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
```

行为（顺序不可换）：
1. `getTask` → 不存在则 `TASK_NOT_FOUND`
2. `beginAudit` → `h.allowed()` → `h.executing()`
3. `restoreCheckpoint`
4. `h.succeeded(改动的路径列表)`
5. 返回 `ok()` 信封，`data` 含 `{ taskId, checkpointId, restoredPaths }`

**照抄 `src/tools.ts` 里既有写工具的形状**（`grande_repo_edit` 是最接近的参照）。

### 硬性要求

- `destructiveHint: false`：回滚本身产生新 checkpoint、被覆盖的内容进 trash，可恢复
- **必须写审计账本。** 本项目有过「写工具漏记审计」的先例（`grande_task_open`）

### 测试

1. **AC-S1-4**：`repo_edit` → `rollback` → **每个受影响路径逐字节等于 edit 之前**
2. 未知 `checkpointId` → 错误码明确，**worktree 无改动**
3. `TASK_NOT_FOUND`
4. 写了审计账本（`decision=ALLOWED` 且 state 到终态）
5. 注解断言：`destructiveHint === false`

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

# S1.5 · 开发约束层

> **先读设计文档 §2.2。** 「只能收紧不能放宽」是这一层唯一不可妥协的不变量——
> repo policy 住在仓库里，而仓库内容不可信（铁律一）。

---

## 任务 S15-1 · repo policy 加载与合并

**新建** `src/repoPolicy.ts`、`tests/repoPolicy.test.ts`。**只写新文件。**

### 要实现的

```ts
export interface RepoPolicy {
  readOnlyPaths: string[];                              // glob
  pairedEdits: { when: string; require: string }[];     // glob → glob
}

/** 从 <worktreeRoot>/.grande/policy.yaml 读。文件不存在 → 返回空规则（不是错误）。 */
export function loadRepoPolicy(worktreeRoot: string): RepoPolicy;

/**
 * 合并全局与 repo 规则。**repo 只能收紧。**
 *   readOnlyPaths / pairedEdits → 并集（repo 只能加）
 * 全局有而 repo 没有的条目，【必须保留】——这正是 AC-S15-1 要钉住的。
 */
export function mergePolicy(global: RepoPolicy, repo: RepoPolicy): RepoPolicy;
```

### 硬性要求

- **语法错误 → 抛错（fail closed），不要静默当成空规则。** 静默忽略等于给投毒者
  一条「写个坏 YAML 就绕过 repo policy」的路。（AC-S15-6）
- `.grande/policy.yaml` **不存在**是正常情况，返回空规则，不报错
- **glob 匹配用 `node:path` 的 `matchesGlob`（Node 内置，本项目锁 Node 24，已实测可用）。**
  **不要手写 glob 匹配**——这是安全边界上的路径判定，手写的匹配器正是 bug 的温床；
  也**不要引入新的 npm 包**（S0 全离线，装不了）。

  已实测的行为（可直接依赖）：
  ```
  matchesGlob("src/a.ts",                  "src/**")               → true
  matchesGlob("src/deep/b.ts",             "src/**")               → true
  matchesGlob("README.md",                 "src/**")               → false
  matchesGlob(".github/workflows/ci.yml",  ".github/workflows/**") → true
  matchesGlob("src/a.ts",                  "**/*.ts")              → true
  ```

### 测试（`tests/repoPolicy.test.ts`）

1. **AC-S15-1（核心）**：repo policy 试图**移除**一条全局 `readOnlyPaths` →
   合并结果里**该条仍在**
2. **AC-S15-2**：repo policy **新增**一条 → 合并结果里出现该条
3. 文件不存在 → 空规则，不抛错
4. **AC-S15-6**：YAML 语法错误 → 抛错
5. `.grande/policy.yaml` 是目录而不是文件 → 抛错，不崩

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S15-2 · readOnlyPaths 接进写路径

**改** `src/tools.ts`（或 `src/policy.ts`，取更自然的那个）、对应测试。

### 要实现的

`grande_repo_edit` 执行前，对**每一个** op 的目标路径（`move` 是 from 和 to 两个）
检查是否命中生效后的 `readOnlyPaths`。命中 → `POLICY_DENIED`。

### 硬性要求

- **检查必须在阶段一（全校验）里，早于任何写盘。** AC-S15-3 要求拒绝时文件系统零改动。
- 生效规则 = `mergePolicy(全局, loadRepoPolicy(worktree))`
- 错误消息要说清**是哪条规则**挡的，否则模型无从下手

### 测试

1. **AC-S15-3**：写入被匹配的路径 → `POLICY_DENIED`，**文件系统无任何改动**
2. 未被匹配的路径正常写入（不能一刀切拒绝）
3. `move` 的 **from 和 to 任一**被匹配都要拒
4. repo policy 新增的规则**确实生效**（不是只有全局规则起作用）

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S15-3 · pairedEdits 接进 `grande_run`

**改** `src/tools.ts`、对应测试。

### 要实现的

`grande_run` 启动 job **之前**检查：对每条 `pairedEdits` 规则，若本任务已改文件里
有匹配 `when` 的，则必须也有匹配 `require` 的。否则 `POLICY_DENIED`。

### 硬性要求

**检查点在 `grande_run` 而不是 `repo_edit`。** 设计文档 §2.3：模型很可能先写实现、
再写测试，分两次调用。放在 `repo_edit` 上会让它第一次写实现就被拒，制造没有出路的
死循环。**这一条写错了整个功能就是有害的。**

- 判据是**本任务相对 base commit 的已改文件集合**（`grande_diff` 用的那个），
  不是单次 ops
- 错误消息**必须列出缺哪一类文件**（例如「改了 `src/**` 但没有匹配 `tests/**` 的改动」），
  否则模型不知道该做什么

### 测试

1. **AC-S15-4**：只改了 `src/x.ts` → `grande_run` 被拒，消息里出现 `tests/`；
   补一个 `tests/x.test.ts` 后 → 放行
2. **AC-S15-5**：`pairedEdits` **不阻碍 `repo_edit`**——只改实现那次 edit 必须成功
3. 没有配置 `pairedEdits` 时 `grande_run` 不受影响
4. 两条规则同时存在时，缺哪条报哪条

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S15-4 · 软约束：guidance 文本

**改** `src/tools.ts`（`grande_task_open` 的返回）、可能需要新建
`src/guidance.ts`、对应测试。

### 要实现的

- 从 `<controlRoot>/config/guidance.yaml` 读，形如 `{ repos: { <repoId>: "<文本>" } }`
- 在 **`grande_task_open` 的返回**里带上该 repo 的 guidance（没有配置就不带）
- **不要新增工具。** 设计文档 §2.4：`task_open` 是必经第一步，放这里保证模型看得到；
  新工具要指望模型主动调，而它没有理由主动调。

### 硬性要求

- guidance 文件不存在 → 正常工作，不带 guidance（这不是错误）
- guidance 是**纯文本**，不解释、不执行——它只是给模型看的字符串

### 测试

1. **AC-S15-7**：配置了 guidance 的 repo，`task_open` 返回里带上了它
2. 没配置 → 返回里不带，且不报错
3. `guidance.yaml` 不存在 → 不报错

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

# 全部完成后

## 自查（写进最后的报告）

1. **P-A 接线**：每个新增导出（`moveToTrash`、`createCheckpoint`、`restoreCheckpoint`、
   `loadRepoPolicy`、`mergePolicy`……）是否都有**生产**调用点，不是只有测试引用？
   逐个列出调用它的文件。**本项目已经犯过 5 次这个错。**
2. **P-B 反向测试**：有没有哪条测试是把「当前行为」当规范来断言的？尤其注解与错误码。
3. **P-C 同源漏改**：`taskId` 的路径校验，是否所有把它拼进文件系统路径的地方都加了？
4. **P-D 安全边界**：§2.2 的「只能收紧」在**代码层面**成立吗，还是只有文档里写着？

## Load-bearing 证明（必做，三条）

把实现改坏 → 确认对应测试变红 → 还原 → 确认变绿。
**报告里要写清楚「改坏成什么样、红在哪一行、报什么错」。**

| # | 改坏什么 | 应该红的测试 |
|---|---|---|
| 1 | 去掉 repoEdit 写阶段的回滚逻辑 | AC-S1-3 |
| 2 | 把「回滚 create」改成直接删除而不是进 trash | AC-S1-5 |
| 3 | 把合并语义改成「repo 覆盖全局」 | AC-S15-1 |

**通不过 load-bearing 的测试等于没有测试。** 本项目有一条测试的名字就叫
「写工具 `destructiveHint: true`」——它把 bug 钉成了规范，活过七轮审查。

## 最终报告要写什么

- 每个任务做了什么、动了哪些文件
- 三条 load-bearing 证明的**实际输出**（不要只写「通过」）
- 四类探针的自查结果
- **哪些是你实测的、哪些是你推断的**——这两者必须分开写
- 遇到的、你认为设计文档写错或写漏的地方

---

## 遇到问题怎么办

- **卡在某个任务**：`grande_task_status` + `grande_diff` 看清现状，别凭记忆
- **设计文档与代码现状矛盾**：**以代码为准**，并在报告里写出矛盾点。
  文档是我写的，可能有错。
- **需要一个新 profile 或要删文件**：做不到（§0.2）。换个做法，或在报告里说明为什么卡住。
- **改坏了不知道怎么恢复**：`grande_task_close` 关掉任务重开一个。worktree 是隔离的，
  正在运行的 Gateway 不受影响。
