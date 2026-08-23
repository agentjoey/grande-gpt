# ChatGPT Connector Compatibility Runbook

本 runbook 处理 GrandeGPT Gateway 正常、`tools/list` 可用，但 ChatGPT custom MCP App 出现 tool snapshot / session binding 漂移的情况。它只定义诊断与发布纪律；**不改变 Gateway 权限模型、不绕过 Gateway，也不改变 `grande_pr_merge` 的业务门禁。**

## 1. 三层事实必须分开

### Gateway reachable

先用现有只读入口验证服务端真实网络路径：

```bash
GRANDE_ISSUER=https://grande.agentjoey.ai \
node --disable-warning=ExperimentalWarning src/cli.ts selfcheck

GRANDE_ISSUER=https://grande.agentjoey.ai \
node --disable-warning=ExperimentalWarning src/cli.ts doctor --repo grande-gpt
```

`selfcheck` 必须走真实 HTTP `tools/list`，不是本地 `buildTools()` 推断。`doctor` 的 `Connector Compatibility` 会单独显示 `Gateway reachable`。

### Server toolset identity

Gateway 通过现有 `grande_task_status` 暴露以下字段，不新增额外 identity MCP tool：

- `gatewayBuild`：优先使用显式 `GRANDE_GATEWAY_BUILD`；否则为运行 checkout 的 `git:<40-char HEAD>`；没有 Git metadata 时才退化为 `dev`。
- `toolsetEpoch`：ChatGPT tool-contract compatibility epoch。**只有 tool contract 改变时才递增。**
- `toolsCount`：当前正式 onboarding contract 基线为 25。
- `toolsDigest`：`sha256:` digest，只覆盖稳定排序后的 tool `name + input schema + annotations`。

当前正式 contract 是 **epoch 2**（`toolsetEpoch=2`）/ **25 tools**。相对 epoch 1 的 23-tool baseline，只新增本地 `grande_repo_add_propose` 与 `grande_repo_add_apply`；前者 read-only proposal，后者是 Human Owner 明确确认后才调用的 write action。该 release 没有新增 open-world 或 destructive 工具。

`gatewayBuild` 与 `toolsetEpoch` 是两条不同的轴。实现代码可以变、build 可以变，而 tool contract 完全不变；这种情况下 epoch 必须保持不变，digest 也应保持不变。

### ChatGPT session binding

**ChatGPT session binding 无法由 server-side 直接验证。** Gateway 能证明请求是否到达、`tools/list` 返回了什么、server toolset identity 是什么，但不能证明某个旧聊天当前绑定的是哪一份 App/tool snapshot。

因此：App Refresh/Reconnect 之后的最终验证必须在**新聊天**完成；旧聊天没有恢复不能反推 Gateway 仍然故障。

## 2. 什么算 tool contract 变化

本 runbook 把以下内容定义为 tool contract：

- tool name
- input schema
- annotations（包括 `readOnlyHint` / `destructiveHint` / `openWorldHint`）

description、handler 实现、日志、CLI 文本、内部重构不进入 `toolsDigest`。不要为了普通 patch release bump `toolsetEpoch`。

### Release A 仓库读取预算（epoch 2 行为补丁）

Release A 收紧现有 `grande_repo_read.maxBytes` 与 `grande_repo_search.maxMatches` 的运行时行为，
但不新增、删除或重命名 schema 字段，因此仍属于 epoch 2 patch：

- `grande_repo_read` 默认返回 16 KiB，调用方最多请求 24 KiB；非正整数或超过 24 KiB 一律
  `INVALID_INPUT`，不静默钳制。截断响应保留完整文件的 `sha256`、`bytes`、`totalLines`，
  `hint` 给出带原仓库/任务绑定的下一次 `lineRange` 精确调用。
- `grande_repo_search` 默认 20 条，调用方最多请求 25 条；非正整数或超过 25 一律
  `INVALID_INPUT`。实际序列化后的 `SearchResult` 不超过 16 KiB；若字节预算移除尾部匹配，
  `nextCursor` 只按本页实际返回的匹配数推进，后续页不重不漏。
- 这是 description 与 handler 语义更新，不改变 tool name、input schema shape、required fields
  或 annotations；`TOOLSET_EPOCH` 保持 `2`，Gateway restart 后不执行 App Refresh/Scan Tools。

## 3. Release 决策表

