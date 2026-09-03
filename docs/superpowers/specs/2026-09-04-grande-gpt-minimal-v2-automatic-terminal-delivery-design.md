# GrandeGPT Minimal V2：自动 Terminal 与一次审批交付设计

**日期**：2026-09-04

**状态**：Approved for implementation planning — Human Owner 已批准最小 V2 边界；尚未实现

**取代**：`2026-08-28-grande-gpt-human-approved-terminal-execution-v1.md` 及其后续 V2 草案

**关联**：`GG-BL-024`、现有 `grande_run`、PR lifecycle、deployment receipt、Console Access gate

## 1. 目标

在不增加通用 shell、不扩大 Host execution 权限、不过度增加 Human Gate 的前提下，让 GrandeGPT：

1. 自动运行日常 terminal 任务，包括 test、build、lint、typecheck 和其他已注册验证；
2. 在代码、CI、attestation、Host verification 与部署配置全部就绪后，只请求一次 Human Owner 审批；
3. 让该次审批覆盖一条精确绑定的 `merge → deploy → verify` 连续交付链；
4. 在会话中断后，从持久化状态恢复，不重复 merge 或 production side effect；
5. 对 SHA、base、merge tree、部署目标、部署规格或可信 Policy 的任何漂移 fail closed。

本设计是对现有 runner、PR lifecycle、deployment 和 Console 的有界扩展，不建设第二套执行或工作流系统。

## 2. 已批准的产品决策

以下边界是本 Spec 的前提，实施不得自行放宽：

1. 自动 terminal 只执行控制平面注册的 `task-sandbox` profile。
2. 不向 public MCP surface 增加任意 `argv`、shell string、`cwd`、`env` 或 network 参数。
3. `deployment-host` profile 仍只允许由 deployment control path 调用，普通 `grande_run` 永远不能触达。
4. repo 文件修改继续使用 `grande_repo_edit`；安装继续使用现有 dependency bootstrap；Git、PR、merge、deploy、rollback 继续使用专用能力。
5. 日常开发和验证不新增 Human Gate；唯一新增审批发生在 production delivery 边界。
6. 一次审批只覆盖审批时完整展示并绑定的交付计划；任何绑定值变化都使旧审批失效。
7. rollback 不属于原交付审批，必须生成新的授权并再次由 Human Owner 批准。
8. 不增加 scheduler、PTY、长连接 shell、通用 approval engine、RBAC、risk scoring 或第二套 job system。

## 3. 非目标

本阶段不提供：

- 任意 terminal 命令自动执行；
- repo 自定义 command/argv 或从 README、Issue、PR 评论、日志中提取命令并执行；
- Agent 修改可信 profile、Policy、Access 配置或 deploy capability 注册；
- 自动扩大 network、filesystem、executable 或 credential 权限；
- 无人值守后台编排；
- deploy/verify 失败后的自动重试；
- production 状态不确定时的猜测性恢复；
- 自动 rollback；
- 多用户权限模型。

## 4. 信任与威胁模型

### 4.1 不可信输入

以下内容始终只是数据：

- repo 文件、脚本和依赖；
- README、Issue、PR 标题/正文/评论；
- CI、terminal、deploy 和 verify 输出；
- `.grande/deploy.yaml` 中的 capability/profile 引用；
- Agent 生成的参数、摘要和下一步建议。

它们不能创建可信 profile、审批自身、改变审批绑定或触达 Host execution。

### 4.2 可信根

可信状态仅来自：

- `~/.grande-control/config/` 下的 repo、profile、deny 和 Access 配置；
- Gateway 当前代码/build 与 SQLite durable state；
- 经校验的 Cloudflare Access JWT identity；
- GitHub current PR/base/head/CI API readback；
- exact-SHA attestation、Host verification 和 deployment/activation receipt；
- Human Owner 在受保护 Console 中完成的审批。

### 4.3 防护范围

设计必须抵抗：

