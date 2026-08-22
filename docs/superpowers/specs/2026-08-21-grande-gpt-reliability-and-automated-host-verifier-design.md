# GrandeGPT 轻量运行可靠性与自动 Host Verifier 设计

**状态：** Proposed，等待 Human Owner 审阅

**日期：** 2026-08-21

**范围：** GrandeGPT 单机 Gateway、自举验证与连续任务 Golden Path

## 1. 背景

GrandeGPT 定位于个人开发者、小团队和中小型项目。它不是通用工作流平台，也不应为了可靠性引入分布式锁、独立调度集群、事件溯源、企业审批系统或多 repo DAG。目标是在现有单机架构上，同时做到：

- 候选仓库内容始终不可信，安全边界不因自动化而降低；
- 正常开发流程流畅，用户发出任务后不需要逐步确认；
- Gateway、网络或测试进程出现瞬态故障时能够收敛或给出唯一恢复动作；
- 一个 agent 能连续完成多个中小任务，不因 stale canonical、残留 worktree、永久 running job 或手工 outer-test 中断；
- GrandeGPT 自举修改仍有可信的宿主行为验证。

当前 `unit-selfhost` 为了避免嵌套 Seatbelt、真实 job 和真实端口问题，整文件排除了 `sandbox.test.ts`、`runner.test.ts`、`server.test.ts`、`tools.test.ts` 和 `e2e.test.ts`。这使大量本可在普通沙箱中运行的断言被迫进入人工 host outer-test。现有 CLI 已能把一次人工 outer-test 绑定到 clean task HEAD，并由 `grande_pr_merge` 对 exact SHA 做 fail-closed 检查，但仍需要 Human Owner 在宿主手动执行命令。

本设计把可靠性收敛到少数不可绕过的基础设施，并把 outer-test 改造成由同一 Gateway 调度、在专用受限子进程中执行的自动 host verification。Gateway 主进程不 import 候选代码，不新增通用宿主执行能力。

## 2. 设计原则

### 2.1 简单性优先

保留现有单机、单 Gateway、SQLite、Git worktree 和 LaunchAgent 模型。新增能力必须复用现有 task、job、audit、attestation 与 outer-test receipt；不新建工作流引擎或独立 verifier 服务。

### 2.2 自动化不能降低信任边界

测试文件白名单只能限制入口，不能限制被 import 的候选代码。自动 host verification 必须同时具备固定执行计划、专用 Seatbelt、清洁环境、不可变 SHA、资源上限与父进程签发 receipt。只做文件名白名单后在宿主用户权限下直接运行不被接受。

### 2.3 正常路径不询问，异常路径不猜测

已注册仓库、已批准 profile 和 `grande/*` task branch 上的 inspect、edit、test、commit、push、PR、CI、host verification、merge、canonical refresh 与 cleanup 可在一次用户授权的开发任务内连续执行。只有权限扩张、生产首次启用、rollback、canonical dirty/diverged、无法自动解决的冲突、凭据问题或外部状态无法判定时才请求用户。

### 2.4 exact SHA 是所有验证的共同主键

本地 attestation、远端 CI、host verification、PR head、merge expected SHA 和 deployment receipt 必须指向同一 commit。新 commit 自动使旧验证失效，不使用时间窗口或“最近通过”替代 SHA 相等。

### 2.5 不把等待包装成同步长调用

host verification、CI 和 deployment verify 以异步 job 表达，异步 job 仍保持异步。MCP 调用不得同步阻塞几十秒到数分钟；job 创建后立即返回 `jobId` 和下一步提示。客户端收到提示后只发起一次 `grande_run_result`；result handler 可以在一个短、有界的 interval 内等待终态，若仍未完成则再次返回 `running` 与下一步提示。status/result 轮询必须有界并合并（coalesced）：同一逻辑状态不重复请求或重复传输，等待中的 agent 可推进独立工作，不需要用户介入。

每个会话都受 conversation/output budget 约束：source、search 和 diff 使用分页或行范围；有紧凑操作可用时不传整文件重写；同一逻辑 payload 只能存在于 MCP `content` 或 `structuredContent` 之一，绝不在两者重复返回。该约束减少可控的上下文压力；观察到的调用次数是调查样本，不是固定配额结论。