### Patch release：tool contract 未变化

当 `name + input schema + annotations` 没有变化：

1. `gatewayBuild` 可以随新 commit/build 改变。
2. `toolsetEpoch` **保持不变**。
3. `toolsDigest` 应保持不变。
4. **不 Refresh App**，也不做无意义的 Scan/Refresh Tools。
5. 正常 restart/deploy Gateway，并用 `selfcheck` / `doctor` 核对 server identity。

这样避免把纯实现 patch 人为升级成 ChatGPT tool snapshot 变更。

### 正式 tool-contract release

只要 tool name、input schema 或 annotations 任一发生真实变化：

1. 在同一个变更中显式 bump `TOOLSET_EPOCH`。
2. 测试必须证明新的 `toolsDigest` 与旧 contract 不同，同时 `tools/list` 顺序稳定。
3. 完成 Gateway release/deploy 后，核对 `gatewayBuild / toolsetEpoch / toolsCount / toolsDigest`。
4. 在 ChatGPT App 侧执行 **Scan/Refresh Tools**；需要时执行 Refresh/Reconnect。
5. **新建聊天**，先执行 read probe：调用 `grande_task_status`（无参数即可）。
6. read probe 必须成功返回，并与 server-side 的 `toolsetEpoch / toolsCount / toolsDigest` 对得上，再继续写操作。

本次 onboarding release 的具体预期为：`toolsetEpoch=2`、`toolsCount=25`、`toolsDigest` 不等于 epoch-1 23-tool digest；新聊天 read probe 通过后，才开始使用 `grande_repo_add_propose`，并在 Human Owner 确认后调用 `grande_repo_add_apply`。

Production App 只在这种正式 tool-contract release 时更新工具 snapshot。

## 4. `Resource not found` / `tool disabled` 恢复流程

如果出现以下任一组合：

- App 显示 installed=true，但 permission status 类似 `not_installed`
- schema 能 discovery，但 invoke 报 `Resource not found`
- schema 能看到，但调用报 `tool disabled`
- Refresh/Reconnect 后旧聊天仍无法调用

按以下顺序处理：

1. 先跑 `selfcheck` / `doctor`。如果 Gateway reachable 且 server toolset identity 完整，记录 `gatewayBuild / toolsetEpoch / toolsCount / toolsDigest`。
2. 检查是否刚做过真实 tool-contract release；若没有，**不要为了“试试看”随意 bump epoch 或 Refresh App**。
3. **禁止绕过 Gateway merge**：不要因为 ChatGPT 当前 tool disabled 就改用手工 GitHub merge、raw git、另一条未受控执行路径或降低 `destructiveHint`。
4. **保留 task**：不要 close、删除 worktree 或丢弃当前任务上下文。
5. 在 ChatGPT App 执行 Refresh/Reconnect；若是 contract release，再执行 Scan/Refresh Tools。
6. 新建聊天，不依赖旧聊天恢复。
7. 在新聊天先运行只读 `grande_task_status` read probe；确认调用真正到达 Gateway，并核对 server identity。
8. 对已有任务调用 `grande_task_status(taskId)` 恢复上下文，再从正常 Golden Path resume。
9. merge 仍只能走原有 GrandeGPT Gateway / `grande_pr_merge` 门禁；本 runbook 不提供任何 bypass。

如果新聊天 read probe 仍失败，而 server-side `selfcheck` 正常，这仍属于 ChatGPT App/session binding 一侧的故障边界；继续处理 App binding，不修改 Gateway 安全策略来“适配”客户端异常。

## 5. GrandeGPT Dev 与 Production App

为避免开发期频繁 schema 变化污染稳定用户会话，ChatGPT App 必须分层：

- **GrandeGPT Dev**：只用于开发/验证新的 tool contract；指向 development/staging Gateway。开发期间可以频繁修改 schema、Scan/Refresh Tools，并用新聊天验证。
- **GrandeGPT Production App**：只指向稳定 production Gateway。普通实现 patch 不 Refresh；只有正式 tool-contract release 才更新 snapshot。

不要把 Production App 当成 schema playground。开发期的 tool definition 变化先在 GrandeGPT Dev 收敛；确定 contract、bump epoch、完成测试和 release 后，才把同一正式 contract 推给 Production App。

## 6. 发布前后检查

发布前：