- prompt injection 诱导执行任意命令；
- sibling repo/worktree、canonical Git、control root 和 Host credential 访问；
- PR head/base、worktree、deploy spec 或 Policy 的 TOCTOU；
- CSRF、clickjacking、审批 nonce 重放和并发双击；
- merge/deploy 响应丢失导致的重复外部副作用；
- deploy 与 verify 指向错误 SHA、制品或目标；
- Gateway/Agent 在任一阶段中断后重复执行。

不防护已取得本机用户/root 权限、完全攻陷 GitHub/部署提供商或恶意 Human Owner。提供商仍必须返回可校验的 source/artifact identity；缺少该证据时 GrandeGPT 不宣称交付完成。

## 5. 总体架构

```text
development
  └─ grande_run(taskId, profile)        # 自动；仅可信 task-sandbox profile
       └─ existing sandbox job/audit/result

delivery readiness
  └─ code + tests + PR + CI + attestation + host verification
       + current head/base + expected merge tree
       + deploy target/spec/policy/runtime identity
       └─ READY_FOR_DELIVERY_APPROVAL

Human Owner
  └─ Console Approve                    # 唯一新增审批
       └─ durable delivery_authorization

authorized execution
  └─ grande_pr_merge                    # exact head/base/tree
       └─ canonical refresh
            └─ grande_deploy            # reentrant deploy/verify
                 └─ source/artifact readback
                      └─ durable receipt / DONE
```

不增加公开 approval tool。Agent 只能读取授权状态，不能生成已批准状态。

## 6. 自动 Terminal 边界

### 6.1 Public contract

`grande_run` 保持现有输入：

```json
{
  "taskId": "task_...",
  "profile": "unit-selfhost"
}
```

不得增加：

```text
argv / command / shell / cwd / env / network / executable
```

### 6.2 执行来源

profile 只能从可信控制平面的 `profiles.yaml` 读取。repo 可以引用已批准的 deployment profile，但不能定义或覆盖 profile 的 argv、execution、timeout、network、toolchain 或资源上限。

普通 `grande_run` 必须继续通过 `getProfile()` 拒绝 `execution=deployment-host`。该边界由服务端强制，不依赖工具描述或 Agent 自律。

### 6.3 自动化语义

Agent 可以在无需 Human 输入的情况下：

1. 选择任务已注册的开发/验证 profile；
2. 调用 `grande_run`；
3. 在 bounded wait 未结束时使用稳定 jobId 恢复；
4. 调用 `grande_run_result` 直到获得一个终态结果；
5. 根据失败结果修改代码并再次运行 profile。

“自动 terminal”只表示 Agent 自动驱动已注册能力，不表示 Gateway 接受通用 terminal 输入。

### 6.4 现有沙箱约束保持不变

- deny-default Seatbelt；
- 普通 job 默认无网络；
- scrubbed `HOME`、`TMPDIR` 与环境；
- 无 Host credentials、control root、sibling repo/worktree 或 canonical write access；
- profile 级 timeout、RSS 与 output bound；
- process-group kill 与 durable job state；
- 依赖 bootstrap 只走现有受控例外。

V2 不声称消除 Seatbelt 缺少 cgroup/PID/disk quota 的已接受剩余风险。拒绝通用 argv 是避免扩大该风险的主要控制。

## 7. Delivery readiness

只有 `deliveryTarget=deploy` 的任务进入本设计的 production approval flow。`local` 与 `pr` 任务保持现有流程。

### 7.1 Target 选择

`grande_task_open` 在 `GG-BL-024` 的正式 Tool Epoch 中增加可选字段：

```ts
deliveryTarget?: "local" | "pr" | "deploy"
```

- 未提供时继续采用现有安全默认：GitHub origin 为 `pr`，否则为 `local`；
- `deploy` 必须显式提供，不能从 repo 文件、README、已有 receipt 或 Agent 猜测中自动升级；
- target 在 Task 创建后不可变；已有 Task 如需从 `pr` 改为 `deploy`，应关闭后创建新 Task；
- 选择 `deploy` 只允许准备交付证据，不等于 Human 已授权 production side effect。

这是 Minimal V2 唯一必需的 public input-schema 增量。

### 7.2 就绪条件

Gateway 只有在以下条件全部满足时才能创建 `READY` authorization proposal：

