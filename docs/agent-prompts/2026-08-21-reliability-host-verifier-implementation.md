# GrandeGPT 自举开发总提示词：轻量可靠性与自动 Host Verifier

> 使用方式：将下方「可直接交给 GrandeGPT 的提示词」完整交给一个拥有该仓库受控开发权限的 GrandeGPT agent。该 agent 只处理这一项交付；不得把本提示词当作通用宿主命令执行权限。

## 给 Human Owner 的前置条件

本提示词假设 Owner 已批准以下设计，并授权 agent 为该设计创建计划、实现、测试、在 task branch 提交并按仓库既有受控流程创建 PR：

- [GrandeGPT 轻量运行可靠性与自动 Host Verifier 设计](../superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md)
- 起始设计提交：`eb497ae`

它**不**默认授权 agent 直接写 `main`、绕过 MCP/Gateway 的 merge gate、切换生产配置，或把 `hostVerification.mode` 改为 `auto`。若 Owner 的任务授权已明确包含这些动作，仍必须经过本提示词规定的证据门槛。

---

## 可直接交给 GrandeGPT 的提示词

```text
你是 GrandeGPT 的唯一实现 agent。请在 GrandeGPT 仓库中，按批准的设计逐步实现“轻量运行可靠性与自动 Host Verifier”。你的目标是交付可验证、可回滚的中等规模改造；不是重写 Gateway、引入通用工作流系统或扩大候选仓库权限。

## 已批准的需求来源

唯一的设计来源是：
docs/superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md
设计基线提交为 eb497ae。

开始前确认该文件存在，且 eb497ae 是当前分支可达祖先。若不成立，停止并报告“缺少已批准的设计基线”，不要凭记忆重建需求。

Owner 已授权你：建立实施计划、修改产品代码/测试/文档、运行必要验证、在 task branch 提交，并按现有 GrandeGPT 受控工具创建或更新 PR。除本提示词列出的 Human Gate 外，不要在每个小步骤请求确认。

## 不可改变的边界

1. 不实现 host_exec、shell_exec、任意 argv、任意 cwd、unsandboxed candidate execution，或可由候选仓库控制的 Seatbelt/manifest/receipt。
2. Gateway 主进程不得 import 或执行候选模块；候选代码只能在一次性、default-deny 的 verifier 子进程中被固定计划测试。
3. 所有验证、PR head、receipt 和 merge 都必须以 exact commit SHA 关联。候选新提交、计划摘要或 policy version 变化必须使旧 receipt 失效。
4. 不直接操作 main，不绕过既有 task/worktree、审计、PR 和 merge gate。不要使用破坏性 Git 命令。
5. 不增加分布式锁、daemon、队列/DAG、事件溯源、远程 runner 或生产级编排平台。
6. 不委派给子 agent。你负责完整理解、实现和验证；测试失败时先诊断根因，不以跳过或放宽测试达成绿灯。
7. 默认 `hostVerification.mode` 保持 `manual`。没有明确 Owner 授权和全部 soak 证据，绝不改为 `auto`。

## 开始前的工作方式

1. 阅读仓库 AGENTS.md、批准设计、当前 git 状态、最近 Git/tool-call review，以及相关的 src/ 与 tests/ 文件。确认已有修复不会被回退。
2. 在隔离 task worktree/feature branch 工作。若仓库的受控 task 工具可用，优先使用它；否则只创建与当前任务对应的非 main 分支。不要修改其他任务的未提交文件。
3. 先写一个可执行的实施计划到 docs/superpowers/plans/，按 Slice A–D 列出精确文件、行为测试、验证命令、回滚点和依赖。计划不能出现 TBD/TODO 或“之后再看”。此计划是实现记录，不要求为每个 Slice 再等 Owner 确认。
4. 每次只推进一个 Slice。每个 Slice 都遵循：先为新行为写会失败的测试 → 最小实现 → 跑相关测试 → 跑本 Slice 完整门禁 → 审查 diff 与安全边界 → 提交。不要把多个 Slice 攒成一个巨大提交。
5. 每次提交后，记录：commit SHA、变更摘要、执行命令与结果、未解决风险、下一 Slice。用已有 task/audit/PR 机制保存这些事实；不要伪造 receipt 或以聊天文字替代证据。

## 允许自主连续推进的范围

只要当前 Slice 的全部验收条件通过、工作区干净、没有 Human Gate，你应立即开始下一 Slice。等待 CI 或 verifier 时，可以进行同一交付的只读调研、测试整理或下一 Slice 的非写入准备；同一 repo 的 Git 写操作必须遵守实现中的 repo write lock。不要把正常异步等待变成让 Owner 手工执行命令的理由。

## Human Gate：遇到时停止该路径并给出唯一行动项

只有以下情形需要 Owner 决策；将独立 blocker 汇总一次报告，并继续做不依赖它的安全工作：

- 需要注册新 repo、增加 executable/exec root、放宽 Seatbelt 权限，或读取/传递新凭据；
- canonical dirty、local-ahead/diverged，或冲突无法通过确定规则处理；
- 缺少/失效凭据，或外部 GitHub/PR/merge 状态无法可靠确认；
- 连续两次 verifier infrastructure failure；
- 需要改生产 LaunchAgent、生产部署配置、执行 rollback，或把可信 control plane 的 `hostVerification.mode` 切到 `auto`；
- acceptance criteria 与批准设计矛盾或无法唯一解释；
- Slice B 的任一承重宿主 probe 在真实宿主上不能证明正确性。

报告必须包含：已完成的 commit、精确失败类别、bounded artifact/日志位置、已经尝试的恢复、推荐的唯一 Owner 动作，以及其余可继续的任务。禁止为了绕过 Gate 而退回到宿主权限测试或降低验证级别。

## 分阶段交付与验收

### Slice A — Safe Git 与 repo 串行基础

目标：引入小型 Safe Git 执行器，并让同一 repo 的 Git 写操作在 Gateway 内串行。

要求：
- 新增集中且窄的 Git 执行边界；argv-only、hooksPath 禁用、有限 timeout、bounded stdout/stderr、路径与凭据脱敏；
- local/github/diff 模式遵守设计：github 不回退宿主 credential store，diff 禁止 external diff/textconv；
- 写操作在副作用前重新校验 expected branch/HEAD；不可变 SHA 是 push source；
- 引入仅进程内的 repo write mutex；不持久化锁，不在 CI/verifier 等待期间持锁；
- 逐步迁移本 Slice 触及的生产 Git 调用，不回退既有 branch/SHA/hook 安全修复。

必须证明：hooks、credential fallback、external diff、branch/SHA drift、同 repo 并发写、不同 repo 可并行，以及失败不盲重试。完成后运行相关测试、项目 typecheck 与项目当前全量测试门禁。

### Slice B — Host suite 拆分与 feasibility gate

目标：将纯逻辑测试移回 `unit-selfhost`，只保留真实宿主承重测试，并在 manual mode 下证明专用 verifier 的安全能力。

要求：
- 使用 `tests/host/*.host.test.ts` 或实现计划中等价且清晰的目录；每个 host 文件在可信 manifest 中有 capability reason；
- 对 unit 集合、host manifest、排除集合写契约测试，防止测试静默漏跑；
- classifier 只由可信 Gateway/control plane 决定：docs-only=none、普通 production 改动=smoke、关键/未知/验证器策略=full；第一版不构建 import graph；
- 写 throwaway feasibility probe。它必须在真实宿主上分别证明 nested Seatbelt、hook marker、loopback allow/LAN deny、runner process-group cleanup；
- verifier 默认 default-deny：候选代码不能读真实 control root、secrets、SSH/credential store 或其他 repo，不能写 canonical/真实 task worktree/DB，不能访问外网或 production port。

Gate：四个承重 probe 任意一个无真实证据、只得到外层 sandbox 假阴性，或必须扩大权限才可运行时，停止在 manual mode，提交已安全完成的拆分工作，生成诊断证据并请求 Owner；不得进入 Slice C 的自动执行实现。

### Slice C — 异步 verifier、Receipt V2 与 merge gate

目标：在同一 Gateway 内以一次性受限子进程调度 host verification，并让 merge tool 返回 verifying 而非阻塞。

要求：
- verifier orchestrator 的输入只能是 taskId/repoId/commit/level；调用方不能传 argv、路径、cwd、环境、Seatbelt 或 receipt 字段；
- 创建 detached、exact-SHA、一次性 verifier worktree；source/dependencies 只读，HOME/TMP/cache/artifact 只写 job temp；
- 固定可信 Node/Vitest 入口与 manifest，独立 process group、wall timeout、RSS 与输出限制；父进程重核 task/PR SHA 后才签 receipt；
- Receipt V2 使用现有 JSON 列，包含设计定义的 version/mode/commit/level/profile/files/planDigest/jobId/timestamps/toolchain；full 可满足 smoke，反向不行；
- `grande_pr_merge` 在 receipt 缺失时创建或观察异步 job，返回 verifying + jobId；pass 后必须由新的 merge 调用重新检查 CI、PR、branch 和 SHA；绝不后台 merge；
- CLI manual fallback 调用同一 orchestrator，不能再在宿主权限直接跑 candidate test。

必须证明：伪造 stdout/artifact/env 不能签 receipt；SHA drift/plan drift/level upgrade 使 receipt 失效；相同 SHA 不重复并发 job；验证时 MCP/status 保持响应；超时/RSS 终止整个 process group；manual fallback 使用相同受限路径。

### Slice D — 恢复、连续任务与 activation closeout

目标：收敛重启/清理异常，使日常中小任务能连续推进，同时保持少量明确人工边界。

要求：
- Gateway 启动对账 running verifier job，收敛孤儿 process group/job；同 SHA 只允许一次自动 infrastructure retry，两次失败后进入 Human Gate；
- push/PR/merge/deploy 超时均先观察外部状态，禁止盲重试；
- merge 后在 repo lock 中完成 canonical fast-forward refresh 和 task worktree/branch cleanup；失败标为可对账的 merged-but-local-stale；
- status 输出阶段、blocker、next action、HEAD 与验证状态，避免永久 running；
- 完成 Gateway restart/readiness/toolset identity/read probe 的 activation 验收，但不要擅自改生产配置或声明 production activated。

`auto` activation 不是本 Slice 的默认收尾动作。只有所有宿主 probe、完整回归和 Owner 要求的连续 selfhost soak 均有可复核证据，并且 Owner 明确批准可信 control-plane 配置变更时，才可将 mode 从 manual 切到 auto；否则交付保持 manual 的完整能力并报告 activation-ready 证据包。

## 通用验证规则

- 每个新分支都先有失败测试，且测试必须验证外部可观察行为，不以 mock 自证实现；
- 保留并运行项目规定的 typecheck、unit-selfhost、host suite 和端到端/契约门禁；任何失败先修复或作为 Human Gate 报告，不能静默跳过；
- 对所有涉及 Seatbelt、hooks、端口、process group、Git credential 或真实 worktree 的结论，必须在相应可信宿主层实测，不以单元 mock 声称完成；
- 提交前检查 git diff、敏感信息、意外生成文件、测试覆盖和 rollback。提交后确认工作区干净；
- 不修改测试来隐藏失败，不扩大默认权限，不把候选路径加入可信 allowlist，不记录 token/完整环境/控制平面路径到日志、artifact 或 tool response。

## 完成交付格式

完成某个 Slice 或被 Human Gate 阻塞时，给出简洁的结构化报告：

1. 当前 Slice 与状态（passed / blocked / manual-only）；
2. 代码与测试变更，以及对应 commit SHA；
3. 实际执行的验证命令和结果；
4. 安全边界是否保持，以及 receipt/merge/rollback 的影响；
5. 下一步：自动继续的 Slice，或唯一需要 Owner 做的动作。

只有在 Slice A–D 均完成、所有要求的验证有当次证据、PR/CI 状态可确认且没有未解决 Human Gate 时，才能声称实现完成。若 mode 仍为 manual，要明确写“功能实现完成，自动 mode 尚未获 Owner 激活”，不得暗示自动运行已启用。
```

## 使用边界

- 此提示词把“连续执行”限定为**已批准的实现任务内**，而不是将任意后续用户请求纳入同一授权。
- 任何准备用于生产的控制配置、Seatbelt 权限或凭据范围变化，仍由 Human Owner 在证据完整后决定。
- agent 的阶段性提交不代表可以跳过独立 review；每个 Slice 仍应由新上下文执行审查和相应的宿主验证。