## 3. 目标与非目标

### 3.1 目标

1. 把 Git 安全参数、错误分类和凭据策略集中到一个轻量执行模块。
2. 同一 repo 的 Git 写操作在 Gateway 进程内串行，不同 repo 可并行。
3. Gateway 启动时对账残留 job/audit，并让 agent 得到明确 next action。
4. merge 后自动刷新 canonical 并清理已完成 worktree，下一任务不会从 stale base 开始。
5. 将现有 outer-test 按真实宿主能力拆分，普通断言回归 `unit-selfhost`。
6. 在同一 Gateway 中自动调度专用受限 host verifier，签发 exact-SHA receipt。
7. 保留人工 CLI fallback，但正常自举任务不再要求用户手工运行 outer-test。
8. 支持 agent 连续处理多个任务；一个任务等待 CI/verification 时不阻塞其他独立任务的调研与编辑。

### 3.2 非目标

- 不增加通用 `host_exec`、`shell_exec`、`unsandboxed: true` 或任意 argv MCP 工具。
- 不增加独立 verifier daemon、独立 macOS 用户、远程 runner 或执行集群。
- 不实现分布式锁、租约服务、事件溯源、通用 workflow/DAG 或 release train。
- 不让 Gateway 在后台无人授权地自动 merge；一次显式 `grande_pr_merge` 可启动 verification，verification 通过后由 agent 再次调用 merge。
- 不强制所有接入项目采用同一 coverage、lint 或 CI 体系；继续复用项目已批准 profile 和现有 CI。
- 不允许候选仓库控制 verifier argv、Seatbelt profile、测试分级、receipt 内容或自动化模式。
- 不以增加并发为目标；默认每次只运行一个 host verifier。

## 4. 目标运行模型

```text
用户任务
  → agent inspect / plan / edit
  → unit-selfhost + project gates
  → commit exact SHA
  → push / PR / CI
  → grande_pr_merge
       ├─ receipt 已存在且匹配 SHA → 执行 merge
       └─ receipt 缺失
            → Gateway 调度 host verifier job
            → tool 返回 VERIFYING + jobId，不阻塞 MCP
            → client 按提示发起一次 result 请求；handler 短暂有界等待
            → 未终态则返回 coalesced running 状态与下一步提示，agent 推进独立工作
            → verifier pass：Gateway 签发 exact-SHA receipt
            → agent 再次调用 grande_pr_merge
  → canonical safe refresh
  → task/worktree cleanup
  → agent 开始下一任务
```

Gateway 负责安全执行、持久状态和恢复；agent 负责需求理解、代码推理、失败修复和连续任务选择。Gateway 不持有通用任务 DAG。

## 5. 轻量可靠性内核

### 5.1 单一 Safe Git 执行器

新增一个小型 Git 执行模块，替代生产路径中散落的直接 `execFileSync("git", ...)`。它不是 policy DSL，仅提供几种固定能力：

```ts
safeGit.local(cwd, args, options?)
safeGit.github(cwd, args, token, options?)
safeGit.diff(cwd, args, options?)
safeGit.tryRelation(cwd, ancestor, descendant)
```

所有模式统一：

- 使用 argv 数组，不经过 shell；
- 覆盖 `core.hooksPath=/dev/null`；
- 设置有限 wall timeout；
- 统一 stdout/stderr 上限、错误码与路径/凭据脱敏；
- 写操作由调用方提供 expected branch/HEAD，并在副作用前验证；
- 本地错误不自动重试。

`github` 模式额外：

- 清空 `credential.helper`；
- 设置 `GIT_TERMINAL_PROMPT=0`；
- 只使用 control plane 专用 token；
- 绝不回退到环境变量、Keychain、SSH agent 或宿主 credential store；
- push source 使用已验证的不可变 SHA，destination 只能来自 task branch。

`diff` 模式额外：

- 固定 `--no-ext-diff --no-textconv`；
- 正确处理 `git diff --no-index` 的 exit 1；
- 不执行 pager、filter helper 或仓库声明的外部 diff 程序。

对于 checkout clean/smudge/process filter，第一版不构建通用 filter 虚拟化。注册仓库仍属于 Human Owner 信任域；verifier 使用专用 Seatbelt 限制 filter 即使执行也无法读取 secrets、写 canonical 或访问外网。若未来允许不可信 repo registration，再单独提升该边界。