- task 存在，worktree clean，且 HEAD 等于 current PR head；
- PR open，base ref 符合任务目标；
- current PR head 与 local task HEAD 一致；
- required CI 为 success；
- required attestation 精确绑定 current head SHA；
- required Host verification receipt 精确绑定 current head SHA；
- canonical checkout clean，可安全 refresh 到 current base；
- `.grande/deploy.yaml` 可完整解析，deploy 与 verify action 均有效；
- deploy/verify 引用的 profile/capability 由可信控制平面注册且 role 匹配；
- current base SHA 已读取；
- `merge_method=merge` 可用；
- `git merge-tree --write-tree <baseSha> <headSha>` 成功并产生唯一 `expectedMergeTree`；
- 没有 running terminal/deploy/verify job；
- 没有同 task 的其他非终态 delivery authorization。

任何条件不满足时，只返回 blocker；不创建可审批 nonce，不产生 production side effect。

### 7.3 Approval summary

Console 必须展示 Human 可判断的 bounded 摘要：

- repoId、taskId、PR number 与目标环境；
- head SHA、base SHA、base ref、固定 merge method；
- expected merge tree identity；
- CI、attestation 和 Host verification 状态；
- deploy/verify action ref 与 `deploySpecDigest`；
- trusted `policyDigest`、Gateway runtime build 与 toolset identity；
- authorization 创建时间、审批有效期；
- rollback 是否配置，并明确标注“不包含在本次审批”。

不得把 terminal/CI/PR 文本按 HTML 渲染；所有外部文本必须转义并做长度限制。

## 8. Authorization binding

### 8.1 Binding 内容

authorization binding 是 canonical JSON，字段顺序稳定，digest 使用 SHA-256。公共字段与 delivery binding 为：

```ts
interface AuthorizationCommon {
  authorizationKind: "delivery" | "rollback";
  taskId: string;
  repoId: string;
  worktreeRealpath: string;
  deliveryTarget: "deploy";
  deployTarget: string;
  deploySpecDigest: string;
  policyDigest: string;
  runtimeBuild: string;
  toolsetEpoch: number;
  toolsDigest: string;
  createdAt: number;
  expiresAt: number;
}

interface DeliveryAuthorizationBinding extends AuthorizationCommon {
  authorizationKind: "delivery";
  prNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  mergeMethod: "merge";
  expectedMergeTree: string;
  deployRef: string;
  verifyRef: string;
}

interface RollbackAuthorizationBinding extends AuthorizationCommon {
  authorizationKind: "rollback";
  currentDeploymentId: string;
  currentSourceSha: string;
  rollbackDeploymentId: string;
  rollbackSourceSha: string;
  rollbackArtifactDigest?: string;
  rollbackRef: string;
}
```

rollback proposal 只能从部署平台 readback 得到 current 与 rollback target 的 immutable identity 后创建；不能用“previous”“latest good”或其他执行时才解析的别名。不能解析 exact rollback target 时，GrandeGPT 拒绝自动执行 rollback，交由 Human 运维处理。

`policyDigest` 只覆盖本次交付真正依赖的可信配置：repo registration、相关 sandbox/deployment profile、capability role、deny policy 与 target mapping。无关配置变化不应制造 stale。

### 8.2 时间边界

- `READY` proposal 固定在创建后 15 分钟过期；
- Human approval 不延长该期限；
- 必须在 `expiresAt` 前由第一步执行 CAS 进入 `EXECUTING`；
- 进入 `EXECUTING` 后有固定 60 分钟 execution deadline；
- 已启动且具有相同 durable jobId 的 job 可以被观察到终态，但 deadline 后不得启动下一项 side effect；
- deadline 到达且交付未完成时终结为 `EXPIRED`，后续动作需要新审批。

时间值是 V2 固定常量，不新增可由 repo 控制的超时配置。

### 8.3 SQLite 记录

新增一张附属表，不改变既有 Task 状态机：

