# U1 · OAuth 2.1 + PKCE 握手 —— 结论：**刻意未验证**（S0 不需要）

**日期** 2026-07-26 · **状态**：服务端已实现并本地验证通过，但**未与 ChatGPT 做握手实测**。

---

## 为什么不做

U1 原本的立项理由是规格里的一句话：

> 即使单用户，这套协议表面也**不能跳过** —— 它是 ChatGPT 建立连接的硬性前置条件。

**那句是错的，而且我们自己的 POC 早已证伪它** —— POC 全程使用 **No Authentication**，
完整跑通 40 次工具调用、跨 5 条消息 44 分钟。OAuth 从来不是连接的前置条件。

叠加 D13（S0 改用 Secure MCP Tunnel）之后：

| | Server URL 模式 | Tunnel 模式（S0 采用） |
|---|---|---|
| 端点是否公网可达 | 是 | **否** |
| 谁能触达 | 任何知道 URL 的人 | 只有绑定用户 org 的 OpenAI 中继 |
| OAuth 的边际价值 | 高 —— 它是唯一的门 | **低** —— 隧道本身即是门 |

OAuth 实际提供的是**按用户身份、令牌过期、scope 强制**三项，而 S0 是**严格单用户**（D2）。
三项在单用户 + 私有隧道下都不适用。

**Human Owner 决定：S0 = Tunnel + No Auth，不实现 OAuth（D15）。**

---

## ⚠️ 这个决定的连带后果（不要丢掉）

**它把 U3（Tunnel 可用性与延迟）从可选变成了前置条件。**

POC 能用 No Auth + 公网 URL，是因为它只提供**假数据**。S0 在**真实仓库上执行真实代码** ——
同样的组合放到 S0 就是「公网上一个无认证的代码执行端点」。

**No Auth 只在 Tunnel 成立时才可接受。** 若 U3 证明 Tunnel 不可用或过慢、S0 退回
Server URL 模式，则 OAuth 重新成为必需，D15 作废，本文档的结论需重新评估。

---

## 已经做了什么（未浪费，可直接复用）

`spike/oauth/server.ts` 已实现并**经 curl 端到端验证通过**：

- 两份发现文档格式正确：`/.well-known/oauth-protected-resource`（含 `resource` /
  `authorization_servers` / `scopes_supported`）与 `/.well-known/oauth-authorization-server`
  （含 `authorization_endpoint` / `token_endpoint` / `registration_endpoint` / `jwks_uri` /
  `code_challenge_methods_supported: ["S256"]`）
- 未认证访问 `/mcp` 返回 **401 + `WWW-Authenticate: Bearer resource_metadata="..."`**
- 完整流程走通：`/register` → `/authorize`（真实 S256 challenge）→ `/token`（匹配的 verifier）
  → 带 Bearer 的 `/mcp` → `tools/list` 显示 `spike_ping` → 调用返回 `pong`
- 负向测试：**PKCE verifier 不匹配被拒**（`invalid_grant` / "PKCE mismatch"）；
  已消费的 code 无法重放；四种伪造 token 全部被拒且错误原因可区分
  （`JWTClaimValidationFailed` / `JWTExpired` / `JWSSignatureVerificationFailed`）
- JWT 的 `aud` 确认等于资源标识

实现过程中发现并修掉了计划参考代码里的一个**真实绕过**：原写法 `rec.challenge && ...`
在客户端不传 `code_challenge` 时会**静默跳过整个 PKCE 校验**。已改为无条件强制，
并补了负向测试。

**因此残留未知是窄的**：不是「我们的 AS 能不能用」（已证明能），
而是「**ChatGPT 的 OAuth 客户端能否与之握手**」——尤其是它走 DCR 还是 CIMD、
以及它是否正确回传 `aud`（这条关系到规格 D5「每 repo 一个端点、`aud` 绑定端点」
能否落地）。

---

## 若将来需要重启 U1

代码在 git 历史里（提交 `33b9bd7`）。重跑只需：

1. `cd spike && OAUTH_SECRET=<随机> ISSUER=https://<域名> PORT=8788 node oauth/server.ts`
2. 把 `<域名>` 加进某条 cloudflared 隧道的 ingress 并建 DNS 记录
3. ChatGPT → Settings → Plugins → **+** → Server URL 填 `https://<域名>/mcp`，
   Authentication 选 **OAuth**
4. 观察服务端日志：ChatGPT 打了哪些端点、顺序如何、`code_challenge_method` 实际取值、
   `/register` 是否被调用（DCR vs CIMD）、令牌 `aud` 的实际取值

本轮建立的临时基础设施已拆除：服务已停、`oauth-spike.agentjoey.ai` 已从 ingress 摘除
（返回 404）、`oauth/.env` 已删。**Cloudflare 面板里那条 CNAME 记录需手动删除** ——
`cloudflared` 不提供删除 DNS 记录的子命令。
