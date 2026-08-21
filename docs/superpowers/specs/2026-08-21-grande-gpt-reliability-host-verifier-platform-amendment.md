# GrandeGPT Reliability Host Verifier — macOS Platform Amendment

> **Status:** Human Owner approved on 2026-08-21. This amendment overrides only the conflicting host-verifier clauses in `2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md`; all other design constraints remain in force.

## 1. Why an amendment is required

Five real-host feasibility runs narrowed two assumptions in the original Slice B design to macOS platform constraints rather than implementation bugs:

1. 已处于 Seatbelt sandbox 内的进程再次调用 `sandbox-exec`/`sandbox_apply` 时，inner nominal-allow 与 deny 路径都以 exit 71 失败。继续增加 `process-fork`、canonical executable path 等没有改变该结果。递归 Seatbelt 因此不能作为 target macOS 上的可满足安全证明。
2. broad localhost outbound allow 能正确拒绝真实 LAN peer，但无法可靠表达“允许任意 localhost 临时端口、同时排除 `127.0.0.1:8787`”。`remote ip` 与 `remote tcp` 的 narrow deny 都没有覆盖已授予的 broad localhost capability。
3. Real-host SBPL parsing additionally proved that exact port filters must use Seatbelt's `localhost:<port>` network-address spelling for `local ip`/`remote ip`; literal `127.0.0.1:<port>` is rejected at profile compile time (`host must be * or localhost in network address`). Runtime TCP listeners/connects still bind explicitly to `127.0.0.1`; only the SBPL filter spelling changes.

这些结果不能通过放宽测试断言、扩大 network/file/process 权限或把失败改成 skip 来“修复”。因此需要改证明方式，而不是降低安全目标。

## 2. Approved design changes

### 2.1 One outer Seatbelt + child inheritance / non-escape proof

原要求 “nested Seatbelt produces a true inner allow/deny result” 改为：

- trusted host parent 构造并启动**唯一的 outer verifier Seatbelt**；
- verifier 内允许 fork/exec 仅 trusted exact executable；
- 普通 child process 自动继承同一 sandbox 边界；
- child 必须能完成允许的 verifier fixture 读取与 job-temp 写入；
- child 必须无法读取 control/workspace/canonical/task/DB/credential-store；
- child 必须无法访问 LAN/non-loopback 或未分配 loopback port；
- child 不得获得 candidate-controlled profile/env/cwd/argv 扩权路径。

如果保留一次 inner `sandbox-exec` 负向 probe，exit 71 / permission denied 只作为“不能重新应用/替换 sandbox”的补充 non-escape evidence；**不再要求第二层 Seatbelt 成功**。

### 2.2 Trusted host manifest distinguishes auto-safe vs manual-only

host manifest 新增 trusted execution 属性：

- `auto`: 可在 one-shot verifier 的 single Seatbelt 边界内执行；
- `manualOnly`: 测试主体本身需要启动第二个 Seatbelt 边界，或依赖无法安全嵌入 auto verifier 的 host behavior。

至少以下类型属于 `manualOnly`：

- `tests/host/sandbox.host.test.ts`；
- verifier Seatbelt 自身 feasibility/security boundary cases；
- 任何未来需要 `sandbox-exec`/`sandbox_apply` 再包一层的 host case。

Trusted changed-file planning 必须 fail closed：

- 普通 source bugfix 仍可得到 `smoke/full + auto-safe`；
- 修改 `src/sandbox.ts`、`src/sbpl.ts`、host-verifier policy/profile、manual-only host test 等 security boundary 路径时，得到 `full + manualOnlyRequired`；
- auto verifier receipt 只能覆盖 auto-safe files；
- manual-only case 的成功不能被普通 auto receipt 冒充或省略。

因此“普通自举 bugfix 零人工 outer-test”仍是目标；安全边界本身的 Seatbelt 变更属于少量预定义 Human Gate，不算普通路径。

### 2.3 Trusted parent preallocates exact loopback ports

删除“allow localhost:* 再 deny production port”的模型。Verifier 默认没有任何 network capability；trusted parent 在 sandbox launch 前为本 job 分配有限数量的 exact loopback ports，并把**仅这些端口**编译进 Seatbelt profile：

- runtime listener/connect 仍显式使用 `127.0.0.1:<allocatedPort>`；
- Seatbelt filter 必须使用其可接受的 exact address spelling：`localhost:<allocatedPort>`；
- bind/inbound/outbound 只允许这些 exact `localhost:<allocatedPort>` filters；
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

- nested Seatbelt success proof；
- broad ephemeral localhost allow + production-port carve-out；
- “all host files are auto-runnable under one verifier” 的隐含假设；
- 任何把 runtime random ports 排除在 receipt/plan identity 外的实现。

其余约束全部保留：exact SHA、trusted manifest、fixed runner、default deny、credential isolation、job-temp-only writes、no arbitrary host exec、no candidate-controlled policy/receipt、PASS 不自动 merge、manual mode 默认不变。

## 4. Activation consequence

这个 amendment **不构成 auto mode 激活批准**。实现完成并通过 real-host gate 后，仍须继续 Slice C/D、回归、20-run soak（若原 design 要求）以及 Human Owner 对 production `hostVerification.mode=auto` 的显式批准。