### 5.2 Repo 级进程内串行

Gateway 内维护 `Map<repoId, Promise>` 形态的单机 mutex，并提供：

```ts
withRepoWriteLock(repoId, operation)
```

以下操作必须持有 repo write lock：

- task open 中的 canonical refresh 与 worktree creation；
- commit、sync-base、push；
- PR merge 前后 canonical refresh；
- deployment activation/rollback；
- task close、worktree/branch cleanup 与 GC apply。

read/search/diff/status 和已隔离 worktree 内的测试不占 repo write lock。不同 repo 可以并行。同一 repo 等待 CI 或 host verifier 时不长期占锁；真正执行 merge/refresh 时重新获取并重新验证 SHA/branch。

锁不持久化。Gateway 重启后先执行启动对账，再开放写工具，因此不需要数据库 lease 或分布式锁。

### 5.3 启动对账与幂等恢复

复用现有 `job` 状态和 `finishJob` CAS：

- 无存活进程组的 running job 收敛为 killed；
- 自动 verifier 若在 Gateway 重启时仍存活，Gateway 杀掉该 verifier 自己的 process group，再以 `interrupted_by_gateway_restart` 收尾；
- 下一次 merge 调用可为同一 SHA 自动重新排队一次；
- 同一 SHA 连续两次 verifier infrastructure failure 后停止自动重试，返回 artifact excerpt 和唯一恢复动作；
- 已经存在 matching receipt 时不重复执行 verifier。

状态型外部写操作遵循“先观察、再决定是否重试”：

- push 超时后先读 remote ref；
- PR open 超时后先查同 head/base PR；
- merge 超时后先查 PR merged/head SHA；
- deploy/verify 超时后先查项目声明的 deployment receipt/health。

本设计不要求统一 operation 表；现有 `auditId` 与 `jobId` 已足够关联一次执行。

### 5.4 有界等待与重试

- GitHub GET、CI 查询、readiness probe：最多 3 次指数退避，总时间不超过调用方 deadline；
- 本地 Git、policy denied、dirty/diverged、branch mismatch、invalid input：不重试；
- push/PR/merge/deploy：不盲重试，必须先观察远端状态；
- 测试失败：默认不当作 flaky 重跑；只有可信 control profile 显式允许时重跑一次；
- 所有 running/waiting 状态包含 deadline、最后错误和 next action，不允许永久 running。

### 5.5 Canonical refresh 与 cleanup

每次成功 merge 后，在同一 repo lock 内：

1. 验证 canonical 在预期 base branch、clean、非 busy；
2. 固定 `origin` 与同名 base ref fetch；
3. 只允许 fast-forward；local ahead/diverged/dirty 一律 fail closed；
4. 验证 canonical HEAD 达到 remote base SHA；
5. 标记 task merged/completed；
6. 安全移除 task worktree 与 task branch；
7. cleanup 失败保留可对账状态，由 GC 明确发现，不把 merge 误报为未发生。

新的 task open 继续在创建 worktree 前执行 safe canonical refresh，因此连续任务不会从 merge 前的 stale local main 派生。

### 5.6 连续任务而非 Gateway 工作流

Gateway 不新增持久 FIFO/DAG。连续任务由 agent 在同一会话中按用户给定顺序推进，Gateway 通过现有 task/status 数据提供：

- 当前阶段；
- blocker；
- next action；
- 当前 HEAD 与验证状态；
- completed-but-not-cleaned-up 状态。

等待 CI 或 verifier 时，agent 可以开始另一个独立 task 的 inspect/edit；同 repo 的写操作仍由 repo lock 串行。一个任务进入明确 blocker 后，agent 可以继续处理下一个任务，并在最终汇总中一次性报告需要用户处理的项目。

### 5.7 Production activation 的最小闭环

GrandeGPT 自身 merge 不等于 production activated。已有 LaunchAgent 模型保留，release 完成必须满足：

```text
target main SHA
  → gateway restart/kickstart
  → endpoint readiness
  → gatewayBuild == target build
  → toolset identity probe
  → read probe
  → release receipt
```

