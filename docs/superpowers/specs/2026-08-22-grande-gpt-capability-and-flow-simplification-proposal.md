# GrandeGPT 能力与开发流程简化 Proposal

**日期**：2026-08-22

**状态**：Proposed — 等待 Human Owner 审阅

**适用产品**：面向个人开发者、小团队、轻量与中小型代码开发及有限受控运维的 GrandeGPT

## 1. Proposal 目的

GrandeGPT 已经具备 Task/worktree、受控文件修改、sandbox profile、Git/GitHub、PR/CI、deployment、capability、host verifier 和运维 CLI。当前主要问题不再是缺少能力，而是：

- 所有项目和任务默认暴露过多工具；
- 低频管理能力长期占用 MCP tool contract；
- 本地开发、PR 交付和 production deploy 被表达为同一条固定 Golden Path；
- 一些工具只是把已有能力再次包装或拆成多个调用；
- 普通修改承担了接近核心安全修改的文档和 review 流程；
- 用户需要理解 receipt、outer-test、cleanup 和多次状态调用等内部步骤。

本 Proposal 的目标是在不降低现有安全边界的前提下：

1. 将仓库注册从两个 MCP 工具合并为一个；
2. 限制项目发现范围，禁止自动扩大可信仓库集合；
3. 删除、合并或内部化低频与重复能力；
4. 让任务按实际交付目标选择 local、PR 或 deploy 流程；
5. 让 agent 在一次授权范围内连续执行，用户只在真实 Human Gate 介入；
6. 降低公开工具数量、tool binding 成本和维护复杂度。

本 Proposal 不修改产品代码、数据库或 production 配置。实施必须在单独的 implementation plan 中完成。

## 2. 已确认的产品决策

以下决策由 Human Owner 明确确认，后续实现不得自行放宽：

1. 项目发现只扫描 `GRANDE_WORKSPACE` 内的项目；
2. 默认只识别 `GRANDE_WORKSPACE` 的直接子目录，不递归扫描任意深度；
3. 扫描永远只读，不自动注册；
4. Gateway 启动、doctor、task status 和 task open 都不能顺带注册项目；
5. 只有 Human 明确要求注册，或者在看到 proposal 后明确确认，才允许写注册表；
6. `grande_repo_add_propose` 与 `grande_repo_add_apply` 合并为一个 MCP 工具；
7. CLI 注册路径继续保留，作为本机管理和 Gateway 故障时的 fallback；
8. 项目注册不允许接受任意绝对路径；
9. 注册项目不能借机扩大 executable、network、deny rules 或 production 权限；
10. 不建设自动发现并自动加入的“项目目录同步器”。

## 3. 项目发现边界

### 3.1 允许扫描的根

唯一允许的发现根为运行 Gateway 的可信配置：

```text
GRANDE_WORKSPACE=/absolute/trusted/workspace
```

候选项目路径只能由以下公式得到：

```text
candidate = GRANDE_WORKSPACE + "/" + repoId
```

调用方不能传入 path、cwd、workspaceRoot、glob 或扫描深度。

### 3.2 候选项目条件

候选必须同时满足：

- 是 `GRANDE_WORKSPACE` 的直接子目录；
- `repoId` 通过现有 ID 形状校验；
- realpath 后仍位于 `GRANDE_WORKSPACE` 内；
- 不是符号链接、路径别名或大小写/Unicode 拼写绕过；
- 是可读取的 Git repository；
- 具有有效 HEAD；
- canonical checkout 不处于 detached、merge、rebase、cherry-pick 或 index.lock 状态；
- 不是 `.grande-work`、controlRoot、worktree 派生目录或其他保留目录。

不满足条件的目录可以出现在 bounded scan 结果中，但只能显示简短 blocker，不能被注册。

### 3.3 扫描行为

扫描只允许：

- 枚举直接子目录；
- 读取必要 Git metadata；
- 读取与 onboarding readiness 直接相关的根级配置；
- 判断是否已注册；
- 推导候选 run profile proposal。

扫描禁止：

