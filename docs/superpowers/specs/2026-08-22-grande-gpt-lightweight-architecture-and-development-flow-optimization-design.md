# GrandeGPT 轻量架构、运行可靠性与开发流程优化规格

**日期**：2026-08-22

**状态**：Draft for owner review

**文档类型**：架构收敛与开发流程优化规格

**目标产品**：面向个人开发者、小团队、轻量与中小型代码项目，以及有限、受控的日常运维工作

## 1. 文档目的

本规格整合 2026-08-22 对 GrandeGPT 当前整体结构、Git/工具调用、host verifier、运行可靠性和开发流程的评审结论，给出一套避免过度设计的收敛方案。

本规格不要求重写 GrandeGPT，也不扩大产品边界。目标是在保留现有安全强度的前提下：

1. 降低 Gateway 长期运行和升级失败的概率；
2. 减少用户在连续开发任务中的确认、等待、复制命令和手工判断；
3. 减少公开工具、内部编排和状态源之间的耦合；
4. 让轻量修改走轻量流程，高风险修改继续走完整门禁；
5. 使 GrandeGPT 自举开发方式可以长期复用，而不会随着每次修复持续增加永久结构。

本规格是后续实现计划的输入，不代表其中任何优化已经完成或已进入 production。

## 2. 评审基线与证据边界

架构评审以实际开发 worktree 的已提交候选 `2ac1eec3ab2ca607d6705d2a135566e7aec8dfe3` 为主要代码基线，并观察到 Slice D restart recovery 正在继续开发。评审时未把未提交文件视为已完成能力。

当前实现仍处于 `hostVerification.mode=manual` 过渡期。任何 auto verifier、自动 merge、自动 cleanup 或 production activation 结论，都必须以之后的 exact-SHA host evidence 和 production probe 为准。

历史测试数量、tool count、Gateway build 和 Pact 状态会变化。实施与验收时必须重新读取当前 Git HEAD、工具契约、Gateway runtime identity、状态库和真实 host 结果，不得把本规格中的历史快照当成实时证据。

## 3. 产品定位与支持边界

### 3.1 目标定位

GrandeGPT 是一个在 ChatGPT 普通对话中使用的本机受控执行层：

- ChatGPT 负责理解需求、调研仓库、生成修改和组织执行步骤；
- Gateway 负责授权、策略、审计和执行；
- Task 和 Git worktree 隔离每个开发任务；
- 固定 profile 和 macOS Seatbelt 限制候选代码；
- Git/GitHub、项目现有部署机制和 exact-SHA receipt 完成闭环。

### 3.2 当前应明确承诺的范围

- 单用户或小团队；
- 单台 macOS 主机上的一个常驻 Gateway；
- 一个 Task 只操作一个已注册仓库；
- 可以注册多个仓库，但不提供跨仓库工作流；
- 以仓库根级可信 profile 为主要执行入口；
- 普通源码、测试、文档、GitHub PR/CI 和项目已有部署机制；
- 有限并发，不追求大规模任务吞吐；
- 允许 agent 在一次任务授权范围内连续执行已批准动作。

### 3.3 明确不承诺的范围

- 企业级 RBAC、SSO、审批流和 release train；
- Jira/Linear 替代品；
- 多 agent 组织平台；
- 多 repo orchestration；
- Kubernetes/DevOps orchestration；
- 通用 observability、incident management 或远程运维平台；
- 通用插件市场、capability graph 或自动模型路由；
- 任意 shell、任意 argv/cwd/env、通用 host exec；
- 分布式队列、DAG、远程 runner、分布式锁；
- 未经单独验证的复杂 pnpm workspace/monorepo 执行布局。

如果未来需要扩大这些边界，必须作为独立产品决策处理，不能借一次 bug 修复顺带加入。

## 4. 必须保留的核心架构

以下部分与轻量定位一致，并且承担真实安全或可靠性职责，不应因“简化”而删除：