- 确认是否真实改变 tool contract。
- 如果没有：确认 `TOOLSET_EPOCH` 没被改。
- 如果有：确认 epoch 已 bump，deterministic digest / tools-list 测试已通过。
- 本次 onboarding release：确认 production buildTools 精确为 25 tools、epoch 2，并且只新增 `grande_repo_add_propose` / `grande_repo_add_apply`。
- 运行 `unit-selfhost + typecheck`；涉及 selfhost 排除区域时，再运行 host `outer-test`。

### Release A 切换前 abort gate

切换代码前，必须先从 production `selfcheck` 捕获并保留当前
`gatewayBuild`、`toolsetEpoch`、`toolsCount`、`toolsDigest`，不得用 candidate 或历史值代填。
随后在**同一 production state** 上执行 candidate-on-production-state identity 计算，并逐项比较
candidate 与 production 的 `toolsetEpoch`、`toolsCount`、`toolsDigest`。三项必须精确相等，才允许按
epoch 2 / no-refresh patch 路径继续；`gatewayBuild` 可以因代码切换而变化。测试 fixture 的 digest
不能充当 production 放行值。任一项不一致，立即停止（abort）：先对账/reconcile production contract
与 candidate，或取得 owner 对正式 contract release 的明确授权；不得在快照已分叉时仍以 epoch 2
无刷新方式覆盖。

candidate-on-production-state 命令（在 candidate checkout 执行，仅读 production state DB）：

```bash
GRANDE_WORKSPACE=/Users/xtation/AgentWorks/GPT_Workspace \
node --disable-warning=ExperimentalWarning --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { loadLayout } from "./src/layout.ts";
import { buildTools, toolsetIdentity } from "./src/tools.ts";
const layout = loadLayout();
const db = new DatabaseSync(layout.stateDb, { readOnly: true });
try { console.log(JSON.stringify(toolsetIdentity(buildTools({ db, layout }), "candidate-predeploy"))); }
finally { db.close(); }
'
```

发布后：

- `selfcheck`：HTTP 200，toolsCount 正确，server identity 完整。
- `doctor --repo grande-gpt`：`Connector Compatibility` 中 Gateway reachable 与 Server toolset identity 可读。
- contract 未变：到此结束，不 Refresh App。
- contract 已变：Scan/Refresh Tools → 新聊天 → `grande_task_status` read probe → 再恢复写操作。
- onboarding release 的 read probe 必须看到 `toolsetEpoch=2`、`toolsCount=25` 与新的 `toolsDigest`；只有随后才对真实 repo 执行 propose/confirm/apply。

## 7. GG-BL-010 release-ready gate / Release A evidence

`GG-BL-010` 当前状态是 **P0 / MITIGATED**。server-controlled 风险已经通过 toolset identity、32 KiB result budget、bounded result、safe correlation telemetry 与兼容性 runbook 降低，但 ChatGPT conversation/App binding 的根因没有被 server-side 证明关闭。

### 7.1 目标客户端 capability 规则

Release gate 以**目标客户端当前真实 capability**为准，不能只根据通用平台文档推断，也不能因为历史上某客户端曾可用就永久要求它可用。

截至 2026-08-23，OpenAI Help Center 的 “Developer mode and MCP apps in ChatGPT” 页面写明 MCP apps 为 web only / mobile unavailable；但同日 Human Owner 在 ChatGPT iOS 原生客户端的当前会话中可以真实调用 GrandeGPT direct tools。两者存在 rollout / account / product-path 层面的事实冲突。

因此本项目采用以下规则：

- 当前 iOS 已有真实 GrandeGPT capability，所以**本轮 formal gate 仍包含 iOS**；
- 若未来某个目标客户端在 gate 开始前已经不再暴露 GrandeGPT/custom MCP capability，记录客户端版本、时间与 capability absence，并由 backlog 明确 rebaseline；不得把一个产品侧不可达路径变成永久无法满足的 hard gate；
- 反过来，也不得仅凭平台文档写“不支持”就跳过一个当前实际可调用的 release target；
- 平台文档只作为 observation，真实 target-client probe 才决定该客户端是否进入 formal matrix。

### 7.2 Formal matrix：同一会话连续两任务

当前 formal matrix 固定为三次独立运行：