- 写仓库或控制平面；
- `git fetch/pull/checkout/reset`；
- 安装依赖；
- 执行候选项目代码或 package scripts；
- 访问网络；
- 递归搜索整个用户目录；
- 读取 secrets 或其他项目内容；
- 自动创建 Task/worktree。

### 3.4 bounded 返回

scan 结果必须有固定上限和稳定顺序：

- 默认最多返回 20 个候选；
- 按 repoId 字典序；
- 超过上限返回 `truncated/nextCursor`；
- 每项仅返回 `repoId / registered / ready / blockers / detectedKind`；
- 不返回绝对路径、完整 Git config、remote credential 或文件内容。

## 4. 单一仓库注册工具

### 4.1 工具名称

删除：

- `grande_repo_add_propose`
- `grande_repo_add_apply`

新增一个稳定工具：

```text
grande_repo_register
```

### 4.2 为什么仍采用两阶段语义

工具数量合并为一个，不代表删除 stale-proposal 防护。注册会扩大 Gateway 的可信仓库范围、可读写路径和可执行 profile，因此必须继续具备：

- 注册前预览；
- Human Gate；
- proposal digest；
- 写入前重新检查；
- stale 时零写入。

MCP tool annotation 是静态的，不能根据一次调用处于 scan/propose/register 阶段动态改变。新工具按其最大能力声明为写工具：

```json
{
  "readOnlyHint": false,
  "destructiveHint": false,
  "openWorldHint": false
}
```

`destructiveHint=false` 只表示它不删除或破坏项目；它仍然是扩大可信范围的敏感写操作，服务端必须执行 Human Gate 语义。

### 4.3 输入协议

建议输入 schema：

```json
{
  "repoId": "optional string",
  "proposalDigest": "optional sha256 string",
  "cursor": "optional string",
  "maxCandidates": "optional integer, max 20"
}
```

不增加 `path`、`workspace`、`command`、`profile` 或 `force` 参数。

### 4.4 三种调用形态

#### A. 扫描候选

```json
{}
```

行为：

- 只读扫描 `GRANDE_WORKSPACE` 直接子目录；
- 返回已注册和未注册候选；
- 不生成可写 proposal；
- 不写 audit executing、registry 或 profiles。

#### B. 生成注册 proposal

```json
{
  "repoId": "my-project"
}
```

行为：

- 从可信 workspace root 推导路径；
- 完成 readiness 检查；
- 返回即将写入的 registry/profile 变化摘要；
- 返回绑定当前仓库与控制平面 pre-state 的 `proposalDigest`；
- 返回 `confirmationRequired: true`；
- 不写任何文件。

#### C. 确认并注册

```json
{
  "repoId": "my-project",
  "proposalDigest": "sha256:..."
}
```

行为：

1. 重新执行路径和 readiness 检查；
2. 重新计算 repo state 与 control-plane pre-state digest；
3. digest 不一致时返回 `STALE_STATE`，零写入；
4. readiness 不满足时返回 blocker，零写入；
5. Human 已确认后，原子写入可信 repos/profile 配置；
6. 写入 audit，记录 repoId、proposalDigest 和实际触及的控制文件；
7. 不修改候选项目文件；
8. 返回下一步 `grande_task_status` 或 `grande_task_open`。

### 4.5 Human Gate 规则

以下任一条件满足，agent 才能执行 C 阶段：

- Human 在当前任务中明确要求“注册 repoId”；
- Human 查看 proposal 后明确确认；
- ChatGPT/App 对该敏感写调用提供了明确用户确认。

Agent 不能因为以下情况自行推断授权：

- 用户只要求查看项目；
- scan 发现 ready repository；
- task_open 返回 repo 未注册；
- doctor 建议注册；
- 以前注册过另一个项目；
- proposal 没有 blocker；
- 项目位于 `GRANDE_WORKSPACE`。

服务端无法验证自然语言对话本身，因此 proposalDigest、写工具 annotation、audit 和 agent 行为规范共同构成门禁。不得增加一个由模型自行填写的 `humanConfirmed: true` 布尔值来伪装可信证明。

### 4.6 幂等性