1. **单 Gateway**：保持唯一执行权威，不拆微服务或独立 verifier 服务。
2. **SQLite 控制状态**：继续存储 Task、job、audit、attestation 和 receipt，不引入外部数据库依赖。
3. **Task + worktree**：写操作绑定 taskId，候选修改只进入该 Task worktree。
4. **固定 profile**：仓库只能选择控制平面批准的 profile，不能提供任意命令。
5. **Seatbelt 沙箱**：候选代码默认无网、最小文件范围、固定 executable roots。
6. **Safe Git**：固定 Git executable、argv 数组、危险配置覆盖和高层语义工具。
7. **Exact-SHA 门禁**：本地 attestation、PR head、CI、host receipt、merge expected SHA 和 deployment receipt 必须绑定同一 commit。
8. **Human Gate**：权限扩大、production 首次启用、rollback、凭据问题、冲突、canonical dirty/diverged 和无法判断的外部状态必须停下。
9. **小型 Task 状态机**：保持 `CREATING / READY / RUNNING / CLOSED`，不把 PR、CI、deploy、verify 扩成大型持久工作流状态机。

## 5. 当前主要问题与优化方法

### 5.1 状态库没有可恢复的升级路径

#### 问题

`src/db.ts` 当前在 schema version 不匹配时拒绝启动，并建议人工备份后删除数据库。该设计在原型期可接受，但当前数据库已经包含不可完全从 Git 重建的 audit、OAuth、attestation、job 和 receipt。

此外，部分附属表通过 `CREATE TABLE IF NOT EXISTS` 加入但不提升 schema version，导致版本号不能完整描述磁盘结构。

#### 优化方法

实现最小顺序迁移，不引入 ORM 或迁移框架：

1. 打开旧库后先执行一致性检查；
2. 迁移前创建带时间戳的 SQLite backup；
3. 在单一事务内执行 `N -> N+1` SQL；
4. 成功后更新 `PRAGMA user_version`；
5. 失败时回滚事务、保留原库和 backup、拒绝 Gateway 启动；
6. 每个支持版本都有正向迁移测试和失败回滚测试；
7. 不支持自动 downgrade，rollback 使用旧 binary + 迁移前 backup。

#### 验收标准

- 至少从当前前一 schema version 升级到当前版本，不丢失 Task、audit、OAuth、attestation 和 receipt；
- 注入迁移中途失败后原库仍可由旧版本打开；
- backup 创建失败时不修改原库；
- 新建库与迁移后库的 schema digest 一致。

### 5.2 缺少自动、可恢复的控制平面备份

#### 问题

状态库、控制配置、secrets 元数据和运行证据缺少统一、可验证的备份与恢复路径。运维工具本身不能把“删除数据库重建”作为正常升级方案。

#### 优化方法

- 数据库迁移前强制 SQLite backup；
- 提供只读 `grande backup status` 或等价 doctor 检查，显示最近 backup 时间和可读性；
- backup 默认只覆盖控制状态和配置，不复制明文 token 到普通日志或工作区；
- 保留有限数量的本机备份，删除策略仅作用于固定 backup 根；
- 恢复必须是显式 Human 操作，不自动覆盖当前状态库。

### 5.3 Repo 写锁只在一个进程内有效

#### 问题

当前 repo mutex 只协调同一个 Gateway 进程。Gateway、`grande gc --apply`、outer-test 和其他 CLI 是不同进程，同时修改 worktree、branch 或 canonical 时不会互斥。

#### 优化方法

增加一个轻量跨进程 repo advisory lock：

- Gateway 和会写 Git/worktree 的 CLI 共用；
- 每个 repoId 一个固定锁目标；
- 记录 PID、操作类型和开始时间；
- 获取锁失败时快速返回结构化 busy 状态，不无限等待；
- 仅在确认记录 PID 已不存在后回收 stale lock；
- 进程内 Promise mutex 继续保留，用于同进程公平排队；
- 不增加持久队列、分布式锁或后台调度器。

#### 验收标准

- 两个独立 Node 进程不能同时进入同一 repo 写临界区；
- 不同 repo 可并行；
- 进程被强杀后锁可以安全恢复；
- 只读工具不受锁影响；
- 超时或 busy 不产生部分 Git/worktree 副作用。

### 5.4 Host verifier cleanup 与 receipt 顺序错误

#### 问题

设计要求 verifier 测试已经通过且 exact SHA 仍有效时，cleanup 失败不应使 receipt 失效；残留应进入 GC 对账。当前运行时先 cleanup，再完成 job 和签发 receipt，导致临时目录删除失败会浪费一次有效验证并要求人工重跑。

#### 优化方法

调整为：

1. verifier 进程组进入终态；
2. 写入 bounded artifact；
3. 父进程重新读取 task HEAD 和 PR head；
4. exact SHA、plan digest、policy version 和 level 都匹配时完成 job 并签发 receipt；
5. 随后清理 disposable worktree/temp；
6. cleanup 失败只记录 `cleanupRequired/cleanupError`，由 GC 对账；
7. 任何 cleanup 路径仍必须通过 disposable-root guard，绝不扩大删除目标。