```sql
CREATE TABLE IF NOT EXISTS delivery_authorization (
  authorizationId TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  taskId           TEXT NOT NULL REFERENCES task(taskId),
  bindingJson      TEXT NOT NULL,
  bindingDigest    TEXT NOT NULL,
  nonceDigest      TEXT NOT NULL,
  status           TEXT NOT NULL,
  approverSub      TEXT,
  approverEmail    TEXT,
  approvedAt       INTEGER,
  executingAt      INTEGER,
  executionDeadlineAt INTEGER,
  stageJson        TEXT NOT NULL,
  reason           TEXT,
  createdAt        INTEGER NOT NULL,
  updatedAt        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_authorization_active_task
ON delivery_authorization(taskId)
WHERE status IN ('READY', 'APPROVED', 'EXECUTING');
```

同一 task 最多允许一条 `READY | APPROVED | EXECUTING` 记录。新 proposal 不改写旧记录；旧记录进入终态后创建新 authorizationId，以保留审计历史。

### 8.4 状态机

```text
READY
  ├─ APPROVED
  ├─ REJECTED
  ├─ STALE
  └─ EXPIRED

APPROVED
  ├─ EXECUTING
  ├─ REVOKED
  ├─ STALE
  └─ EXPIRED

EXECUTING
  ├─ SUCCEEDED
  ├─ FAILED
  ├─ UNCERTAIN
  ├─ STALE
  └─ EXPIRED
```

所有状态转移使用带 expected current status 与 binding digest 的 SQLite CAS。失败的 CAS 表示另一个请求已推进状态，本次请求必须零执行返回当前状态。

`stageJson` 只记录 `merge / deploy / verify` 的 pending、running、succeeded、failed、uncertain 及关联 receipt/job ID。它不能修改 binding。

## 9. Console approval boundary

### 9.1 Route

Console 增加两个专用写端点：

```text
POST /console/delivery/:authorizationId/approve
POST /console/delivery/:authorizationId/reject
```

请求体只接受：

```json
{
  "bindingDigest": "sha256:...",
  "approvalNonce": "base64url..."
}
```

不接受 `approved=true`、approver、taskId、SHA、target、command 或 deploy 参数。

### 9.2 身份与请求完整性

每个请求必须依次满足：

1. 经 Console 独立 Cloudflare Access audience 校验；
2. 从已校验 JWT 读取 `sub/email`，不得信任请求体身份；
3. `Origin` 精确等于 `access-console.yaml` 中可信配置的 Console origin；
4. method 为 POST，`Content-Type` 为 `application/json`；
5. authorizationId、bindingDigest 与 durable row 一致；
6. nonce 至少 256 bit、服务端生成、只存 digest、与 authorization 和 expiry 绑定；
7. authorization 尚未过期且状态允许本次转移；
8. 单事务 CAS 写入 approval/rejection identity 与时间。

Console 页面必须返回至少以下响应头：