- 已注册且配置与 proposal 一致：返回 `registered=true, existing=true`，不重复写；
- 已注册但可信配置不同：返回差异和新 proposal，要求再次确认；
- 同一 digest 重试：观察当前配置；已经成功则返回成功，不重复追加；
- 响应丢失：下次调用先观察 registry/profile 真实状态，不重复产生副作用。

### 4.7 CLI fallback

保留：

```bash
grande repo add my-project
grande repo add my-project --apply
grande doctor --repo my-project
```

CLI 与 MCP 必须复用相同的 inspect/apply domain primitive、digest 和 path security，不维护第二套注册语义。

后续可将交互式 CLI 优化为一次命令内显示 proposal 并询问确认，但非交互 `--apply` 仍必须重新检查 pre-state。

## 5. 其余公开能力简化

### 5.1 Capability：从平台抽象收敛为真实 adapter

当前真实控制平面存在一个只读 MCP provider，因此不删除外部 capability 能力，但进行以下收敛：

- 保留 `grande_capability_list`；
- 保留 `grande_capability_invoke`；
- 删除公开 `grande_capability_inspect`；
- `capability_list` 增加可选 `provider/name` filter，返回单项时等价于 inspect；
- 删除 native provider，避免把 GrandeGPT 自己的工具再次包装；
- production 未使用 plugin/skill 时删除对应 provider 类型；
- deployment 直接调用 provider domain service，不调用公开 capability handler；
- 不建设 marketplace、dependency graph 或动态 tool registration。

如果 production telemetry 证明外部 capability 长期没有真实调用，可以在之后的独立 tool epoch 中整体移除；本 Proposal 不直接删除当前已配置的 MCP provider。

### 5.2 Deployment：合并 deploy 与 verify

删除公开：

- `grande_deploy_verify`

保留并增强：

- `grande_deploy`：可重入；第一次启动 deploy，后续调用观察 deploy job 并启动/观察 verify，直到 DONE；
- `grande_deploy_rollback`：独立保留，始终需要 Human Gate。

约束：

- 每次调用最多推进一个有外部副作用的阶段；
- 响应丢失后先观察 receipt/远端状态；
- deploy 和 verify audit 仍分开记录；
- 不把 rollback 自动加入失败处理；
- 没有 `.grande/deploy.yaml` 的项目不显示 deploy blocker。

### 5.3 Task close：正常路径自动化

公开 `grande_task_close` 从正常 MCP tool contract 移除：

- PR merge 成功；
- canonical 已 clean + fast-forward-only 刷新到 merge SHA；
- 没有 running job；
- Task worktree 与 branch 精确匹配；
- cleanup guard 通过；

满足以上条件时，Gateway 自动关闭 Task 并清理 worktree/branch。

异常和放弃任务的清理由 CLI/控制台显式执行。cleanup 失败记录 residual 状态并交给 GC，不能把已发生的 merge 误报为未完成。

### 5.4 TaskBrief：只保存稳定意图

当前 TaskBrief 中 findings 和 plan 容易随着实现变化而变旧。建议仅持久化：

```text
goal
acceptanceCriteria[]
deliveryTarget
sourceRef?（可选，仅保留引用）
```

不再持久化：

- source type 枚举；
- repo findings；
- 详细 implementation plan。

当前事实和下一步从 Git、job、audit、receipt 与 `task_status.nextAction` 动态投影。

### 5.5 Run/result：减少常见测试的第二次调用

保留两个工具的清晰语义，但减少调用：

- `grande_run` 默认 bounded wait 5–10 秒；
- 短任务直接返回终态、摘要和 attestation context；
- 超过预算返回 jobId；
- `grande_run_result` 仅用于长任务和恢复；
- 不因减少一次调用而延长到不可控 MCP timeout。

### 5.6 PR status：按需诊断

正常流程可以直接调用 `grande_pr_merge`：

- merge 内部检查 exact PR head、CI、attestation 和 host receipt；
- 不满足时返回结构化 blocker；
- 只有需要展开 CI 失败细节时才调用 `grande_pr_status`；
- verifier 完成后的第二次 merge 调用由 agent 自动执行，不再次要求用户确认同一已授权任务。