1. **C-Web-1**：fresh ChatGPT Web conversation；
2. **C-iOS**：当前明确可调用 GrandeGPT 的 ChatGPT iOS 客户端 fresh conversation；
3. **C-Web-2**：第二个 fresh ChatGPT Web conversation，用于排除单一 Web session 偶然性。

每次运行都在**同一个 conversation 内连续完成 Task A 与 Task B**。Task A 完成后 Task B 必须在 5 分钟内开始；两任务之间不得 reconnect、Refresh/Scan Tools、重建 App、重启 Gateway、切换 toolset identity 或人为加入长 idle。

Task A / Task B 应使用两个 disposable development tasks，覆盖真实 inspect、分页/line-range read、至少两次 edit、failing→passing verification、最终 status/read；至少一个真实 async job 应通过稳定 `jobId` 路径最终只调用一次外部 `grande_run_result` 取得终态。无需为了增加调用数制造无意义操作。

**每次 formal run 的 hard pass criteria：**

- zero `The GrandeGPT tool has been disabled` / `Resource not found`；
- 每个真正由 ChatGPT 派发并抵达 server 的调用都有可对账的 `/mcp → [rpc] tools/call → [tool]` 证据；
- 无 unexpected 401、Gateway restart 或 toolset identity change；
- Task A / Task B 各不超过 50 次外部 GrandeGPT 调用；
- 两任务 serialized MCP result 合计不超过 1 MiB；
- 单个 result 不超过 32 KiB；
- 最终 Task B 的 `grande_task_status` 与 `grande_repo_read` 仍成功；
- 运行前后记录 `gatewayBuild / toolsetEpoch / toolsCount / toolsDigest`，其中 epoch/count/digest 必须稳定。

这些 50 calls / 1 MiB / 32 KiB 是**验收预算**，不是对 ChatGPT 平台隐藏配额的推断。禁止建立“达到 magic call count 就应该失败”的测试。

**2026-08-23 formal matrix result: 3/3 PASS (`C-Web-1 + C-iOS + C-Web-2`)。** 这只完成 §7.2；`GG-BL-010` 仍保持 `MITIGATED`，并进入 §7.3 的 7-day ordinary-use observation。

### 7.3 7-day observation 与关闭条件

Formal matrix 三次全部通过后，`GG-BL-010` 仍保持 `MITIGATED`，进入 7 天 ordinary-use observation：

- 至少 5 个普通 conversation；
- 每个 conversation 完成至少 2 个真实用户任务；
- Web 必须覆盖；当前 iOS 因为已确认属于实际 release target，也必须在观察窗口中覆盖；若窗口开始前 capability 已消失，按 7.1 记录并 rebaseline；
- 只保留 redacted summary：conversation correlation、成功调用数、累计 input/output bytes、tool distribution、401/auth failure、Gateway restart、pre-Gateway disable report；不保存内容正文或 token；
- 7 天内没有 unexplained disablement，且 formal matrix / frozen tool identity 仍成立，才可把 `GG-BL-010` 从 `MITIGATED` 转为 `DONE`。

### 7.4 再次复现时何时停止修改 server

如果在当前 frozen contract 与上述预算内再次出现 disablement，必须先分边界：

- 若请求到达 Gateway 并出现 401 / protocol / handler failure，诊断该具体 server boundary；
- 若 UI/agent 报 disabled，但失败调用**没有任何对应 `/mcp` 请求到达 Gateway**，同时 Gateway health 正常、无 401、无 restart、`gatewayBuild / epoch / count / digest` 未变化，则记录为 `pre-Gateway binding failure`。

当出现**两个独立、当前 epoch、证据完整**的 `pre-Gateway binding failure` 样本，并且都满足上述 frozen identity / under-budget 条件时，不再通过继续压缩 Gateway payload、降低 annotations、改 OAuth 或改变 tools/list 进行试探。此时 `GG-BL-010` 应转为：

`BLOCKED — ChatGPT platform/session binding boundary`

证据至少包含：时间、client/platform/model、App/tool count、server build/epoch/digest、最后成功 correlation、失败调用未到 Gateway 的日志窗口、401/restart=0，以及最小复现步骤。

### 7.5 Release A baseline / candidate 证据表

Release A 只组合历史 Tasks 1–5：Gateway 边界遥测、单份 canonical tool result、有界
`grande_run_result` 等待，以及 repo read/search 输出预算。它不改变 tool name、input schema
或 annotations，所以 `toolsetEpoch` 必须保持 `2`，`toolsDigest` 必须保持不变。这个 patch
release 不重建 App，也不执行 App Refresh / Scan Tools；部署和 Gateway restart 只能走现有受保护
流程，并由获授权的操作者另行执行。