#### 验收标准

- 测试通过、SHA 未变化、cleanup 失败时 receipt 仍有效；
- cleanup 失败可由 status/GC 发现；
- 测试失败、timeout、RSS kill、SHA drift 和 plan/policy drift 永不签 receipt；
- cleanup 永远不能删除 canonical、真实 Task worktree 或 controlRoot。

### 5.5 Gateway restart 后 verifier/job 无法完整收敛

#### 问题

detached verifier 在旧 Gateway 退出后可能继续存活，但新 Gateway 没有旧父进程的输出收集与 receipt 签发上下文。只检查进程组是否存活并跳过，会留下永久 running 或无主进程。

#### 优化方法

- 在暴露写工具和开始监听前执行 startup reconciliation；
- 只处理 profile 明确为 `host-verifier` 的非终态 job；
- 活着的已记录进程组先终止，不能终止则 Gateway fail closed；
- guarded cleanup disposable root；
- 用 CAS 把 job 收敛为 `killed / interrupted_by_gateway_restart`；
- ordinary runner job 保持现有策略，不借此扩大恢复范围；
- auto mode 必须在该行为通过 real-host restart probe 后才能启用。

### 5.6 普通 runner 与 host verifier 重复实现进程监管

#### 问题

两条路径分别实现 detached spawn、进程组 kill、RSS 轮询、wall timeout、输出截断和 stdout/stderr 收集。两份代码会产生行为漂移和双倍修复成本。

#### 优化方法

抽取一个窄的 `ProcessSupervisor` primitive，只负责：

- 固定 executable + argv 启动；
- detached process group；
- bounded stdout/stderr；
- wall timeout；
- sampled process-group RSS；
- SIGTERM 后有限等待，再 SIGKILL；
- 返回统一终态和资源摘要。

普通 sandbox policy、host verifier trusted plan、依赖复制、receipt 和 Task/job 语义继续分别实现。该 primitive 不接受来自模型或候选仓库的任意 executable、argv、cwd、env 或 policy。

### 5.7 Host verifier 资源上限与轻量定位不匹配

#### 问题

当前 verifier 已限制单 worker，但 RSS 上限较宽。上限不代表实际消耗，却允许单次验证对小内存 Mac 形成明显压力。

#### 优化方法

- 保持 `maxWorkers=1` 和全局单 verifier；
- 连续记录至少 20 次 smoke/full 的 wall time、peak process-group RSS、输出量和临时存储量；
- 用真实 P99 加明确余量设置上限；
- 在没有新证据前，不提高并发；
- 初始目标区间为 512–768 MB，但最终值由真实 host evidence 决定；
- 资源超限返回结构化原因，不能被误报成测试失败。

### 5.8 Loopback 临时端口存在分配竞态

#### 问题

可信父进程先绑定随机 loopback port，关闭 listener，再让 verifier 使用该端口。在关闭和实际绑定之间，其他本机进程可能抢占端口，造成非安全性的偶发失败。

#### 优化方法

优先使用有限重试而不是复杂 FD 传递：

- 只对明确的 `EADDRINUSE` 重新分配可信端口；
- 每次重试重新生成 trusted plan/digest 中的 runtime port 部分；
- 最多有限次数；
- 不回退到 broad `localhost:*`；
- 仍显式拒绝 production Gateway port 和非 loopback 地址。

只有有限重试仍无法满足可靠性时，才评估 listener FD 继承。

### 5.9 Capability 层超出当前真实需求

#### 问题

当前 capability 同时抽象 native、MCP、plugin 和 skill，并提供 list/inspect/invoke、风险组合和动态连接。deployment 又通过公开 tool handler 调用 capability、run 和 PR status。工具组装依靠共享可变数组解决 deploy/capability 接线顺序。

这形成了运行时编排环，增加审计、锁、参数包装、错误传播和 tool contract 的理解成本。仓库内没有足够真实 provider 实例证明全部抽象都已产生长期价值。

#### 优化方法