不允许 verifier 子进程自行 merge；最终 merge 仍必须重新检查全部门禁。

### 5.7 Outer-test：从正常流程退出

auto verifier 完成稳定验收后：

- auto-safe smoke/full 不再要求用户运行 `grande outer-test`；
- manual outer-test 只保留 manual-only host case 和应急 fallback；
- receipt、SHA、plan/policy version 和重跑由 Gateway 管理；
- 不提供 unsandboxed candidate fallback。

### 5.8 CLI selfcheck：并入现有运维视图

独立 `grande selfcheck` 合并到：

- `grande gateway status`：LaunchAgent、endpoint readiness、runtime build；
- `grande doctor`：toolset epoch/count/digest 和客户端视角 read probe。

底层 selfcheck primitive 与测试保留，删除的只是重复 CLI 入口。

## 6. 任务交付目标简化

当前固定 Golden Path 对纯本地或只需 PR 的项目过重。TaskBrief 增加：

```text
deliveryTarget = local | pr | deploy
```

### 6.1 local

完成条件：

- acceptance criteria 满足；
- tests/profile 通过；
- 当前 commit 有 attestation；
- 用户未要求 push/PR/deploy。

不要求 PR、CI、merge、deploy 或 verify。

### 6.2 pr

完成条件：

- local 条件；
- push；
- PR；
- CI green 或明确允许 CI=none；
- exact-SHA merge；
- canonical refresh 与 cleanup。

### 6.3 deploy

完成条件：

- pr 条件；
- 项目显式存在可信 `.grande/deploy.yaml`；
- deploy + verify receipt 完成；
- production activation 如适用另行验证。

### 6.4 默认选择

- Human 明确要求部署：`deploy`；
- Human 明确要求 PR/合并：`pr`；
- 只有本地修改或没有有效远端：`local`；
- 意图不明确且存在 GitHub origin：默认 `pr`，但不得自动升级为 deploy；
- deliveryTarget 变化如果扩大外部副作用，必须重新获得 Human 确认。

`doctor` 和 `task_status` 只评估当前 deliveryTarget 需要的阶段。没有 deploy spec 对 local/pr 项目是 `not-applicable`，不是 readiness failure。

## 7. 开发与 Review 流程简化

### 7.1 L1 轻量变更

适用：文档、非运行资源、classifier 明确为 none。

产物和门禁：

- TaskBrief 或 PR 描述；
- 基础检查；
- 不创建独立 spec/plan/research；
- 不要求独立 reviewer 或 host verifier。

### 7.2 L2 标准变更

适用：普通业务源码和常规 bug，不触及核心安全边界。

产物和门禁：

- 一个简短 TaskBrief；
- TDD/行为测试；
- 普通 code review；
- 按 classifier 使用 none/smoke；
- agent 在授权范围内连续完成 Git/PR 流程。

### 7.3 L3 核心高风险变更

适用：sandbox、runner、Safe Git、auth、Gateway lifecycle、verifier、receipt、merge gate、DB migration、production policy。

产物和门禁：

- design spec；
- implementation plan；
- TDD；
- 独立 reviewer，不能 self-accept；
- full unit/typecheck/CI；
- full host verifier；
- production 变化需要 Human activation。

### 7.4 Pact 使用范围

Pact 只用于：

- GrandeGPT 自身 L3 开发；
- 明确的多 agent 并行；
- 用户要求的 reviewer/accept 分工。

普通单 agent 项目、L1/L2 bug 和文档任务不需要 Pact feature/task/accept 流程。

### 7.5 文档真相源

活文档只保留：

- `README.md`：稳定产品边界与 tool contract；
- `docs/BACKLOG.md`：当前问题和状态；
- operations runbook：部署、恢复和 runtime validation。

Spec、plan、research、prompt 和 closeout 是历史设计/evidence，不重复维护当前状态。

## 8. 目标公开工具变化

### 8.1 下一 tool epoch 的变化

