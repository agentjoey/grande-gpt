# GrandeGPT Host Verifier macOS Platform Amendment

**状态：** Approved by Human Owner

**日期：** 2026-08-21

**作用域：** `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md` 的 macOS Host Verifier 实现约束

**优先级：** 本 amendment 与原设计共同构成本任务的批准设计来源；仅在下列条款冲突时，本 amendment 优先。未被明确修改的原设计要求全部继续有效。

## 1. 触发原因与已验证平台事实

Slice B 在真实 trusted host 上连续得到两个稳定结果：

1. 已处于 Seatbelt sandbox 内的进程再次调用 `sandbox-exec`/`sandbox_apply` 时，inner nominal-allow 与 deny 路径都以 exit 71 失败。继续增加 `process-fork`、canonical executable path 等没有改变该结果。递归 Seatbelt 因此不能作为 target macOS 上的可满足安全证明。
2. broad localhost outbound allow 能正确拒绝真实 LAN peer，但无法可靠表达“允许任意 localhost 临时端口、同时排除 `127.0.0.1:8787`”。`remote ip` 与 `remote tcp` 的 narrow deny 都没有覆盖已授予的 broad localhost capability。

这些结果记录在 `docs/research/2026-08-21-host-verifier-feasibility-gate.md`。不得通过削弱断言、扩大 sandbox 权限或把平台拒绝当作 PASS 来绕过。

## 2. 批准的设计修订

### 2.1 单一 outer Seatbelt + child inheritance/non-escape

自动 verifier 只建立**一个**由 trusted Gateway parent 构造的 outer Seatbelt boundary。候选 Vitest/Node 子进程及其普通 child process 必须继承该 boundary；自动 verifier 不要求、也不依赖 candidate child 成功再次 `sandbox_apply`。

Slice B 的原“nested Seatbelt true inner allow/deny”承重证明替换为：

- outer verifier Seatbelt 能正常启动 trusted Node/Vitest entry；
- outer sandbox 内允许 `process-fork`，但 `process-exec` 仍只允许 trusted exact executable files；
- child 能读取 verifier fixture、写 job temp、使用被明确允许的 exact loopback test port；
- 同一个 child 不能读取真实 control/workspace/canonical/task/credential 路径，不能访问 LAN/外网，不能写真实状态；
- child 不能通过再调用 `sandbox-exec`/`sandbox_apply` 获得更宽权限。若平台返回 exit 71 / permission denied，它是 non-escape 的补充证据，不再要求 inner apply 成功。

这证明生产架构真正依赖的性质：candidate/test child **继承且不能逃离** verifier boundary。

### 2.2 Recursive-Seatbelt host cases 保持 predefined Human Gate

任何测试若其被验证行为本身必须启动第二个 Seatbelt boundary（例如真实验证普通 `runSandboxed()`/`src/sbpl.ts` 的 host behavior），都不能放进 outer-Seatbelt 自动 verifier 后再递归执行。

可信 host manifest/plan 必须把此类 case 标记为 `manualOnly`（具体字段名可在实现计划中确定，但语义必须固定），且：

- 普通任务的 auto-safe host suite 不运行 recursive-Seatbelt case；
- 变更 `src/sandbox.ts`、`src/sbpl.ts`、trusted verifier policy/profile，或其他需要真实第二层 Seatbelt 证明的关键路径时，classifier/plan 必须 fail closed 为 predefined Human Gate；
- 此 Human Gate 继续使用 Human Owner 显式触发的 exact-SHA manual host path；Gateway/MCP 不获得通用 unsandboxed candidate execution 能力；
- manual-only case 的成功不能被普通 auto receipt 冒充或省略。

因此“普通自举 bugfix 零人工 outer-test”仍是目标；安全边界本身的 Seatbelt 变更属于少量预定义 Human Gate，不算普通路径。

### 2.3 Trusted parent 预分配 exact loopback ports

删除“allow localhost:* 再 deny production port”的模型。Verifier 默认没有任何 network capability；trusted parent 在 sandbox launch 前为本 job 分配有限数量的 exact IPv4 loopback ports，并把**仅这些端口**编译进 Seatbelt profile：

