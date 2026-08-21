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

## 7. Release A baseline / candidate 证据表

Release A 只组合 Tasks 1–5：Gateway 边界遥测、单份 canonical tool result、有界
`grande_run_result` 等待，以及 repo read/search 输出预算。它不改变 tool name、input schema
或 annotations，所以 `toolsetEpoch` 必须保持 `2`，`toolsDigest` 必须保持不变。这个 patch
release 不重建 App，也不执行 App Refresh / Scan Tools；部署和 Gateway restart 只能走现有受保护
流程，并由获授权的操作者另行执行。

下表是 Release A 的统一证据账本：历史资料没有记录的字段明确写“未记录”，不能倒推；
candidate 行在真实 Web/iOS 门禁完成前明确保持“等待外部门禁”，不能用本地自动测试代填。
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
| Candidate C-Web-1 | ChatGPT Web，等待外部门禁 | 等待运行时记录 | 等待运行时记录 version / count | 等待受保护部署后 `selfcheck` | 必须为 `2` / 等待 `selfcheck` 精确 digest | 等待 Task A 实测 | 等待 Task B 实测 | 等待时间窗核对；无禁用则记 `none observed` | 等待逐调用 `/mcp → [rpc] → [tool]` 对账 | 等待日志核对；任务间必须 0 restart |
| Candidate C-iOS | 当前 iOS App，等待外部门禁 | 等待运行时记录 | 等待运行时记录 version / count | 等待受保护部署后 `selfcheck` | 必须为 `2` / 等待 `selfcheck` 精确 digest | 等待 Task A 实测 | 等待 Task B 实测 | 等待时间窗核对；无禁用则记 `none observed` | 等待逐调用 `/mcp → [rpc] → [tool]` 对账 | 等待日志核对；任务间必须 0 restart |
| Candidate C-Web-2 | 第二个 fresh Web conversation，等待外部门禁 | 等待运行时记录 | 等待运行时记录 version / count | 等待受保护部署后 `selfcheck` | 必须为 `2` / 等待 `selfcheck` 精确 digest | 等待 Task A 实测 | 等待 Task B 实测 | 等待时间窗核对；无禁用则记 `none observed` | 等待逐调用 `/mcp → [rpc] → [tool]` 对账 | 等待日志核对；任务间必须 0 restart |

每次 candidate 运行必须同时保留起止时间和以下判定：Task A、Task B 各不超过 50 次外部
GrandeGPT 调用；两任务 serialized result 合计不超过 1 MiB；单个结果不超过 32 KiB；至少一个
真实 job 只用一次外部 `grande_run_result` 取得终态。这里的 50 次、1 MiB、32 KiB 是 Release A
验收上限，不是 ChatGPT 平台的推断配额，也不能让测试依赖“累计到某个 magic call count 就失败”。
部署后的 `gatewayBuild / toolsetEpoch / toolsCount / toolsDigest` 必须在每次运行前后分别由
`selfcheck` 记录；任一身份变化、意外 401、Gateway restart 或 pre-Gateway disablement 都按真实
边界记录，不得改写成应用 handler 失败。

截至 2026-08-21，本地行为回归已经覆盖真实 built handlers 产生的 `repo_read`、`repo_search`、
`run_result` 与 error envelopes，再走 canonical `toMcpTextResult` 计算完整编码大小。
exact candidate host boundary tests 已在 code commit
`7b98f7dce2f0b10723b29be64ca28e1438f1a779` 通过：5 files / 160 tests。该绑定证据不等于
production activation；受保护部署/Gateway restart、部署后 `selfcheck`，以及三次 Web/iOS
真实验收仍是明确待完成的外部门禁。因此 `GG-BL-010` 保持 `OPEN`。