不引入蓝绿部署。restart 使用有限重试；失败时不得声称 activation 完成，保留旧状态、最后错误与一条恢复命令。tool contract 未变化时不要求 Refresh Production App；contract 变化继续遵守现有 epoch/digest runbook。

## 6. Outer-test 分层与缩减

### 6.1 当前问题

当前以整文件为单位排除，导致一个文件中大量不依赖宿主能力的测试也进入 outer-test。人工流程还会打断 agent：merge gate 返回一条宿主命令，必须等待用户执行后才能继续。

### 6.2 按能力拆分

测试重组为两层：

#### 普通 `unit-selfhost`

以下测试迁回普通层：

- 使用 `app.request()`、fake listener 或注入 transport 的 server 行为；
- tool schema、annotation、envelope、audit、contract；
- runner 参数、状态转换、错误分类与 fake process adapter；
- task/worktree/DB/checkpoint 纯逻辑；
- fake GitHub API、fake remote 与不依赖真实 host 的 PR lifecycle；
- 不需要真实 Seatbelt、真实进程组、真实 hook 或真实 bind 的 e2e。

#### Host verifier suite

只保留无法由普通层证明的承重行为：

- Seatbelt 对 control root、canonical `.git`、工作区外写入和 secrets 的真实拒绝；
- sandbox 内允许的 toolchain/临时目录/任务文件行为；
- 真实 process group、wall timeout、RSS fallback 和整棵进程树 kill；
- loopback bind 可用、LAN bind 不可用；
- Git hook 在 verifier 环境中确实可执行，从而证明 `core.hooksPath=/dev/null` 是承重参数；
- 一条真实 sandboxed job smoke；
- 一条从 tool handler 到 job result 的自举 smoke。

Host 测试移动到明确目录，例如 `tests/host/*.host.test.ts`。每个文件必须在可信 manifest 中登记 capability reason；未登记 host 文件和 manifest 指向不存在文件都 fail closed。`unit-selfhost` 排除集合与 host manifest 的并集/交集由契约测试钉住，确保没有测试静默落在两层之外。

### 6.3 验证级别

可信运行 Gateway 根据 `task.baseCommit..HEAD` 的 changed files 选择：

| Level | 触发条件 | 行为 |
|---|---|---|
| `none` | 仅文档、非执行注释和明确无运行影响的资产 | 不创建 host job |
| `smoke` | 普通 production source、普通测试或工具文案/schema 改动 | 运行 host smoke |
| `full` | sandbox、runner、Git、auth、server bind、Gateway lifecycle、host verifier、receipt/merge gate、可信 profile/policy 改动；或无法分类 | 运行全部 host suite |

分类规则和 suite manifest 位于运行中的可信 Gateway 代码或 control plane，候选仓库不能通过修改自身文件降低 level。修改 host 测试、manifest、classifier 或 verifier profile 本身固定触发 `full`。未知生产路径默认 `full`，不猜测为安全。

第一版只使用短路径集合和精确单元测试，不建设 import dependency graph。后续若维护成本证明必要，再评估静态依赖分析。

### 6.4 同一 Gateway 的专用 Verifier

Gateway 新增内部 verifier orchestrator，但不新增 MCP host-exec 工具。它只能由 GrandeGPT 自举 merge gate 调用，输入只包含：

```ts
{
  taskId: string;
  repoId: "grande-gpt";
  commit: string;
  level: "smoke" | "full";
}
```

调用方不能传 argv、测试路径、cwd、环境变量、Seatbelt 规则或 receipt 字段。

执行过程：

1. 验证 task repo、branch、clean HEAD、PR head 与输入 SHA 一致；
2. 在 verifier temp root 创建该 SHA 的一次性 detached worktree；
3. source 与依赖目录只读，所有缓存/HOME/TMP 写入 job temp；
4. 通过固定 Node/Vitest entrypoint运行 trusted manifest 选出的文件；
5. 使用独立 process group、既有 wall timeout/RSS/output limit；
6. 结束后由 Gateway 父进程读取 job 终态，重新核对 task/PR SHA；
7. pass 才签发 receipt；失败、超时、killed、SHA drift 均不签发；
8. 清理 verifier worktree 与 temp；清理失败进入可对账 GC，不影响真实 task worktree。

Gateway 主进程不 import candidate module，且 verifier 子进程不能连接或修改 Gateway state DB。

