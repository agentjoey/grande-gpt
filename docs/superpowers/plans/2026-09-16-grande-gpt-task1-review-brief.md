# Lifecycle Task 1：候选实现与独立评审交接

## 状态与基线

状态：Task 1 候选已完成实现与已知 3 个 blocking review findings 的最小修复；等待下一轮独立 re-review / acceptance gate，不得标记 Task 1 accepted，不进入 Task 2。

- Task：`task-gg-lifecycle-governance-20260916-001`
- Branch：`grande/lifecycle-governance-6001`
- Base：`290d81f367701c58b1058b08890fe2bb78512bd9`
- Code candidate HEAD：`166c4fc1ed783276d8019b99ee2b7819021d335d`
- Worktree：`/Users/xtation/AgentWorks/GPT_Workspace/.grande-work/worktrees/grande-gpt/task-gg-lifecycle-governance-20260916-001`
- 未执行真实 PR merge / production deploy / active worktree cleanup；测试的 Git 和数据库副作用仅发生在 disposable fixtures。

上一轮独立评审的 3 个 blocking findings 已全部修复：PR identity、merged `baseSha`、cleanup TOCTOU。当前候选未发现其他已知 blocking finding；最终 accept 仍由独立 re-review / acceptance gate 决定。

## 实现边界

生产代码只涉及 `src/db.ts`、`src/taskPrReceipt.ts`、`src/githubApi.ts`、`src/prOpen.ts`、`src/prMergeD2.ts`、`src/mergeReconcile.ts`、`src/taskProgress.ts`、`src/deliveryTarget.ts`。

1. 新增兼容附属表 `task_pr_receipt`。PR number/url 固定；merge 前 head/base 允许更新，merge 后证据锁定；拒绝缺少 exact head/baseRef/mergeSha 的 merged 写入，重放幂等。
2. PR open 保存 identity；正常 merge、外部 merge、响应丢失通过现有受控 merge/reconciliation 路径持久化 milestone。没有新增后台 merge，也没有把只读 task_status 改成网络写入入口。
3. 自动 cleanup 要求 durable receipt、published canonical snapshot、当前 branch/HEAD/clean、task head→merge→canonical 的 Git ancestry，以及没有活跃 job。canonical 可以领先 merge，但不能把它的新 HEAD 冒充 merge SHA。
4. 自动 cleanup 不使用 `worktree remove --force` / `branch -D`。linked worktree 先解析自身 Git admin dir，独占创建 `HEAD.lock`，持锁重新确认 expected branch + exact HEAD，再执行普通 non-force `git worktree remove`；`finally` 只释放本次创建的 lock。dirty / untracked 继续由普通 Git remove fail closed。人工显式 task_close 接口未改变。
5. explicit deploy / legacy deploy.yaml 保留工作区；授权拒绝不能通过 D2 recovery 绕过到 GitHub。已有 EXECUTING 的授权恢复仍沿用 authorization 级 exact merge receipt、parents/tree 验证及 pinned release source。
6. merged/completed 不再由最近 500 条 audit 决定。旧 merge audit 只是需要 reconciliation 的历史线索，投影 unknown；CI 不因 PR 已 merged 就伪报 passed。已关闭且工作区已移除的任务不再产生虚构的重测动作。

`completed` 表示交付 milestone；`cleanupRequired` 表示仍需处理保留资源，不等于 cleanup eligibility。Task 4 的显式 eligibility 与等待原因分类尚未实现。

## 本轮可追溯测试证据