1. 立即冻结 provider 类型，不继续扩 capability graph、依赖或 marketplace；
2. deployment 改为调用共享领域函数，不按名称调用公开 tool handler；
3. native capability invoke 标记为待评估兼容层，下一次正式 tool epoch 根据真实使用证据决定保留或移除；
4. 外部集成优先使用显式、固定、项目需要的 adapter；
5. 只有至少两个真实、长期使用且语义相同的集成，才允许抽出新的通用 provider abstraction；
6. 不根据本机配置动态增减 MCP tool list，避免 ChatGPT tool snapshot 漂移。

### 5.10 工具组装依赖可变 handler 和隐式包装顺序

#### 问题

工具当前按 core、local loop、PR、brief、onboarding、deployment、capability 的顺序逐层追加，并在后续阶段原地替换 `ToolDef.handler`。repo lock、arg check、tool identity 和部分业务增强依赖“哪一层最先/最后包装”以及多个数组是否引用同一个 ToolDef 对象。

这种方式不会直接形成 TypeScript import cycle，但会让以下行为难以审计：

- 参数拒绝发生在锁前还是锁后；
- 内部调用是否经过 repo lock；
- 一次外部动作产生几层 audit；
- toolset digest 是否覆盖了真实执行语义；
- 修改一个 handler 后，native capability 快照是否同步变化。

#### 优化方法

建立一个静态 ToolSpec registry 和固定、很小的 middleware pipeline：

1. ToolSpec 只声明 name、schema、annotations、风险、task/repo scope 和领域 handler；
2. 注册时按固定顺序应用 `arg validation -> task binding -> repo lock -> audit -> domain handler -> envelope/redaction`；
3. middleware 不原地修改已被其他模块持有的 ToolDef；
4. deployment、capability 和其他组合能力调用领域服务，不调用完成包装后的公开 tool；
5. toolset digest 继续只覆盖公开 contract，runtime pipeline 用独立单测证明顺序；
6. 不建设通用拦截器框架，只保留当前实际需要的四到六个固定 middleware。

#### 验收标准

- 每个写工具能从 registry 直接看出 repo scope、风险和 audit 策略；
- 参数错误不获取 repo lock、不写 audit executing；
- 同一外部副作用不会因内部工具互调产生互相矛盾的双层终态；
- wrapper 顺序有一组集中测试，不依赖对象共享引用。

### 5.11 公开工具数量和绑定成本过高

#### 问题

25-tool contract 增加模型选错工具、schema binding、tools snapshot 和响应预算压力。历史上已经出现 tool disabled、binding context 和结果预算问题。

#### 优化方法

- 当前 epoch 不继续新增公开工具；
- 优先增强现有 `grande_task_status.nextAction`、bounded wait 和结构化错误；
- agent 根据 nextAction 自动调用现有工具，不新增 workflow engine；
- 下一次正式 epoch 审查低使用率或重复工具，重点评估通用 capability 三件套；
- 不把多个高风险动作合成一个不可观察的万能 `continue/finish` 工具；
- 工具合并必须保留每个 destructive 外部副作用的独立 audit 和 exact-SHA gate。

### 5.12 Job summary 与 receipt 依赖松散 JSON

#### 问题

多类 job summary、deployment receipt 和 outer-test receipt 使用 `Record<string, unknown>` 或直接 JSON parse。不同模块重复判断 kind、limits、ports、level 和 digest，容易出现解析与 eligibility 规则漂移。

#### 优化方法

- 保持现有 JSON 列，不增加工作流表；
- 为每类 summary/receipt 定义小型 discriminated union；
- 单一 codec 负责 parse、版本、字段校验和 fail-closed；
- 单一 eligibility 模块负责 exact SHA、level、plan/policy digest；
- 未知版本或损坏 JSON 返回明确无效状态，不抛出未处理异常；
- 不把所有状态统一成一个巨型事件模型。

### 5.13 缺少独立 CI

#### 问题

当前仓库主要依赖本机 agent 执行 unit/selfhost、typecheck 和 outer-test；没有最小远程 CI 作为独立、不可遗漏的基础门禁。

#### 优化方法

新增一个最小 CI，不引入复杂矩阵：

1. 固定 Node 24 和 pnpm lockfile；
2. `pnpm install --frozen-lockfile`；
3. default/unit-selfhost suite；
4. `pnpm typecheck`；
5. tool contract/diff check；
6. Seatbelt/loopback/LaunchAgent host suite 继续由可信 Mac verifier 完成。

CI=none 不应成为 GrandeGPT 自身核心代码的长期正常状态。

### 5.14 Monorepo 支持边界不清楚

#### 问题

