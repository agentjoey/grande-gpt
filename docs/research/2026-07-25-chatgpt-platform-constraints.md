# ChatGPT 平台约束调研

**调研日期**：2026-07-25
**目的**：确定 GrandeGPT 可依赖的官方能力边界，校正 `Chat-Dev-Control-Plane-方案B-设计文档.docx`（v0.9）中基于早期信息的假设。

> **可信度标注**：本文区分「官方文档」与「社区报告」。社区报告的项目在实现时必须实测复核，不得直接当作契约。

---

## 1. 套餐可用性 —— 对草案的重要校正

草案 §16 称"具备写入/修改能力的完整 MCP 应用目前面向 Business、Enterprise 和 Edu 的网页版"。

**官方 Developer mode 文档的实际表述**：developer mode 提供 *full Model Context Protocol (MCP)
client support for all tools, both read and write*，可用于 **Pro、Plus、Business、Enterprise、
Education** 账号的**网页版**。

旧的"只读"限制针对的是 Deep Research connectors 那条通道（仅 search/fetch），不是 developer mode。

**结论**：个人 Plus/Pro 账号即可跑通全链路，不必先解决企业版工作空间。
**行动项**：上线前用实际账号验证一次，不要仅凭文档。

来源：[Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)

---

## 2. 工具调用超时 ~60 秒（社区报告，不可配置）

多方社区报告一致指向 ChatGPT 侧 MCP 工具调用超过约 60 秒即失败（504 / 500）。**官方文档未给出明确数值**，也未提供配置项。

**架构影响（最硬的一条约束）**：

- 只有耗时操作走异步：立即返回 `jobId`，由模型轮询
- 响应中带 `pollAfterSeconds` 与 `hint`，主动提示模型继续轮询而不是放弃或臆断完成
- 其余所有工具必须在远低于 60s 内返回
- 两个易被忽略的陷阱：`task_open` 里的 `git fetch`（大仓库可能几十秒）、`repo_search`
  在大仓库上无时间预算

MCP 生态正在推进 Tasks 扩展（服务端返回异步 task handle 由客户端驱动生命周期），但在 ChatGPT
落地前不能依赖，仍用 jobId 轮询。