### 6.5 Verifier Seatbelt 权限

Verifier 使用单独的 default-deny profile，不复用普通 run profile，也不直接在宿主权限执行。

允许：

- 只读 verifier worktree、所需 node_modules、Node/Vitest/Git/sandbox-exec 及测试明确要求的系统二进制；
- 写 verifier job temp；
- 在 verifier job temp 内创建 Git fixture、hook marker、socket 与 artifacts；
- loopback bind/connect 到系统分配的临时端口；
- 为 sandbox 承重测试执行嵌套 `sandbox-exec`；
- 为 hook 承重测试在 verifier 边界内执行 `/bin/sh` marker hook。

拒绝：

- 读取或写入真实 control root、secrets、SSH、Git credential store、shell profile、其他项目和生产日志；
- 写 canonical、真实 task worktree、其他 verifier job 或 `.git` 元数据；
- 非 loopback 网络和 production Gateway 端口；
- 向 Gateway/其他进程发送 signal；
- Keychain、`security` CLI、任意 package install 和未登记 executable；
- 继承宿主 token、API key、proxy、DYLD、Git/SSH agent 环境。

环境只包含从可信 exec roots 派生的 `PATH`、临时 `HOME`、`TMPDIR` 和固定 locale。测试需要的 Grande 路径全部指向 verifier fixture，不指向真实 control plane。

### 6.6 端口、进程与资源隔离

- verifier 不得使用生产固定端口；测试 listener 使用端口 0 或 verifier 分配的范围；
- production Gateway 端口在 verifier profile 中显式不可连接；
- verifier job 为 detached process group，timeout/RSS 终止整个 group；
- 同一 Gateway 同时最多一个 host verifier，避免端口、CPU、内存与嵌套 sandbox 争用；
- verifier 输出使用现有 artifact 截断策略，tool envelope 只返回 bounded excerpt；
- verifier 异步运行，Gateway event loop 与 MCP endpoint 在测试期间保持可响应。

### 6.7 Receipt V2

复用 `outer_test_receipt` JSON 列，无需数据库 migration。Receipt 扩展为：

```ts
interface OuterTestReceiptV2 {
  version: 2;
  mode: "auto" | "manual";
  taskId: string;
  repoId: "grande-gpt";
  commit: string;
  level: "smoke" | "full";
  profile: string;
  files: string[];
  planDigest: `sha256:${string}`;
  jobId: string;
  startedAt: number;
  endedAt: number;
  hostToolchain: Record<string, string>;
}
```

`planDigest` 覆盖排序后的测试文件、level、verifier policy version 和关键资源限制。Receipt 只能由 Gateway 父进程根据已终结 job 签发。自动模式 merge gate 要求 V2、matching SHA、matching planDigest 和当前所需 level；`full` 可以满足 `smoke`，反向不允许。

旧 receipt 在过渡 release 中按 `mode=manual` 读取，并继续要求 exact SHA；auto 模式稳定后，新签发一律使用 V2。新 commit、manifest/policy version 变化或当前任务从 smoke 升级为 full 都会使旧 receipt 失效。

### 6.8 Merge 工具行为

`grande_pr_merge` 的输入 schema 不变化，不新增用户参数。

调度 verifier 时仍使用审计工具名 `grande_pr_merge`，在 input 中记录 `phase: "host_verification"`、task/PR/SHA/level。该 audit 在 matching job 成功创建后结束；测试执行结果由 job 与 receipt 表达。之后真正 merge 是下一次工具调用和新的 merge audit，二者不混成一个长期 EXECUTING audit。

当其他 merge gate 已满足但 receipt 缺失时：

- 若 matching verifier job 正在运行，返回 `ok: true`、`merged: false`、`verification.state: "running"` 与 `jobId`；
- 若不存在 job，创建一个并返回同样的 verifying 状态；
- 若最近 job 为代码测试失败，返回可操作失败摘要，agent 修复后产生新 SHA 并重新走门禁；
- 若为一次 infrastructure failure，下一次调用自动重排一次；连续两次 infrastructure failure 后请求 Human；
- verifier pass 后不在后台自动 merge，agent 再次调用同一个 `grande_pr_merge`，重新读取 PR/CI/SHA 后执行 merge。

