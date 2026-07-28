# AC-13 · 真实 ChatGPT 对话中的完整开发闭环 —— 结论：**PASS**

**日期** 2026-07-29 · **端点** `https://grande.agentjoey.ai/mcp/grande-gpt`
**客户端** ChatGPT Plus 桌面版 · **权限档** `Allow low-risk actions`
**任务** `task-fix-greet-20260729-001` · **仓库** grande-gpt 自身（dogfooding）

---

## 结论

**闭环跑通。** 完整走完：

```
task_open → 探索仓库 → repo_edit 建代码与测试 → run → run_result（看到预期失败）
          → repo_edit 修 → run → run_result（通过）→ task_status 总结
```

沙箱输出的决定性两行：

```
第一次： ❯ tests/greet.test.ts (2 tests | 1 failed)
             ✓ greets a named person
             × greets an empty name as stranger      ← 这正是我们造的预期失败

第二次： ✓ tests/greet.test.ts (2 tests)              ← 修完全通过
```

**canonical 工作区全程零污染**（`git status` 始终干净），D4「用户可以继续用编辑器干活」
的承诺成立。

---

## 四项观察指标（规格 §9.2 要求）

| 指标 | 结果 |
|---|---|
| **对话轮数** | 9 步提示词 + 0 条额外补充。模型未要求澄清 |
| **确认框次数** | **1 次**，app 级（「是否允许使用 GrandeGPT」），**不是工具级**。与 POC 第一轮一致 |
| **模型选错工具** | **1 次**：`grande_run {"profile":"test"}` → `PROFILE_NOT_FOUND`，下一步自纠为 `"unit"` |
| **`taskId` 是否丢失** | **没有丢。** 且它不是凭记忆作答——主动调 `grande_task_status` + `grande_diff` 取权威数据后才总结 |

---

## 值得记录的模型行为

### ① 它自己诊断出了一个真实 bug

第一轮跑测试后，它主动调 `grande_diff` 发现 0 改动，随即推断：

> `grande_diff` 对任务返回 0 个改动，说明这次 `grande_repo_edit` 写入的是 canonical
> 仓库，而不是该任务的 worktree。

**这个结论完全正确**，而且早于我们在代码里确认。根因是 `repo_edit` 的 `taskId` 被描述成
「可选的任务ID，关联审计记录」，而实现恒用 canonical 根——D4 被破坏。

### ② 连续三次准确区分「预期失败」与「环境噪音」

我们的仓库测试里有 6 个文件调真实 `git`，在沙箱里因 `unable to locate xcodebuild` 失败。
模型每次都明确指出「失败集中在 `tests/worktree.test.ts`，不是 `greet` 测试本身」，
没有把噪音当成自己的错误去修。

### ③ 探索量偏大

动手前读了 13 个文件（README、package.json、tsconfig、vitest.config、server.ts、
tools.ts、AGENTS.md……）。对「加两个小文件」这个任务，7 分钟里大半花在这。
不是瞎猜，是在认真建上下文——但值得考虑 `grande_repo_map` 的 `keyFiles` 能否更早
给出足够信息，减少逐个 read。

### ④ 对「操作是否已生效」缺乏确信

`grande_task_open` 被调了**两次**，第二次因重复 taskId 被 `INVALID_INPUT` 拒绝。
说明第一次成功后它仍不确定。**`task_open` 的返回值或 `hint` 需要更明确的成功信号。**

### ⑤ 截断信号被忽略了一次

`grande_repo_search → ok truncated`，模型**没有跟进 `nextCursor`**，直接去 read 了。
本次不影响结果（目标只有一处定义），但与 POC 的 P-5（5 次截断 → 8 次续读）不一致。
差异可能来自 `hint` 措辞，或它判断已找到答案。**值得在 S1 单独观察。**

---

## P-1（自主轮询）本轮**未被验证**

job 只跑了 3.2 秒，比 `pollAfterSeconds` 的建议间隔还短，模型 `run` 之后一次
`run_result` 就拿到了终态——**没有构成需要轮询的场景**。

POC 用假服务端测出「4/4 自主轮询、最长链 17 次」，但那是秒回的假 job。
**真实的几十秒等待仍是未知数**，需要一个跑得够久的 job 才能验证。

---

## 本轮实测发现并修复的缺陷（共 6 个）

全部是单元测试碰不到、只有真跑才暴露的：

| # | 缺陷 | 为什么测试没抓到 |
|---|---|---|
| 1 | 三个写工具 `destructiveHint: true`（规格 §5.2 要求 `false`），被 `Allow low-risk actions` 档全部拦掉 | **有一条测试的名字就叫「写工具 destructiveHint: true」——它把 bug 钉成了规范** |
| 2 | `repo_edit` 写进 canonical 而非 worktree | 没有任何测试断言「写完之后 canonical 应该干净」 |
| 3 | 沙箱里 `pnpm` 找不到 | `pnpm` 是符号链接指向 `pnpm.cjs`；只保留 realpath 目标目录，PATH 查不到 `pnpm` 这个名字 |
| 4 | worktree 没有 `node_modules` | 代码正确，缺的是 `profiles.yaml` 里的 `depDirs` 配置 |
| 5 | `deny (subpath worktreesRoot)` 连 `lstat` 目录本身都拒 | pnpm/npm/vitest 启动必然向上遍历找 workspace 根；U2 spike 的命令 cwd 就在 worktree 内、从不向上走 |
| 6 | OAuth 客户端与 refresh token 全在内存，**每次重启全部失效** | 没有任何测试跨越「重启」这个边界 |

另有两处此前已修但同源的：`accessGate` 写好却从未被 `/authorize` 调用；
`grande_task_open` 是写操作却不走审计账本。

**共同点**：全部是「模块正确但没接上线」或「测试与规格相反」，
而不是「函数算错了」。逐任务审查看单个 diff 抓不到这一类。

---

## 遗留问题

| # | 问题 | 严重度 |
|---|---|---|
| 1 | 分支名多一个连字符：`grande/fix-greet--001`。规格 §5.2 是 `grande/<slug>-<后4位>`，而 `taskId` 以 `-001` 结尾 | 低，但会出现在每个分支名里 |
| 2 | 沙箱内 `git` 需要 Xcode developer dir，环境清洗后不可用 | 仅影响调 git 的项目（本仓库自身），普通项目无感 |
| 3 | P-1 在真实长任务下未验证 | **需要专门测一次** |
| 4 | `taskId` 由模型自行生成，格式自由 | 观察项；目前工作正常 |