来源：[Handling long-running tasks](https://community.openai.com/t/handling-long-running-tasks-in-chatgpt-apps/1369488) ·
[长调用超时讨论](https://community.openai.com/t/how-to-configure-long-mcp-tool-call-times-for-chatgpt-app/1379834)

---

## 3. 响应大小与截断（社区报告）

- 工具描述约 **5,000 token 上限**
- 响应过大会被截断；**过大的响应有时表现为超时**，根因却是数据量

**架构影响**：**截断必须由我们主动执行并显式告知**。ChatGPT 侧的静默截断会让模型在残缺数据上继续
推理且毫不知情 —— 这是最隐蔽的失败模式。所有工具返回 `truncated: boolean` 与 `nextCursor`。

来源：[响应截断报告](https://community.openai.com/t/tool-response-truncation-on-mcp-connector-responses-that-previously-worked/1383071)

---

## 4. 写操作确认流（官方）

ChatGPT 依据 `readOnlyHint` 注解判定读/写：**没有该注解的工具一律按写操作处理并弹出确认框**。
用户可查看 JSON payload、展开输入输出细节后批准，并可在**当前会话内**"记住"某工具的批准或拒绝；
**新会话重置**。

官方要求三个注解都如实标注：

| 注解 | 何时为 true |
|---|---|
| `readOnlyHint` | 仅当操作不改变任何状态 |
| `destructiveHint` | 结果不可逆或难以逆转 |
| `openWorldHint` | 影响公共或外部系统 |

**架构影响**：写工具做**粗粒度**（一次调用改多个文件），把确认框数量压到个位数。
但"会话内记住"意味着**不能仅依赖 ChatGPT 的 UI 确认**来防护不可逆操作 —— Gateway 自己的
一次性 Confirmation Challenge 在引入不可逆操作（push / PR / 删除）时仍然必要。

来源：[Developer mode](https://developers.openai.com/api/docs/guides/developer-mode) ·
[Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)

---

## 5. 传输与服务端形态（官方）

- **公网 HTTPS**，稳定 URL，惯例以 `/mcp` 结尾
- **Streamable HTTP** 传输（developer mode 亦支持 SSE，生产用 streamable HTTP）
- **服务端应无状态** —— 会话状态由我们自己按 `taskId` 持久化，这与"新会话用 task ID 恢复上下文"天然吻合
- 工具需提供明确的 input schema，返回结构化数据时提供 output schema
- 响应包含 `structuredContent`（模型可检视的精简数据）、`content`、`_meta`（对模型隐藏的客户端数据）

来源：[Build an MCP server](https://developers.openai.com/plugins/build/mcp-server) ·
[MCP 概念](https://developers.openai.com/apps-sdk/concepts/mcp-server)

---

## 6. 认证（官方）

必须实现 OAuth 2.1 authorization-code + **PKCE（S256，强制）**。

**必需的发现端点**：

| 端点 | 内容 |
|---|---|
| `GET /.well-known/oauth-protected-resource` | `resource`、`authorization_servers`、`scopes_supported` |
| `/.well-known/oauth-authorization-server` 或 `/.well-known/openid-configuration` | AS 元数据，含 `authorization_endpoint`、`token_endpoint`、`jwks_uri` |

**每次请求**都必须校验 token 签名、`iss`、`exp`/`nbf`、`aud`（须匹配资源标识）与所需 scope；
失败返回 `401` + `WWW-Authenticate`（指向 protected resource metadata）。

**客户端注册**：DCR 现在是**可选**；官方更推荐 **CIMD（Client ID Metadata Documents）**，
在 AS 元数据中声明 `"client_id_metadata_document_supported": true`。

工具级 `securitySchemes` 声明所需 scope；支持 `"noauth"` 类型的匿名工具。

**对本项目的影响**：即使是单用户，这套发现端点与校验也**不能跳过** —— 它是 ChatGPT 连接的硬性
前置条件。可简化的是后端（单 client、固定 scope、本地签发），不是协议表面。

来源：[Authentication](https://developers.openai.com/plugins/build/auth)

---

## 7. OpenAI 官方安全要求

三条基本原则：**最小权限**、**显式用户同意**、**纵深防御（假定恶意输入会到达你的服务端）**。

具体要求：

- 定期审查工具描述，避免诱导误用
- **服务端必须独立校验所有输入，不论其是否来自模型**
- **不可逆操作必须人工确认**
- QA 阶段用注入 prompt 测试
- 数据最小化：只包含当前任务必需的数据；不在组件属性里嵌入密钥；日志脱敏 PII
- 出站请求必须强制 TLS 校验、重试与超时

这与草案 §14.3 的方向一致，可直接采纳。

来源：[Security & privacy](https://developers.openai.com/plugins/guides/security-privacy)

---

## 8. Projects 与连接器的关系（部分未确认）

**已确认**：dev mode 连接器需**在每个对话里显式启用**，启用后在该对话内持续有效。

**未能确认**：Projects 是否支持按项目限定连接器。**不作为已知事实用于设计。**

**协议层事实（关键）**：**MCP 不会把 ChatGPT 的 Project 身份传给服务端。** Gateway 无从得知当前
对话属于哪个 Project。因此"一个 Project 对应一个 repo"若仅靠 Project 指令里写 `repoId`，
是**约定而非强制**。

**采用的对策**：每个 repo 一个 MCP 端点 `/mcp/<repoId>`，OAuth 令牌按端点签发并绑定 repoId。
隔离由协议层保证，且 `repoId` 不再作为工具参数（少一处模型可错点）。

---

## 9. 与 Codex 的关系

OpenAI 的应用目录自 2026-07-09 起在 ChatGPT 与 Codex 间共用。

**但 GrandeGPT 走 developer mode 自建连接器、不上架目录**，因此与 Codex 无任何关联。
符合项目约束 D7（不涉及 Codex，不读写 `~/.codex`）。

---

## 10. 待实测清单

以下项在 S0 实现期间必须实测确认，不得凭本文假设：

| # | 待验证 | 为什么重要 |
|---|---|---|
| 1 | 实际账号能否连接 developer mode 自建连接器并执行写操作 | 整个方案的前提 |
| 2 | 工具调用超时的真实数值 | 决定 `pollAfterSeconds` 与各工具延迟预算 |
| 3 | 响应多大开始被截断 | 决定各工具的字节/条数上限 |
| 4 | 确认框在"记住"后的实际行为与会话边界 | 决定 Gateway Challenge 的引入时机 |
| 5 | 九个工具下模型的选择准确率 | S0 的核心待验证问题：粒度是否合适 |
| 6 | 长对话中 `taskId` 的保持情况 | 决定 `taskContext` 回带策略是否足够 |