| 当前工具 | 目标变化 |
|---|---|
| `grande_repo_add_propose` | 删除 |
| `grande_repo_add_apply` | 删除 |
| `grande_repo_register` | 新增，一个工具覆盖 scan/propose/register |
| `grande_capability_inspect` | 删除；并入 list filter |
| `grande_deploy_verify` | 删除；并入可重入 deploy |
| `grande_task_close` | 从公开 MCP 移除；正常完成自动 cleanup，异常走 CLI |

净变化：25 个公开工具预计收敛为 21 个。不要为了达到整数目标合并语义清晰、风险不同的核心工具。

### 8.2 保留的低频工具

- `grande_rollback`：checkpoint 恢复，是安全能力；
- `grande_run_result`：长任务恢复；
- `grande_sync_base`：长期 Task 吸收 canonical 更新，但只在需要时提示；
- `grande_deploy_rollback`：高风险独立 Human Gate；
- `grande_pr_status`：CI 失败诊断。

这些工具可以在描述、排序和 agent guidance 中标为 recovery/diagnostic，不进入默认 Golden Path。

## 9. 不应删除或弱化的能力

- Task/worktree 隔离；
- repoId/taskId/path 校验；
- `expectedSha256` 防并发覆盖；
- checkpoint/trash；
- fixed profile；
- Seatbelt；
- Safe Git；
- audit；
- commit-bound attestation；
- expected-SHA merge；
- CI、host receipt 和 PR head 一致性；
- production、credential、rollback Human Gate；
- SQLite 持久状态；
- manual fallback，但不能是 unsandboxed candidate execution。

简化的目标是减少重复表达和人工步骤，不是减少安全边界。

## 10. 实施顺序

### Phase A：无 tool contract 变化的流程简化

1. `grande_run` bounded wait；
2. PR status 按需调用；
3. agent 自动执行 verifier 后第二次 merge；
4. L1/L2/L3 文档与 reviewer 分级；
5. selfcheck 信息并入 gateway status/doctor；
6. 为 deliveryTarget、自动 cleanup 和新工具契约完成内部 domain primitive 与 RED tests，但不改变 production tools/list。

### Phase B：单次 tool epoch 收敛

在一个 release 中同时完成：

1. 两个 onboarding 工具替换为 `grande_repo_register`；
2. capability inspect 并入 list；
3. deploy verify 并入 deploy；
4. task close 从公开 MCP 移除；
5. TaskBrief 加入 deliveryTarget，并让 status 按 local/pr/deploy 投影完成条件；
6. bump toolset epoch；
7. Dev App scan/refresh；
8. 新聊天验证 tool count/digest；
9. production deployment；
10. Production App refresh；
11. Web/iOS 新聊天真实任务验证。

不使用临时别名同时暴露新旧工具；那会在过渡期把工具数进一步增加并造成模型选择歧义。rollback 直接切回上一 Gateway build/tool epoch。

### Phase C：内部代码删除与解耦

1. 删除 native capability provider；
2. 根据 production 配置证据删除未使用 plugin/skill provider；
3. deployment 改为领域服务调用；
4. 精简 TaskBrief schema 和旧字段兼容读取；
5. 自动 cleanup 与 GC residual 对账；
6. 删除重复 CLI command wiring，但保留底层 primitives。

### Phase D：Manual 到 Auto 收口

1. host verifier restart、cleanup、resource 和 exact-SHA gate 全部通过；
2. auto 模式连续至少 20 次 selfhost；
3. manual-only suite 仍有明确入口；
4. 无用户复制 receipt、运行 auto-safe outer-test 或判断 SHA；
5. 任何异常可切回 manual，不启用 unsandboxed fallback。

## 11. TDD 与验收要求

### 11.1 Repo register

必须覆盖：

- 只扫描 workspace direct children；
- 拒绝绝对路径、`..`、符号链接和 realpath escape；
- 不递归扫描 nested repository；
- scan/proposal 零写入；
- proposalDigest 绑定 repo HEAD/readiness 和 control-plane pre-state；
- stale digest 零写入；
- blocked repo 零写入；
- apply 只写可信 repos/profiles 配置；
- 已注册幂等；
- 响应丢失后 observe-before-retry；
- 注册后 doctor/task open 可用；
- 未经确认的 scan 不触发 register handler。