- bind/inbound/outbound 只允许 `127.0.0.1:<allocatedPort>`；
- 不允许 `localhost:*`、任意端口范围、LAN 或外网；
- production Gateway port `8787`（或 trusted runtime 当前 production port）不得出现在 allocation 中，因此由 deny-default 自然拒绝，不依赖 deny-within-allow carve-out；
- allocation 由 trusted parent 产生，candidate/task/argv/env 不能请求端口；端口冲突是 infrastructure failure，不得通过扩大网络规则恢复；
- 同一 Gateway 仍最多一个 verifier，降低端口竞争。

B2 feasibility probe 使用 trusted parent 先分配一个 exact test port，再构造 profile；sandbox 内必须证明该端口 bind/connect 成功，同时真实 LAN peer 与 production port 均因 default-deny 返回 permission denied。

### 2.4 Execution-plan identity 与 Receipt V2

Exact loopback allocation 属于真实执行计划的一部分，不能脱离 receipt identity：

- trusted job 持久化/记录 static plan（files、level、policy version、resource limits）与 runtime allocation（排序后的 exact loopback ports）；
- Receipt V2 的 `planDigest` 覆盖 static plan **以及** runtime exact loopback ports；
- 后续 receipt eligibility 不重新随机分配端口来计算 expected digest，而是通过 receipt `jobId` 读取 trusted finalized job execution plan，重算 `planDigest`，并另外确认当前 static plan 仍与该 job 的 static plan 一致；
- coalescing 在 job 尚未分配 runtime ports 前使用 trusted static request identity `(taskId, repoId, commit, level, staticPlanDigest)`；job 创建后记录最终 `planDigest`；
- policy version、files、level、resource limits 或 SHA 变化仍使旧 receipt 失效。

不为此增加 candidate-controlled receipt 字段或 MCP 参数。

## 3. 对原设计条款的明确覆盖

以下原设计文字被本 amendment 覆盖：

- §6.5 “loopback bind/connect 到系统分配的临时端口”改为“trusted parent 预分配并编译进 profile 的 exact loopback ports”；
- §6.5 “为 sandbox 承重测试执行嵌套 `sandbox-exec`”删除，改为 child inheritance/non-escape；
- §6.5/§6.6 “production Gateway port 显式 narrow deny”改为“production port 永不进入 exact allowlist，由 deny-default 拒绝”；
- §11 Slice B 的 “nested sandbox” probe 改为 inheritance/non-escape probe；
- §13.1(3) 的“临时 loopback listener 正常”解释为“仅 trusted execution plan 中 exact allocated loopback listener 正常”；
- §6.9/C3 的“manual fallback 全部走同一 restricted orchestrator”对 recursive-Seatbelt `manualOnly` case 有一个窄例外：它仍由 Human Owner 显式启动现有 exact-SHA host path，且不得由 MCP/Gateway 自动调用。其他 manual fallback 继续走 restricted orchestrator。

## 4. Slice B 修订后的必须 PASS 证据

进入 Slice C 前，真实 trusted host 必须同时证明：

1. outer Seatbelt 内 child inheritance/non-escape：允许 fixture 行为成功，真实敏感路径/LAN 行为被拒，child 不能获得更宽 sandbox 权限；
2. Safe Git hook marker：raw Git 真执行 hook，Safe Git override 真抑制；
3. trusted exact loopback port：allocated port bind/connect PASS，LAN peer DENY，production port DENY；
4. process-group cleanup：timeout 后 orphan child 消失；
5. control/workspace/canonical/task/DB/credential/env negative probes继续 PASS；
6. recursive-Seatbelt case 被可信 plan 明确标为 manual-only，不被 auto-safe receipt 计入 PASS。

任一项缺少真实证据仍停在 Human Gate；不得进入 Slice C。

## 5. Policy version 与安全回滚

这次修改改变 verifier network/process proof semantics，`HOST_VERIFIER_POLICY_VERSION` 必须从 1 bump 到 2。未来 Receipt V2 必须绑定该 version。

回滚仍是 `hostVerification.mode=manual`。不得为了绕过 macOS 限制恢复 broad localhost allow、自动 unsandboxed candidate execution、通用 host exec 或独立高权限 verifier 服务。