下表是 Release A 的统一证据账本。历史资料没有记录的字段明确写“未记录”，不能倒推；三次 formal candidate 已在 2026-08-23 完成并按实际 telemetry 回填。
`任务 A/B calls / bytes` 中的 bytes 只有一个定义：实际交付的完整 MCP result
对象 `JSON.stringify(toMcpTextResult(envelope))` 的 UTF-8 字节数，包含外层 JSON
对 text 内容做的转义；不得改记 inner logical envelope 大小。对于绕过 GrandeGPT
encoder、由 SDK-generated error result 完成的拒绝，除非从实际 response 量到完整
result，否则记 `outputBytes=unknown`，绝不记 `0`。correlation 只记录 Gateway 生成的
安全相关值，不能从客户端会话或其他标识猜测。

| 证据 | 平台 | ChatGPT model | App version / tool count | Gateway build | toolset epoch / digest | 任务 A calls / bytes | 任务 B calls / bytes | disabled timestamp | 最后匹配的 Gateway correlation | 401 / restart |
|---|---|---|---|---|---|---|---|---|---|---|
| Baseline B-89（失败样本） | 未记录 | 未记录 | installed/enabled；精确 version/count 未记录 | 未记录 | 未记录 | 76 / bytes 未保留 | 13 / bytes 未保留 | 未记录 | disabled 调用未到 Gateway；此前最后一个精确 correlation 未保留 | 未观察到 401 或 restart |
| Baseline B-256（独立失败样本） | 未记录 | 未记录 | 精确 version/count 未记录 | 未记录 | 未记录 | 未按任务拆分；累计 256 calls / bytes 未保留 | 未按任务拆分 | 未记录 | 第 257 次 disabled 调用未到 Gateway；此前最后一个精确 correlation 未保留 | 未观察到 401 或 restart |
| Candidate C-Web-1 — **PASS** | fresh ChatGPT Web | GPT-5.6 Sol | App version 未观察；tool count 25 | `git:1b9c620267137ac0af641b323c33183d3bdb13e0` | `2` / `sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815` | 16 / 50,835 B | 14 / 37,837 B | none observed | `none` | 0 / 0 |
| Candidate C-iOS — **PASS** | ChatGPT iOS native | GPT-5.6 Sol | `1.2026.224` / tool count 未观察 | `git:1b9c620267137ac0af641b323c33183d3bdb13e0` | `2` / `sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815` | 16 / 38,625 B | 20 / 47,637 B | none observed | `none` | 0 / 0 |
| Candidate C-Web-2 — **PASS** | second fresh ChatGPT Web | GPT-5.6 Sol | App version / client-visible tool count 未观察 | `git:1b9c620267137ac0af641b323c33183d3bdb13e0` | `2` / `sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815` | 16 / 46,776 B | 14 / 22,897 B | none observed | `none` | 0 / 0 |

C-Web-2 的完整 35-call window（含 3 个 preflight 与最终 2 个 probes）为 99,830 B，最大单 result 18,928 B；Task A → Task B 间隔 10.747 秒。最初 Host reconciliation 把最终 `grande_repo_read` 误报为 `MISSING`，原因是脚本错误假定 `POST /mcp` 出现在 `[tool]` 之后。Human Owner 随后提供 exact Host slice，确认真实日志顺序为 `[rpc] 12:25:37.827 → [gw] 12:25:37.828 POST /mcp → 200 → [tool] 12:25:37.830 grande_repo_read ... result=ok outputBytes=3650`，因此最后 boundary 已闭合。

截至 2026-08-23，§7.2 formal matrix 已 **3/3 PASS**。本地行为回归仍覆盖真实 built handlers 产生的 `repo_read`、`repo_search`、`run_result` 与 error envelopes，并通过 canonical `toMcpTextResult` 计算完整编码大小；exact candidate host boundary tests 在 code commit `7b98f7dce2f0b10723b29be64ca28e1438f1a779` 为 5 files / 160 tests PASS。`GG-BL-010` 当前准确状态仍为 **MITIGATED**；剩余关闭条件是 §7.3 的 7-day ordinary-use observation，而不是新的 formal matrix run。