这样不增加用户操作，同时保留每次 destructive merge 的显式工具调用、最新状态检查与审计边界。

输入 schema 与 annotations 均不变化，新增的 verification data 是响应中的兼容性扩展，因此本 slice 不 bump toolset epoch；若实现阶段改变输入 schema 或 annotations，则必须按现有 connector release runbook bump epoch。

### 6.9 Manual fallback

保留 `grande outer-test --task <id> --run`，但改为调用同一 verifier orchestrator，而不是在当前宿主进程直接 `spawnSync npx vitest`。CLI 可以等待并输出完整人类可读进度；MCP 仍使用异步 job。

在自动 verifier feature flag 关闭或 verifier infrastructure 连续失败时，CLI 是唯一 fallback。不得退回通用 unsandboxed candidate execution。

## 7. 用户交互边界

### 7.1 正常开发任务零额外确认

仓库已注册且策略已批准时，下列动作不逐步询问：task/worktree、edit、已批准 test profile、commit、task branch push、PR、CI wait、自动 host verification、merge、canonical refresh 与 cleanup。

是否允许自动执行 merge 仍来自用户最初任务授权或既有 owner policy；host verifier 自动运行本身不需要额外确认，因为它只在受限 profile 中执行固定测试计划。

### 7.2 必须请求用户的情况

- 新增 repo、profile executable、verifier exec root 或扩大 Seatbelt 权限；
- canonical dirty/local-ahead/diverged；
- merge conflict 无法按确定规则解决；
- 凭据缺失、失效或权限不足；
- production 首次启用、部署配置改变或 rollback；
- 两次连续 verifier infrastructure failure；
- 外部状态无法确认，重试可能产生重复 push/PR/merge/deploy；
- acceptance criteria 本身含糊，需要产品决策。

agent 应累计独立 blocker，优先继续其他任务，最后一次性向用户报告，不在每个阶段打断。

## 8. 配置与发布开关

自动 verifier 的模式只存在于可信 control plane：

```yaml
hostVerification:
  grande-gpt:
    mode: "manual"
    concurrency: 1
```

`mode` 的允许值为 `manual` 或 `auto`。

- 第一版默认 `manual`；
- 专用 Seatbelt feasibility gate、回归测试与宿主 soak 全部通过后切换为 `auto`；
- candidate repo 中的 `.grande/*`、package scripts 或测试代码不能修改此模式；
- 回滚只需把模式改回 `manual`，receipt/DB schema 无破坏性变化。

正常项目默认不启用 host verifier。未来项目只有在 Human Owner 注册固定 verifier policy 后才能使用，不从 repo 自声明提升到宿主验证能力。

## 9. 错误处理与恢复语义

| 场景 | 行为 |
|---|---|
| unit/selfhost 测试失败 | agent 修复，不创建 host job |
| host verifier 测试失败 | 保存 bounded artifact，不签 receipt；新 commit 后重跑 |
| verifier timeout/RSS | 杀整个进程组，记 timeout/killed；按 infrastructure policy 有界重排 |
| Gateway 在 verifier 期间重启 | 杀残留 verifier group、CAS 收尾；同 SHA 下一次 merge 可重排一次 |
| task/PR SHA 在运行期间变化 | job 结果保留但拒绝签 receipt；新 SHA 重新验证 |
| verifier cleanup 失败 | receipt 仍可有效；残留进入 GC reconciliation，不删除真实 task worktree |
| CI 在 verifier 期间变 failed | receipt 可记录，但 merge 重新检查 CI 并拒绝 |
| canonical refresh 失败 | remote merge 状态如实返回；task 标成 merged-but-local-stale，后续 task open fail closed |
| auto verifier 连续两次基础设施失败 | 停止自动重试，给 Human 唯一 CLI/诊断动作 |

代码测试失败与 verifier infrastructure failure 必须使用不同错误分类，避免把真实红测自动重跑，也避免让 agent修改代码来“修复”宿主配置故障。

## 10. 可观测性

复用现有 job/audit/artifact，新增安全元数据：

- verification level、planDigest、policy version；
- task/PR/tested SHA；
- jobId、auditId、startedAt/endedAt；
- result category：test_failed / timeout / resource_exhausted / infrastructure / sha_drift；
- retry count 与 next action；
- gateway build 与 host toolchain。