普通 Seatbelt profile 目前主要验证根目录 `node_modules/.bin`，复杂 pnpm workspace 可能需要多个 package-local executable 目录。直接递归放行会扩大候选可执行范围。

#### 优化方法

- 当前文档明确声明主要支持 root-command profile；
- onboarding/doctor 检测 workspace 布局并给出 `unsupported/unverified`，不能误报 ready；
- 有真实项目需求后，从 approved profile 的固定 cwd 和包路径枚举最小 executable dirs；
- 不使用覆盖整个仓库的递归 executable glob；
- monorepo 支持作为独立设计与 host evidence，不夹带进普通 bug 修复。

### 5.15 文档、Backlog 和 Pact 状态漂移

#### 问题

README 中存在历史 tool count/test count，Pact 中已接受 feature 仍可能显示 in-progress，当前开发 worktree 又不一定出现在 canonical 状态。多个 spec、plan、research 和 closeout 同时包含状态描述。

#### 优化方法

只保留三类活文档：

1. `README.md`：产品定位、当前稳定 tool contract 和基本运行方式；
2. `docs/BACKLOG.md`：问题、优先级、状态和关闭标准的唯一权威；
3. operations/runbook：部署、恢复、验证和 runtime identity。

其余 spec、plan、research 和 closeout 只保存历史决策与 evidence，不维护“当前状态”。发布时通过一次固定检查更新 README 中的 build-independent contract 信息。Pact 只作为 GrandeGPT 自身并行开发协调工具，不进入产品 runtime 权威链。

### 5.16 已知 Git 与运维遗留必须优先于新功能

以下现有 backlog 直接影响连续任务，不应被新的 capability 或工具扩展抢占：

- merge 后 local canonical 可能 stale；
- `grande_sync_base` 方向和 `up-to-date` 文案误导；
- Gateway restart 真实 host acceptance 未完全关闭；
- production activation 与“代码已 merge”仍需明确区分；
- PAT least privilege、backup 和 CLI issuer 配置仍需收敛。

处理原则是观察外部状态后再重试，固定 origin/default branch、clean + fast-forward-only，dirty/local-ahead/diverged 一律 fail closed。

### 5.17 Production 配置、凭据和 activation 语义需要收敛

#### 问题

Gateway issuer、LaunchAgent 环境、GitHub credential、运行 checkout、toolset snapshot 和 production activation 分布在 CLI、控制配置、宿主进程与 ChatGPT App。代码已 merge、LaunchAgent 已 restart、Gateway 已运行目标 build、App 已 refresh 是四个不同事实，混在一起会产生“代码已经合并，所以 production 已启用”的误判。

GitHub PAT 如果权限过宽，或 issuer 同时从命令参数、环境和历史配置推导，也会增加轻量运维的安全和排障成本。

#### 优化方法

- `GRANDE_ISSUER` 保持单一显式来源；doctor 显示 runtime issuer、endpoint origin 和发现文档是否一致；
- LaunchAgent 安装/更新保存目标 build 和必要环境的摘要，不在日志打印 secret 值；
- GitHub credential 使用满足当前 PR/check/merge 能力的最小权限，并由 doctor 检查能力而不是输出 token scope 原文；
- production activation 独立签发 activation receipt，至少包含 target build、runtime build、toolset epoch/digest、restart 时间和 read probe；
- merge、deploy 和 activation 在状态输出中分别表达；
- restart 必须 failure-safe：已加载时优先原位 kickstart，返回成功前等待 endpoint readiness；
- 失败时给出恢复动作，但不自动更换 issuer、credential 或放宽 Access policy。

#### 验收标准

- 任意状态页面不能把 merge success 显示成 production active；
- runtime build/toolset 与目标不一致时 activation 失败；
- issuer 不一致在启动或 doctor 阶段明确报错；
- credential 缺失和权限不足能区分，日志中无 token；
- restart 返回成功时 LaunchAgent、endpoint 和 read probe 均已恢复。

## 6. 开发流程简化设计

### 6.1 当前过度繁琐的来源

一次开发任务可能同时维护：

- GrandeGPT Task/job/attestation/receipt；
- Git branch/worktree/PR/CI；
- Pact feature/task/reviewer/accept；
- spec/plan/amendment/research/backlog/agent prompt/closeout。

问题不是安全门禁本身，而是同一进度被多套系统重复表示。普通 bug 与 Git、沙箱、Auth 修改又经常使用近似相同的完整流程，增加 agent 调用和人工等待。

