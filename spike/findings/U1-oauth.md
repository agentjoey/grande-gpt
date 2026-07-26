# U1 · OAuth 2.1 + PKCE 与 ChatGPT 的握手 —— 结论：**PASS**

**日期** 2026-07-26 · **端点** `https://grande.agentjoey.ai/mcp/grande-gpt`
**接入** Cloudflare 隧道 `grande-gpt` → 本机 `127.0.0.1:8787`（规格 D16/D17）
**客户端** ChatGPT 网页版 developer-mode app，Authentication = OAuth

---

## 结论

**PASS。** ChatGPT 完整走通 DCR → authorize → token → 认证后调用工具，
返回 `{ok: true, pong: true, repoId: "grande-gpt"}`。

**并且 D5「每 repo 一个端点、令牌 `aud` 绑定端点」在 ChatGPT 侧端到端坐实** ——
它在 `/authorize` 与 `/token` 两处都携带了 `resource`，签发的令牌 `aud` 精确等于
该端点 URL。每-repo 隔离是协议层强制的边界，不是命名约定。

---

## 四项观察

### ① 注册方式：DCR，不是 CIMD

ChatGPT 先检查 CIMD，UI 明确提示 *"CIMD is unavailable because the server did not
advertise CIMD support"*，随后退回 DCR。实际注册请求体：

```json
{
  "client_name": "ChatGPT",
  "redirect_uris": ["https://chatgpt.com/connector/oauth/<opaque>"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

官方文档说 CIMD 是**更受推荐**的方式。S0 若想避免每次连接都动态注册一个新 client，
可在 AS 元数据加 `"client_id_metadata_document_supported": true`。**本轮未验证 CIMD 路径。**

### ② 发现顺序：先撞 401，再顺 `WWW-Authenticate` 找元数据

```
POST /mcp/grande-gpt                                    → 401（无 Bearer）
GET  /.well-known/oauth-protected-resource/mcp/grande-gpt   ← 顺着响应头找过来
POST /mcp/grande-gpt                                    → 已认证，200
```

两个推论：

- **`WWW-Authenticate: Bearer resource_metadata="..."` 是承重的。** 缺失或写错，
  握手根本起不来。S0 实现时这是必须有测试覆盖的一条。
- ChatGPT 用的是**每-repo 那份**元数据（`/.well-known/oauth-protected-resource/mcp/<repoId>`），
  不是根路径那份。根路径那份因为没有 repoId 可用而固定指向默认 repo，属观察性质、
  非权威 —— 实测证明 ChatGPT 不依赖它。

### ③ PKCE：ChatGPT 主动发 S256

`/authorize` 与 `/token` 的实际参数：

```
code_challenge_method : "S256"
code_challenge        : <43 字符 base64url>
code_verifier         : <64 字符>（token 交换时）
```

无需强制，ChatGPT 自己就发。我们服务端的**无条件** PKCE 校验（修掉了参考代码里
`rec.challenge && ...` 那个「客户端不传 challenge 就跳过校验」的绕过）与之相容。

### ④ `aud` 精确绑定端点 —— D5 成立

```
/authorize ← resource: "https://grande.agentjoey.ai/mcp/grande-gpt"
             scope:    "grande:repo:grande-gpt"
/token     ← resource: "https://grande.agentjoey.ai/mcp/grande-gpt"
/token     → aud:      "https://grande.agentjoey.ai/mcp/grande-gpt"
/mcp       ← 校验通过，sub=spike-user, aud 匹配本端点
```

ChatGPT 从 UI 的 **Resource** 字段（由每-repo 元数据自动发现）取值并全程携带。
配套地，用 `grande-gpt` 的令牌打其他端点会被 JWT 校验拒绝
（上一轮以 `demo-app` / `other-repo` 实测过：401 `JWTClaimValidationFailed`）。

---

## ⚠️ 实测发现的真问题：refresh_token 缺口

| | |
|---|---|
| ChatGPT 注册时请求 | `grant_types: ["authorization_code", "refresh_token"]` |
| 我们 AS 元数据声明 | `grant_types_supported: ["authorization_code"]` |
| 我们实际签发 | 仅 access_token，**1 小时过期，无 refresh token** |

**后果：令牌过期后 ChatGPT 没有续期路径，连接断开，用户必须重新授权。**
一小时一次，不可接受。

**次生问题**：我们的 `/register` **默默接受**了这个包含 `refresh_token` 的注册请求，
没有按 RFC 7591 回退成实际支持的子集并在响应中如实告知。ChatGPT 因此以为可以续期。

**这条只有真跑握手才能发现** —— curl 自测全绿、静态检查也发现不了，因为它不是错误，
是**双方对能力的理解不一致**。这正是 U1 存在的理由。

### 对 S0 的要求

1. **必须实现 refresh_token**（授权码流 + `refresh_token` grant），并在 AS 元数据
   如实声明 `grant_types_supported`。
2. `/register` 应按 RFC 7591 校验并回传实际支持的 `grant_types`，而不是照单全收。
3. access_token 的有效期与 refresh 策略需明确 —— 单用户场景下可放宽 access_token
   寿命，但不能靠「长期不过期」来回避 refresh。

---

## 未覆盖

| # | 未验证 | 何时需要 |
|---|---|---|
| 1 | **CIMD 路径** —— 本轮走的是 DCR | 若 S0 不希望每次连接动态注册新 client |
| 2 | **令牌过期后的实际行为** —— 未等满 1 小时观察 ChatGPT 如何反应 | 实现 refresh 前应先观察一次，确认失败形态 |
| 3 | **多 repo 并存时 ChatGPT 的行为** —— 目前只注册了 `grande-gpt` 一个 | 第二个仓库进入 workspace 时 |
| 4 | 移动端的 OAuth 流程 | P-6 已证明 iOS 可读写，但那是 No Auth 时期；OAuth 下未测 |

---

## 本轮建立的资产

- `spike/oauth/server.ts` —— OAuth AS + 每-repo 受保护 MCP 端点，公网实测通过。
  **它是 S0-D 认证层的直接原型**，不再是一次性 spike 代码。
- Cloudflare 隧道 `grande-gpt` → `grande.agentjoey.ai`（规格 D17），production 命名。
- ChatGPT 侧的 developer-mode app「GrandeGPT」已配置并授权成功。