日志不记录测试源文件内容、完整环境、token、控制平面路径或任意 tool 参数值。状态工具显示一行 concise 进度；详细输出通过已有 bounded artifact/result 路径读取。

## 11. 实施切片

### Slice A：Git 与串行基础

- 引入单一 Safe Git 模块并迁移 production Git 调用；
- 增加 repo 级进程内 write lock；
- 为 branch/SHA、hooks、credentials、diff helper 和并发写加入行为回归测试；
- 不改变外部工具 schema。

### Slice B：Host suite 拆分与 verifier feasibility

- 把普通断言迁回 `unit-selfhost`；
- 建立 smoke/full manifest 与 capability reasons；
- 实现专用 verifier Seatbelt throwaway probe；
- 必须在宿主证明 nested sandbox、hook marker、loopback bind、runner process-group 四类承重测试都能给出真实结果，而非因外层 sandbox 产生假阴性；
- 任一承重 probe 无法成立时停止 auto rollout，继续 manual mode，不降低 profile。

### Slice C：异步 verifier 与 receipt V2

- 复用 job runner、artifact 与 CAS 收尾；
- 创建 disposable exact-SHA verifier worktree；
- 接入 receipt V2、planDigest、SHA drift 与 resource limits；
- CLI 改走同一 orchestrator；
- `grande_pr_merge` 可自动调度并返回 verifying 状态。

### Slice D：恢复、连续任务与 activation closeout

- 启动对账 verifier job；
- 实现有界 infrastructure retry；
- merge 后 canonical refresh/cleanup 对账；
- status 输出 blocker/next action；
- 完成连续任务、Gateway restart 与 production activation 宿主验收；
- 通过后把可信 control plane mode 从 manual 切换为 auto。

每个 slice 单独 TDD、独立 review、宿主 verification 和可回滚交付；不得一次性重写 runner、audit 或 task 状态系统。

## 12. 预期代码边界

实现计划必须沿用以下文件边界，若实际探索证明边界不成立，再回到 spec 审批，不在实现中临时扩张：

| 路径 | 责任 |
|---|---|
| `src/gitExec.ts`（新增） | Safe Git argv、模式前缀、timeout、错误与脱敏；不含 task/PR 业务规则 |
| `src/repoWriteLock.ts`（新增） | 单机 repo write mutex；无数据库状态 |
| `src/hostVerification.ts`（新增） | trusted suite manifest、changed-file level classifier、job 去重、receipt eligibility |
| `src/hostVerifierSandbox.ts`（新增） | verifier 专用路径与 Seatbelt profile，不复用 candidate profile argv |
| `src/outerTest.ts` | 从旧整文件反推迁移为人工可读 plan/兼容 CLI 展示 |
| `src/outerTestReceipt.ts` | Receipt V2 解析、planDigest/level/SHA 校验与父进程签发 |
| `src/prLifecycle.ts` | 缺 receipt 时调度/观察 verifier；通过后重新检查并 merge |
| `src/runner.ts`, `src/jobs.ts` | 复用异步 job、process group、资源限制、CAS 收尾和启动对账 |
| `src/sandbox.ts`, `src/sbpl.ts` | 保持普通 runner profile；新增 verifier profile primitive 与承重测试 |
| `src/cli.ts` | manual fallback 调用同一 verifier orchestrator，不再直接宿主 `spawnSync` candidate test |
| `src/worktree.ts`, `src/worktreeGc.ts` | disposable verifier worktree 创建、只读执行边界与残留对账 |
| `src/tools.ts`, `src/server.ts` | 组装 repo lock 与 verifier dependencies；保持 MCP endpoint 可响应 |
| `tests/host/*.host.test.ts`（新增目录） | 仅存真实 Seatbelt/process/bind/hook/e2e 承重测试 |

现有直接 Git 调用按 slice 逐步迁移；迁移完成的模块不允许回退到私有 Git helper。`gitExec.ts` 自身不读取数据库、control config 或 tool arguments，避免把它扩张成新的业务中心。

## 13. 验收标准

### 13.1 安全边界