### 6.2 统一风险分级

#### L1：轻量变更

适用：

- 纯文档和非运行资源；
- 不改变策略、schema、工具契约或执行路径的测试文本整理；
- classifier 可以确定为 `none` 的变更。

流程：

`Task -> 修改 -> 基础检查 -> commit/push/PR -> CI -> merge -> refresh/cleanup`

不运行 host verifier，不要求完整 spec、独立 reviewer 或人工 receipt。

#### L2：标准开发

适用：

- 普通业务源码和常规 bug；
- 不触及安全边界、Git lifecycle、Gateway lifecycle 或 production policy；
- classifier 判断为 `smoke`。

流程：

`Task -> inspect/edit/test loop -> attestation -> commit/push/PR -> CI -> smoke verifier（需要时） -> merge -> refresh/cleanup`

使用一个简短 TaskBrief，不要求多份阶段文档。

#### L3：核心高风险

适用：

- sandbox、runner、Safe Git、auth/OAuth、Gateway bind/lifecycle；
- host verifier、receipt、merge gate；
- trusted profile/policy、数据库 schema/migration；
- deployment/rollback/production activation；
- classifier 无法确定的生产代码路径。

流程：

`spec -> implementation plan -> TDD -> independent review -> full unit/typecheck/CI -> full host verifier -> exact-SHA merge -> Human activation（如涉及 production） -> runtime verification`

无法分类时进入 L3，不能由 agent 自行降级。

### 6.3 文档产物分级

| 变更级别 | 必需文档 |
|---|---|
| L1 | TaskBrief 或 commit/PR 描述；不新建 spec/plan |
| L2 | 一个 TaskBrief，包含目标、范围、验收和回滚 |
| L3 | 一个 design spec + 一个 implementation plan + evidence/closeout；amendment 只在真实平台阻塞导致设计改变时创建 |

Research 只记录可复现证据，不维护当前 status。Agent prompt 只引用 spec/plan，不复制整份内容。

### 6.4 用户授权模型

一次用户授权的开发任务内，agent 可以自动连续执行：

- 已注册 repo 的 inspect；
- Task/worktree 创建；
- repo edit；
- 已批准 profile；
- commit；
- task branch push；
- PR open/status；
- bounded CI wait；
- 按 classifier 选择 none/smoke/full verifier；
- exact-SHA merge；
- clean + fast-forward-only canonical refresh；
- 已完成 Task/worktree cleanup。

以下情况必须停下请求用户：

- 新增仓库或扩大控制平面权限；
- production 首次启用；
- rollback；
- 凭据创建、替换或权限扩大；
- merge/rebase conflict；
- canonical dirty、local-ahead 或 diverged；
- 外部状态无法确定；
- 有限重试仍失败；
- 任何可能删除非 disposable/已完成 Task 数据的动作。

### 6.5 自动连续执行方式

不增加 workflow engine 或万能工具。使用现有状态投影完成自动续跑：

1. `grande_task_status` 返回唯一 blocker 和 `nextAction`；
2. agent 在授权范围内执行 nextAction；
3. 异步 job 使用 server-side bounded wait，避免短轮询；
4. 终态后再次读取 task/PR/runtime exact identity；
5. 到达下一 Human Gate、不可恢复 blocker 或 DONE 才停止；
6. 用户只看到关键里程碑、失败原因和最终 evidence，不需要复制 receipt 或判断 SHA。

### 6.6 Review 要求分级

- L1：实现 agent 自检和自动测试即可；
- L2：普通 PR review 或自动 code review，只有高影响 diff 才要求独立新上下文；
- L3：必须独立 reviewer，不能由实现者 self-accept；
- 前端 T2/T3 继续遵循项目现有 Frontend Design Workflow，不由本规格降级。

Pact reviewer/accept 仅用于 GrandeGPT 自身的大型并行开发或明确要求的多 agent 项目，不强制进入普通轻量项目流程。

## 7. 目标运行模型

### 7.1 正常开发闭环

```text
User request + one scoped authorization
  -> Task/worktree
  -> inspect/edit/test loop
  -> commit-bound attestation
  -> push + PR
  -> bounded CI observation
  -> risk-based host verification
  -> exact-SHA merge
  -> canonical fast-forward refresh
  -> completed-task cleanup
  -> final evidence summary
```

### 7.2 异常处理原则