```text
Content-Security-Policy: default-src 'self'; frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

审批或拒绝成功后 nonce 即失效。同一请求因响应丢失而重放时，只能返回已经存在的相同终态，不得重新触发执行。

### 9.3 Human Gate 语义

点击 Approve 仅产生 durable authorization，不在 HTTP handler 内同步执行 merge/deploy。Agent 或后续会话通过现有 GrandeGPT 工具推进交付。

Reject 对 `READY` 产生 `REJECTED`；对尚未开始执行的 `APPROVED` 产生 `REVOKED`。进入 `EXECUTING` 后页面不能声称能撤销已经发生的 side effect，只能显示当前 stage 与运维动作。

相同页面也可以展示 `authorizationKind=rollback` 的独立 proposal，但必须清楚并列 current deployment 与 exact rollback target；审批 delivery proposal 永远不能被解释为批准 rollback。

## 10. 授权执行链

### 10.1 启动

authorization 由计划中第一个尚未完成的 side-effect stage 启动：

- 正常 happy path 从 merge 开始，由 `grande_pr_merge` 启动；
- durable exact merge receipt 已存在的新授权从 deploy 开始，由 `grande_deploy` 启动；
- rollback authorization 只由 `grande_deploy_rollback` 启动。

对应工具在任何外部 mutation 前：

1. 查找唯一 `APPROVED` authorization；
2. 验证 authorization kind 与调用 stage 匹配；
3. 重新读取并重新计算该 stage 所需的全部 binding；
4. 比较 authorization digest；
5. 验证未过期；
6. 原子 CAS `APPROVED → EXECUTING` 并记录 deadline；
7. 之后才允许调用外部 API 或启动 deployment-host process。

merge stage 还必须再次确认 current PR head、base SHA 和 expected merge tree。任何失败或漂移返回 `STALE_STATE`，不发送外部请求。

### 10.2 Merge binding

V2 固定使用 GitHub `merge` method，不接受 repo/Agent 动态选择 squash 或 rebase。

merge API 必须同时绑定 expected head SHA。merge 成功并 refresh canonical 后，Gateway 验证：

- returned merge SHA 等于 canonical HEAD；
- merge commit 的两个 parent 按顺序为 `baseSha` 与 `headSha`；
- merge commit tree 等于 `expectedMergeTree`；
- canonical clean；
- task HEAD 仍等于已批准 head SHA。

任一检查失败，authorization 进入 `UNCERTAIN`，不得继续 deploy。不能因为 GitHub 返回 `merged=true` 就推断 tree 正确。

验证完成后，Gateway 创建或确认一个固定在 `mergeSha` 的 clean pinned release source，并把其 realpath、HEAD、tree identity 写入 merge stage receipt。后续 deployment-host profile 的 cwd 必须是该 release source；capability action 必须显式接收 immutable merge SHA/artifact identity。不得回退为部署调用当时的 canonical `main`，因为 canonical 可能已经被其他任务推进。

pinned checkout 只是执行输入，不单独构成“实际发布了该 SHA”的证据。若 deployment-host profile 从可变 cwd 构建，而部署平台不能 read back 同一 source SHA 或 immutable artifact digest，则该 profile 不满足 V2 readiness，不能用于自动交付。

### 10.3 Deploy 与 verify

`grande_deploy` 保持 reentrant：

- merge stage 未成功时拒绝 deploy；
- deploy 尚未启动时启动一次；
- 已有 deploy job/receipt 时只观察同一个 operation；
- deploy 成功后推进 verify；
- verify 已成功时返回现有 DONE receipt；
- 不重复外部 side effect。

每次准备启动新 stage 前都必须验证：

- authorization 仍为 `EXECUTING`；
- current stage 的 spec、target、policy/runtime inputs 与 bound values 一致；
- execution deadline 未过；
- 上一 stage 的 durable receipt 完整。

### 10.4 Exact deployment evidence

deploy action 必须返回规范化 evidence：

```ts
interface DeploymentEvidence {
  target: string;
  deploymentId: string;
  sourceSha: string;
  artifactDigest?: string;
}
```

evidence 的承载方式固定为：

- capability action：从经过 schema 校验的 structured result 读取；
- deployment-host profile：Gateway 提供 per-job `GRANDE_DELIVERY_EVIDENCE_FILE`，profile 原子写入一份 bounded JSON；
- free-form stdout/stderr、日志中的 SHA 文本或 Agent 总结不能作为 evidence。

deploy target 由可信 action resolver 根据 profile/capability 注册和已绑定参数规范化得到。无法得到稳定 target identity 时 readiness 必须 blocked，不能用显示名称或自由文本代替。

`sourceSha` 必须等于已验证 merge SHA。若平台以 immutable artifact 发布，则还必须记录 artifact digest；verify 必须 read back 同一个 deploymentId/target/sourceSha，并在使用 artifact 时核对 digest。

明确返回了错误 source/target identity 时进入 `FAILED`；缺少 identity、响应丢失或无法确认 side effect 时进入 `UNCERTAIN`。两种情况都不得自动重试。

### 10.5 成功终态

只有以下证据同时存在时 authorization 才能进入 `SUCCEEDED`：

- exact merge receipt；
- canonical refresh receipt；
- deploy receipt；
- verify readback receipt；
- deployed source SHA 等于 authorized merge SHA；
- target/spec/policy digest 一致。

若部署对象是 GrandeGPT Gateway 本身，还必须复用现有 activation receipt，证明 runtime build、tool epoch/count/digest、restart readiness 和 trusted read probe 全部匹配。

## 11. 错误、恢复与重试

| 场景 | 状态 | 自动行为 |
|---|---|---|
| 审批前 head/base/spec/policy 漂移 | `STALE` | 零执行；生成新 proposal |
| merge 请求前 CAS 失败 | 返回当前状态 | 零执行 |
| GitHub 明确拒绝 merge | `FAILED` | 不重试；需要新审批 |
| GitHub 返回丢失，无法确认是否 merge | `UNCERTAIN` | 只允许 readback/reconcile，不再次 merge |
| merge 成功、本地 refresh 失败 | 保持 merge 已成功证据 | 只做 canonical reconcile，不重复 remote merge |
| deploy 明确失败 | `FAILED` | 不自动重试；需要新审批 |
| deploy 响应不确定 | `UNCERTAIN` | Human 先到部署平台确认；不自动重试 |
| verify 失败 | `FAILED` | 不自动 redeploy；需要新审批或新 rollback 授权 |
| verify 响应不确定 | `UNCERTAIN` | 只允许 readback，不触发新 deploy |
| Agent/Gateway 中断 | 保持 durable stage | 下一会话只恢复同一 job/receipt |
| deadline 到达 | `EXPIRED` | 不启动下一 side effect；需要新审批 |

新授权可以根据 durable receipt 只覆盖尚未完成的剩余阶段。例如 merge 已被证明完成而 deploy 失败，新 proposal 绑定现有 merge SHA，只授权 `deploy → verify`，不重复 merge。

rollback 始终创建 `authorizationKind=rollback` 的独立 proposal，明确展示 current deployment、rollback action、exact target version/artifact，再走相同 Console approval/CAS/receipt 边界。`grande_deploy_rollback` 在任何外部调用前必须消费这一独立授权；delivery authorization 永远不满足该检查。

## 12. Agent 与公开工具行为

### 12.1 Task projection

`grande_task_status`/TaskProgress 增加授权投影和单一 `nextAction`：

- `READY_FOR_DELIVERY_APPROVAL`：Agent 停止推进 production side effect，并提示 Human 打开 Console；
- `DELIVERY_APPROVED`：调用 `grande_pr_merge`；
- `DELIVERY_EXECUTING`：根据 stage 调用 merge reconcile 或 reentrant `grande_deploy`；
- `DELIVERY_UNCERTAIN`：停止自动动作，展示 Human readback 指引；
- `DELIVERY_FAILED`：停止自动动作，要求新授权或 rollback 决策；
- `DELIVERY_DONE`：返回 exact source/target/receipt 摘要。

Agent 不轮询 Human approval endpoint，也不能调用 Console approve route。

### 12.2 自动化的真实含义

V2 不增加 Gateway scheduler。正常情况下，Agent 在一次对话回合内根据 `nextAction` 继续调用现有工具；如果会话停止，durable state 允许后续会话恢复。

因此“自动 deploy”表示审批后无需 Human 逐步确认 merge、deploy、verify，不表示离线 Gateway 会主动启动尚未开始的下一阶段。

### 12.3 Public tool epoch

本设计不新增 public terminal/approval tool。`grande_task_open.deliveryTarget` 是必需的 public schema 变化，必须作为 `GG-BL-024` 的一次正式 Tool Epoch 发布。若该 epoch 同时按既有 Phase 9 设计合并 `grande_deploy_verify`，也必须在同一次发布完成，不能再制造第二次临时 epoch：

- 一次性修改 tool names/schema/annotations；
- bump toolset epoch；
- Dev/Production App refresh；
- fresh-conversation target-client verification；
- 记录 count/digest/build；
- 保留上一 Gateway build 的 rollback 路径。

当前 backlog 中 `GG-BL-024` 的 status 与已关闭的 `GG-BL-010` 文字存在不一致。实施前必须单独校准该 sequencing；本 Spec 不自行把 blocked 改成 ready。

## 13. 审计与隐私

以下事件必须进入审计账本或专用 durable receipt：

- readiness proposal 创建、stale、expire；
- approve、reject、revoke；
- authorization execution CAS；
- merge request/readback/reconcile；
- deploy/verify start、result、uncertain；
- delivery success；
- rollback proposal 与执行。

审计记录绑定 authorizationId、taskId、bindingDigest、stage、verified approver `sub`、时间和结果。现有 audit input 仍只保存 digest，不写完整 terminal 输出、JWT、nonce、credential 或 capability secret。

UI 与工具返回只展示必要 identity 摘要；绝对控制平面路径、Host HOME、token、完整环境和 provider secret 不得返回。

## 14. 验收标准

### 14.1 Terminal boundary

- `grande_run` schema 不出现 argv/command/shell/cwd/env/network；
- control-plane `task-sandbox` profile 可自动完成 failing → passing 验证；
- `deployment-host` profile 通过 `grande_run` 必须 fail closed；
- repo 内伪造 profile/deploy argv 不生效；
- network、sibling、canonical Git、control root 与 Host credential 破坏性测试继续通过。

### 14.2 Authorization binding

分别改变 head SHA、base SHA、merge method/tree、worktree realpath、deploy target、deploy spec、相关 profile/capability、policy digest、runtime build 和 toolset identity；每项都必须使旧 authorization 返回 `STALE_STATE` 且零外部副作用。

### 14.3 Merge exactness

- base 在审批后移动时拒绝 merge；
- head 在审批后移动时拒绝 merge；
- unexpected merge parent 或 tree mismatch 时禁止 deploy；
- merge 响应丢失后只 reconcile，不发送第二个 merge request；
- canonical refresh 后 HEAD 必须等于 recorded merge SHA。

### 14.4 Console security

- 无 JWT、错 audience、过期 JWT 均为 403；
- wrong/missing Origin、非 JSON、wrong digest、missing/expired nonce 均拒绝；
- approver 只能取自 JWT；
- 两个并发 approve 最多一个 CAS 成功；
- response-loss replay 不产生第二次状态转移或执行；
- 页面包含 CSP/frame/nosniff/referrer headers；
- 恶意 PR 标题、日志和 target 文本不能注入 HTML/script。

### 14.5 Deploy/verify

- 一次 approval 的 happy path 完成 merge → deploy → verify，只产生一个 deploy operation；
- deploy source SHA 与 authorized merge SHA 不一致时失败；
- 缺少 source identity 时不能进入 DONE；
- deploy/verify uncertain 时不自动重试；
- 会话中断后只恢复相同 job/receipt；
- expired authorization 不启动下一 side effect；
- rollback 没有新授权时拒绝。

### 14.6 Release gate

- focused RED → GREEN tests；
- full relevant suite 与 typecheck 通过；
- Console 属于 production destructive/auth UI，按仓库 T3 前端流程完成最终 build 浏览器实测、截图和独立 Review/Verification；
- exact candidate SHA 完成 Host verification；
- public contract 变化只在单次 Tool Epoch 发布；
- production activation receipt/readback 与 candidate build/tool identity 完全一致。

## 15. 最小实现范围

实现计划只能覆盖以下有界变更：

1. 一个 `delivery_authorization` domain/table 与 delivery/rollback binding、digest/CAS helper；
2. readiness/binding 计算与 exact merge tree 校验；
3. 两个 Console approval routes 和一个小型 Approve/Reject UI；
4. `grande_pr_merge`、`grande_deploy` 与 TaskProgress 对 authorization 的复用；
5. deployment/verify evidence 增加 exact source/artifact identity；
6. 与 `GG-BL-024` 对齐的一次 public contract activation。

以下需求出现时必须停止并另开设计，不得塞入本 V2：任意命令、PTY、后台 scheduler、通用工作流 DSL、通用审批中心、多用户 RBAC、自动 rollback 或新的部署提供商抽象层。

## 16. 设计结论

Minimal V2 的核心不是“给 Agent 一个 terminal”，而是让 Agent 自动使用已经批准的窄能力，并把 Human 注意力集中在唯一不可逆的 production delivery 边界。

最终安全性质是：

> Human 批准的是一个由 head、base、merge tree、target、deploy spec、Policy 与 runtime identity 唯一确定的交付计划；GrandeGPT 只能执行这一个计划一次。任何漂移、失败、不确定性或 rollback 都不能继承旧授权。
