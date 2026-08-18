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

Gateway 通过现有 `grande_task_status` 暴露以下字段，不新增 MCP tool：

- `gatewayBuild`：优先使用显式 `GRANDE_GATEWAY_BUILD`；否则为运行 checkout 的 `git:<40-char HEAD>`；没有 Git metadata 时才退化为 `dev`。
- `toolsetEpoch`：ChatGPT tool-contract compatibility epoch。**只有 tool contract 改变时才递增。**
- `toolsCount`：当前工具数；当前 Phase 5 基线为 23。
- `toolsDigest`：`sha256:` digest，只覆盖稳定排序后的 tool `name + input schema + annotations`。

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
- 运行 `unit-selfhost + typecheck`；涉及 selfhost 排除区域时，再运行 host `outer-test`。

发布后：

- `selfcheck`：HTTP 200，toolsCount 正确，server identity 完整。
- `doctor --repo grande-gpt`：`Connector Compatibility` 中 Gateway reachable 与 Server toolset identity 可读。
- contract 未变：到此结束，不 Refresh App。
- contract 已变：Scan/Refresh Tools → 新聊天 → `grande_task_status` read probe → 再恢复写操作。