1. verifier 中候选代码读取真实 control root、GitHub token、SSH、credential store 和其他 repo 均被 Seatbelt 拒绝。
2. verifier 不能写 canonical、真实 task worktree、Gateway state DB 或其他 job temp。
3. verifier 不能访问外网或 production Gateway 端口；临时 loopback listener 正常。
4. verifier 只能由内部 selfhost merge gate/CLI 触发，MCP 不存在任意 argv/host-exec 接口。
5. 子进程不能自签 receipt；伪造 stdout、artifact 或环境变量不能产生 receipt。
6. 删除 Git hooks override、放开 control root deny 或放开 credentials 的 mutation/probe 必须使承重测试变红。

### 13.2 测试分层

1. `unit-selfhost` 与 host manifest 的测试集合并集覆盖全部项目测试，交集只允许显式 smoke duplication。
2. 每个 host 测试都有 capability reason，并有证据说明普通 selfhost 无法真实验证该行为。
3. 原整文件排除中的非宿主断言已迁回普通层；host suite 不因文件组织重复运行大量纯逻辑测试。
4. docs-only 为 none，普通 source 为 smoke，关键/未知/verifier policy 变更为 full；classifier 有精确行为测试。

### 13.3 Exact-SHA 与 merge

1. clean task HEAD、PR head、verifier SHA 和 receipt SHA 必须完全一致。
2. verifier 运行中产生新 commit 时不签 receipt。
3. manifest/policy version 或所需 level 升级使旧 receipt 失效。
4. matching full receipt 可以满足 smoke；smoke 不可满足 full。
5. verifier pass 后 merge 仍重新读取 CI、mergeability、branch 和 expected SHA。

### 13.4 运行可靠性

1. verifier 运行期间 Gateway MCP/status 保持可响应。
2. timeout/RSS 会终止整个 verifier process group，不留下永久 running job。
3. Gateway 在 verifier 中途重启后，残留进程与 job 能收敛；下一次 merge 最多自动重排一次。
4. 同一 SHA 不产生并行或重复 verifier；同 repo 不并发执行 Git 写操作。
5. push/PR/merge 的响应丢失不会产生重复 PR、错误 ref 或盲目重复 merge。
6. merge 后下一 task 从已刷新的 canonical SHA 创建；cleanup 失败可由 GC 明确发现。

### 13.5 用户效率与连续任务

1. 已批准策略下，普通自举 bugfix 从任务到 merge 不要求用户手工执行 outer-test。
2. 连续 20 个代表性中小任务 dogfood 中，零错误分支、零重复 PR/merge、零永久 running，且只有预定义 Human Gate 才打断用户。
3. 一个任务等待 CI/verifier 时，agent 可推进其他独立任务的 inspect/edit；repo 写操作仍串行。
4. 所有 blocker 返回唯一 next action，agent 可以累计后一次性报告用户。

### 13.6 Production closeout

1. 自动 verifier 在 manual 模式完成完整宿主 probe 与 mutation evidence 后才允许切 auto。
2. auto 模式至少连续完成 20 次 selfhost verification，无 secrets 泄漏、Gateway outage 或人工 receipt 操作。
3. production activation receipt 证明运行 build 等于目标 build，read probe 成功；merge 不被误报为 activated。

## 14. Rollback

- 把可信 control config 的 `hostVerification.grande-gpt.mode` 改回 `manual`，立即停止 MCP 自动调度；
- 保留 CLI，同一 exact-SHA merge gate 继续生效；
- receipt V2 使用现有 JSON 列，无数据库 downgrade；未知/损坏 receipt 继续 fail closed；
- Safe Git、repo mutex、测试拆分和错误脱敏属于独立安全改进，不随 verifier auto rollback 撤销；
- 已运行的 verifier job 在 rollback 时终止自己的 process group并按 killed 收尾；不触碰真实 task worktree；
- rollback 不绕过 outer-test gate、不接受旧 SHA receipt，也不启用 unsandboxed fallback。

## 15. 最终边界

该设计的可靠性核心保持为：

```text
Safe Git
+ repo 串行写
+ 启动对账
+ 自动 canonical refresh/cleanup
+ agent 连续任务循环
+ 同 Gateway 的受限异步 host verifier
+ 少量明确 Human Gate
```

它提升的是 GrandeGPT 作为中小项目受控开发执行层的连续性，而不是把 Gateway 扩张成通用 CI、调度或企业工程平台。