### 11.2 Tool contract

- 旧 25-tool identity 与新 identity 明确不同；
- 新 count、epoch、digest 稳定；
- 删除的名字不再出现在 tools/list；
- `repo_register` schema 不接受 path/force；
- capability list filter 覆盖原 inspect 行为；
- deploy 重入不重复外部副作用；
- task completion 自动 cleanup 不暴露通用删除接口。

### 11.3 Delivery target

- local 不要求 PR/deploy；
- pr 不要求 deploy；
- deploy 必须存在可信 deploy spec；
- target 扩大必须 Human confirmation；
- target 缩小不能伪造已发生的外部结果；
- status 只返回一个 blocker 和一个 nextAction。

### 11.4 回归门禁

- unit/selfhost；
- typecheck；
- tool contract budget；
- exact-SHA PR/receipt tests；
- onboarding real-path host probes；
- production Gateway selfcheck/doctor；
- Web 和 iOS 新聊天各完成一个真实任务；
- manual outer-test 保持可用直到 auto exit criteria 完成。

## 12. 错误与恢复语义

| 场景 | 结果 |
|---|---|
| workspace 内没有候选 | 返回空列表，不创建配置 |
| repo 不 ready | 返回 blockers，不生成可 apply digest |
| proposal 之后 HEAD/config 变化 | `STALE_STATE`，要求重新 proposal |
| registry 写入响应丢失 | 先观察当前配置；已成功则幂等返回 |
| deploy job 仍运行 | 同一 deploy 工具返回 running/jobId，不重复启动 |
| auto cleanup 失败 | merge 保持成功，记录 residual，交给 GC |
| tool snapshot 不匹配 | 不绕过；刷新 App 后新聊天验证 |
| 新 release 失败 | 回滚上一 Gateway build/tool epoch |

## 13. 明确不做

- 不自动注册 scan 发现的项目；
- 不递归扫描整个用户目录；
- 不允许任意 project path；
- 不增加 `humanConfirmed: true` 这类模型可伪造字段；
- 不建立项目 watcher 或后台同步 daemon；
- 不建立 workflow engine；
- 不把所有工具合成一个万能 continue 工具；
- 不动态改变每个 repo 的 MCP tool list；
- 不删除 checkpoint、audit、receipt 或 exact-SHA gate；
- 不因简化流程而自动执行 production、rollback 或 credential expansion；
- 不为兼容旧聊天长期同时暴露新旧工具。

## 14. 成功标准

该 Proposal 完成实施后应满足：

1. 项目发现永远限制在 `GRANDE_WORKSPACE` direct children；
2. 没有 Human 要求或确认时，项目永远不会被注册；
3. onboarding MCP 从两个工具变为一个；
4. 公开工具从 25 个收敛到约 21 个；
5. 普通项目不因缺少 deploy spec 被判定开发不可用；
6. local/pr/deploy 各自只执行必要阶段；
7. 普通短测试通常只需要一次 run 调用；
8. 用户不需要手工执行 auto-safe outer-test、复制 receipt 或再次确认同一任务的 merge；
9. GrandeGPT 的现有安全边界和 exact-SHA 证据链不降低；
10. CLI 继续提供 repo onboarding、诊断、GC 和 Gateway 故障恢复路径。

## 15. 最终建议

本 Proposal 推荐的不是“大幅删除功能”，而是把已开发能力分为三类：

- **核心保留**：Task/worktree、safe edit、sandbox、Git/PR、exact-SHA、audit、verifier；
- **公开面收缩**：onboarding、capability inspect、deploy verify、task close；
- **低频内部化**：cleanup、outer-test、selfcheck、Pact 和详细阶段文档。

仓库注册采用一个稳定的 `grande_repo_register` 工具，并继续使用 proposalDigest 与 Human Gate。这样既满足“用户可以在对话内注册项目”，也保证 scan 发现项目不会自动扩大 Gateway 的可信范围。

下一步应先由 Human Owner 审阅本 Proposal。确认后再编写分阶段 implementation plan；在此之前不修改当前 production tool contract。