- **先观察，再重试**：push/PR/merge/deploy 响应丢失后先查询远端真实状态，避免重复副作用；
- **有限重试**：只对明确瞬态错误重试，次数和总时间固定；
- **fail closed，但不给用户制造无意义工作**：安全证据不满足时拒绝；cleanup、状态展示等非承重故障不能浪费已经有效的 exact-SHA 验证；
- **错误分层**：candidate test failure、infrastructure failure、policy denial、resource exhaustion、external unknown 分别表达；
- **保留恢复路径**：每个 blocker 返回下一条可执行动作，不能只返回失败文本。

## 8. 实施优先级

### Phase A：连续运行基础，优先于新功能

1. 完成并验证 host verifier restart recovery；
2. 修正 receipt/cleanup 顺序并接入 GC 对账；
3. 实现 SQLite backup + 顺序迁移；
4. 增加最小 CI；
5. 增加 Gateway/CLI 共用的跨进程 repo lock；
6. 关闭或明确缓解 stale canonical 和 restart acceptance backlog。

**退出条件**：Gateway 重启、数据库升级、verifier cleanup 失败和 CLI/Gateway 并发都能自动收敛，不需要删除状态库或人工复制 receipt。

### Phase B：结构收敛

1. 抽取窄 ProcessSupervisor；
2. deployment 改用领域函数，不调用公开 tool handler；
3. 建立静态 ToolSpec registry 和固定 middleware 顺序；
4. 为 job summary/receipt 建立单一 codec 和 eligibility；
5. 冻结工具契约，不增加 provider 类型；
6. 用真实资源证据收紧 verifier 上限。

**退出条件**：只有一套进程生命周期语义、一套 receipt eligibility、一个明确工具组装顺序，不存在 deploy/capability 共享可变接线环。

### Phase C：流程与文档收敛

1. 实施 L1/L2/L3 分级；
2. Pact 和 independent review 只用于适用级别；
3. README、BACKLOG、runbook 成为三类活文档；
4. 普通 Task 根据 nextAction 连续执行；
5. 下一次正式 tool epoch 根据真实使用数据评估 capability 工具精简。

**退出条件**：普通 bug 不再创建完整 spec/plan/research 链，用户除明确 Human Gate 外不需要参与中间步骤。

### Phase D：受控启用自动模式

1. manual 模式完成全部 host gate；
2. 在 development/staging Gateway 启用 auto；
3. 连续完成至少 20 次 selfhost verifier；
4. 覆盖 Gateway restart、cleanup failure、SHA drift、busy、timeout、RSS 和 port retry；
5. production activation receipt 证明运行 build 与目标 exact build 一致；
6. 保留一键切回 manual，不接受 unsandboxed fallback。

### 8.1 后续 implementation plan 的代码落点

后续计划必须在当时的最新集成分支重新验证路径和依赖，预期主要涉及：

| 优化主题 | 主要现有文件 | 允许新增的窄模块 |
|---|---|---|
| DB migration/backup | `src/db.ts`、`src/layout.ts`、`src/cli.ts` | `src/dbMigrations.ts`、`src/controlBackup.ts` |
| 跨进程 repo lock | `src/repoWriteLock.ts`、`src/tools.ts`、`src/worktreeGc.ts`、`src/cli.ts` | `src/repoProcessLock.ts` |
| Verifier restart/cleanup | `src/hostVerifierRuntime.ts`、`src/jobs.ts`、`src/server.ts`、`src/outerTestReceipt.ts` | `src/hostVerifierRecovery.ts` |
| 统一进程监管 | `src/sandbox.ts`、`src/runner.ts`、`src/hostVerifierRuntime.ts` | `src/processSupervisor.ts` |
| Tool registry/middleware | `src/tools.ts`、`src/toolsCore.ts`、`src/localLoopTools.ts`、`src/prLifecycle.ts` | `src/toolRegistry.ts`，仅在不能在 `tools.ts` 内清晰表达时新增 |
| Deployment/capability 解耦 | `src/deployment.ts`、`src/capabilities.ts` | 复用现有领域函数；不新增通用 workflow 模块 |
| Receipt codec/eligibility | `src/jobs.ts`、`src/outerTestReceipt.ts`、`src/prHostVerification.ts`、`src/taskProgress.ts` | `src/jobSummary.ts` 或 `src/receiptEligibility.ts`，保持职责单一 |
| 最小 CI | `package.json`、`vitest.config.ts`、tool contract checks | `.github/workflows/ci.yml` |
| Product/status 收敛 | `README.md`、`docs/BACKLOG.md`、现有 runbook、`.pact/` | 不新增另一份 active status 文档 |