| 切片 | 观察到的 RED | GREEN 证据 |
| --- | --- | --- |
| receipt runtime / PR identity | `job_ff73ba40-9216-4831-8d12-519c9e4eab7d`：null head/base 与 PR/base 误绑定 4 条失败 | `job_52dbe14b-10e5-43ed-ae68-e2a73fbe7526`：5 files / 38 tests passed |
| 自动 cleanup | `job_ba6d5d0a-934f-4f31-ad5a-2745567b8ec9`：真实 Git 的 5 个边界失败；`job_1cc92c42-ba58-494b-9a1c-ac2a374113bd`：检查后新增文件被 force 删除；`job_9d11ec71-47c9-45e5-9e82-5bbb15d95efa`：safeGit branch/head 检查后新增 clean commit 或 detached HEAD + clean commit 时旧实现错误删除 worktree | `job_462486c3-c81a-4546-8509-a296d3996462`：`tests/taskPrReceiptCleanup.test.ts` 11/11 passed |
| 授权恢复 | `job_cfe4d875-44a2-40a5-82a1-8ca2bbb09660`：缺授权仍读 GitHub、用 later canonical HEAD 验 merge 两条失败 | `job_e498a688-bad9-4d23-8731-1d4e712b42f6`：d2Deployment 全部 6 条通过 |
| 状态投影 | `job_e498a688-bad9-4d23-8731-1d4e712b42f6`：CI 假通过、危险关闭提示、closed 重测、audit window、deploy 假完成 5 条失败 | `job_e3746bd4-50c9-4b1d-94b6-3e1a26d9611c`：新增 projection 5 条全部通过；旧 audit-only 夹具随后补 durable evidence |
| 最终比例回归 | 包含上述新增边界、既有 PR / authorization / exact merge / DB 和投影调用方 | `job_2d3b5f47-ab85-45e9-9080-d4922c8ff67f`：20 files / 146 tests passed，exitCode=0 |
| code candidate HEAD typecheck | — | `job_ebfe6406-9641-41cc-b573-01879acf9970`：`tsc --noEmit` exitCode=0；attestation `att_22c7a018-2093-4144-8ca9-d98191fc83ad` 绑定 code HEAD `166c4fc1ed783276d8019b99ee2b7819021d335d` |

旧夹具中的 `merge-sha` 占位值已替换为真实 Git merge 历史。`deliveryMerge.test.ts`、`prLifecycle.test.ts`、`minimalV2Delivery.e2e.test.ts` 的宿主依赖修复仅为 Git helper 显式给出 test committer identity，不修改生产 Git policy 或宿主 global config。

运行方式：MCP 当前 `grande_run` 只接收 profile，不接收测试过滤参数，因此验证时临时限定 task-local Vitest include；这些 job 虽标为 `unit-selfhost`，实际证据范围仅为选定测试，不能当全量 selfhost gate。最终默认 `vitest.config.ts` 已恢复到基线 hash `c8b2864c57e8fab20401a2f0eadc5b5fab533f643d3f3d6e4766cbcb43f51993`。`.superpowers/` 内的诊断 reporter/report 是 gitignored scratch，不随候选交付。后续代码提交必须在默认配置下通过新鲜 typecheck，不能借用临时配置的全量验证名义。Task 1 收尾只更新本 review brief，不改变代码或测试范围，因此不重复已通过的测试。

## 独立评审范围

只评审 Task 1 相对上述 base 的差异及直接调用点，不重新审全仓库。重点独立核对：

- PR identity、returned/observed merge SHA、当前 origin/base 的绑定是否一致；未知字段不能被旧记录或本地 HEAD 冒充。
- receipt 幂等与不可变边界、部署授权拒绝路径，以及 task receipt 与 authorization-level ExactMergeReceipt 的职责分离。
- 自动删除前的 ancestry / branch / dirty / job / deployment 检查，以及 `HEAD.lock` 是否完整关闭 branch/HEAD check→remove 的竞争窗口；状态提示不得诱导绕过这些 guard。
- Legacy audit-only、closed worktree missing、CI unknown、explicit deployment 的投影语义；不要把历史合并事实、部署成功和可回收状态混为一谈。

下一轮 independent reviewer 只需 re-review 当前候选及上一轮 3 个 finding 的修复，输出 findings（优先级、文件/行、复现与最小修复建议）及 accept / changes requested。已通过的 146 条比例证据无需机械重复；只复跑新 finding 影响所需测试。第一批完整 selfhost / CI / Host gate 保留到四个切片形成完整候选后。

当前会话已实际查询 capability registry，仅有 native capabilities，未注册可调用的独立 reviewer。作者自查和测试不是 independent review。该 acceptance gate 保持 pending。

## 明确保留给后续切片

Task 2 的 CREATING / closing intent / startup + periodic recovery 尚未实现，尤其 Git removal 与 CLOSED 持久化之间的 crash recovery 不在本切片宣称范围内。Task 3 authorization expiry、Task 4 inactive/eligibility、第二批资源性能治理均未开始。外部 squash/rebase 无法证明 task-head ancestry 时保持 fail closed，不自动删除。