禁止为了匹配此表机械创建空模块。若最新代码已经提供清晰、单一职责的实现，计划应修改现有文件并解释为何无需新增模块。

## 9. 整体验收指标

### 9.1 安全

- 无 `shell_exec`、`host_exec`、任意 argv/cwd/env；
- 候选代码不能修改 verifier manifest、policy、receipt 或 trusted runtime 输入；
- exact-SHA 链在 commit、PR、CI、host verifier、merge 和 deploy 间保持一致；
- secrets 不进入 candidate env、artifact、日志或 tool output；
- cleanup 和 GC 目标均有固定根与 overlap guard。

### 9.2 可靠性

- Gateway restart 后没有永久 running verifier；
- schema upgrade 不要求删除状态库；
- cleanup failure 不浪费有效验证；
- CLI/Gateway 并发不会重叠修改同一 repo；
- push/PR/merge/deploy 响应丢失不会重复副作用；
- auto verifier 连续 20 次完成，无 Gateway outage 或人工 receipt 操作。

### 9.3 效率

- 普通 L2 任务从用户授权到 merge 期间，除 blocker 外不再要求中间确认；
- 异步 job 不使用高频轮询；
- 普通 bug 只产生一个 TaskBrief；
- 公开工具数量在当前收敛期不增长；
- 用户不需要读取、复制或判断 receipt/attestation SHA。

### 9.4 可维护性

- 一个进程监管 primitive；
- 一个 receipt parser/eligibility；
- 一个静态工具 registry 和固定 middleware 顺序；
- deployment 不调用公开 tool handler；
- active status 只在 BACKLOG 和 runtime state 维护；
- 新通用 abstraction 必须有至少两个真实使用者。

## 10. 回滚策略

- Host verifier：控制模式切回 `manual`，保留 V2 receipt 读取和 exact-SHA gate；
- 数据库迁移：停止新 binary，恢复迁移前 backup，使用兼容旧 binary；
- Repo lock：若新跨进程锁出现误判，回退到 manual CLI 排他运行，不能回退为并发无锁写；
- Capability 收敛：在正式 tool epoch 前保持兼容；移除公开工具必须经过 Dev App、tool digest、Production App refresh 和新聊天验证；
- 自动 cleanup：出现不确定目标时关闭自动 cleanup，保留 status + Human `gc --apply`，不放宽删除 guard；
- Auto mode：任何安全或稳定性异常立即切回 manual，不启用 unsandboxed fallback。

## 11. 防止再次过度设计的架构纪律

后续每项功能必须回答以下问题：

1. 能否由现有 Task、job、audit、profile、receipt 和高层工具表达？
2. 是否真的减少了用户操作或已重复出现的故障？
3. 新公开工具减少的用户轮次是否大于 binding、schema 和维护成本？
4. 新持久状态是否无法通过现有状态投影得到？
5. 新通用 abstraction 是否已有至少两个真实、长期使用者？
6. 是否引入另一套进程生命周期、eligibility、重试或状态真相源？
7. 对轻量项目的收益是否足以抵消安装、内存、CPU、存储和运维成本？
8. 是否存在更窄、固定、可测试的实现？

任一答案不清楚时，默认不增加新子系统，先使用现有机制和真实 dogfood 收集证据。

## 12. 最终决策摘要

GrandeGPT 不需要重写。应保留单 Gateway、SQLite、worktree、Seatbelt、Safe Git 和 exact-SHA 证据链，同时停止继续扩张通用能力层。

近期最重要的工作不是增加功能，而是完成以下收敛：

1. 数据库可迁移、可备份；
2. Gateway/CLI 写操作跨进程互斥；
3. verifier restart 和 cleanup 自动收敛；
4. 进程监管和 receipt eligibility 只有一套实现；
5. deployment 与 capability 解耦；
6. L1/L2/L3 风险分级取代所有修改一律完整流程；
7. 用户只在真实 Human Gate 介入，其余步骤由 agent 连续完成。

完成 Phase A 后，GrandeGPT 可以更可靠地承担轻量和中小型项目的连续开发任务；完成 Phase B/C/D 并取得真实 host/production evidence 后，才适合把自动 host verification 和更长的无人值守运维闭环作为稳定能力对外承诺。
