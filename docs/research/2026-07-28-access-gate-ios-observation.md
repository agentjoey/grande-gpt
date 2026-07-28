# Cloudflare Access 门禁 · iOS 实测 —— 结论：**PASS**

**日期** 2026-07-28 · **端点** `https://grande.agentjoey.ai`
**Access 应用** 类型 Public DNS，范围**仅** `grande.agentjoey.ai/authorize*`
**团队** `agentjoey.cloudflareaccess.com` · **客户端** ChatGPT iOS app

---

## 为什么要做这次实测

S0-D 的计划审查发现：计划把 spike 的 `/authorize` 原样继承了下来，而 spike 那里
写着 `// ④ 授权端点：spike 直接同意，不做登录页`。**任何能访问该端点的人自带一个
PKCE verifier 就能换到合法令牌**，而该令牌可以驱动 `grande_repo_edit` 与
`grande_run` 在本机写文件、执行命令。PKCE 挡不住——攻击者自己就是发起流程的那一方。

方案定为 Cloudflare Access。但有一个只有真跑才知道的未知数：

> **ChatGPT 把用户送到 `/authorize` 时，那个浏览器上下文能否完成 Access 登录、
> 带住 cookie、再跳回来完成 OAuth？**

桌面浏览器几乎必然可以。**iOS 的应用内 webview 不一定**——它可能不共享 Safari 的
cookie，或拦住 Access 到 IdP 的跳转。而 P-6 已证明用户会在 iOS 上用这个系统。

不通的话要改的是 `authorization_endpoint` 的形态，而那是 S0-D Task 2 的地基。

---

## 结果

### ① Access 的路径范围正确（curl 实测）

| 路径 | 配 Access 前 | 配 Access 后 | |
|---|---|---|---|
| `/authorize` | 400（我们的服务） | **302 → Access 登录页** | ✅ 被拦 |
| `/token` | 404 | 404 | ✅ 放行 |
| `/register` | 404 | 404 | ✅ 放行 |
| `/.well-known/oauth-authorization-server` | 200 | 200 | ✅ 放行 |
| `/.well-known/oauth-protected-resource/mcp/grande-gpt` | 200 | 200 | ✅ 放行 |
| `/mcp/grande-gpt` | 401 | 401 | ✅ 放行 |

**只有 `/authorize` 被拦。** 其余四条是 OpenAI 后端的服务器对服务器调用，做不了
交互式登录——范围若填成整个 hostname，握手会死在发现阶段。

### ② iOS 应用内 webview 能穿过 Access —— 本次的核心结论

第一次尝试只产生了 `/mcp` 请求（用的是既有令牌，没有重新授权）。
在 ChatGPT 里断开重连后，服务端日志出现完整四段：

```
[oauth] /authorize ← {"response_type":"code","client_id":"client_015de7e4-…"}
[oauth] /authorize repo 绑定解析 { resource: 'https://grande.agentjoey.ai/mcp/grande-gpt',
                                   repoIdFromResource: 'grande-gpt',
                                   repoIdFromScope: 'grande-gpt' }
[oauth] /authorize → 签发 code，绑定 repoId { repoId: 'grande-gpt' }
[oauth] /token → 签发 access_token { aud: 'https://grande.agentjoey.ai/mcp/grande-gpt' }
[oauth:grande-gpt] /mcp ← 已认证请求
```

**`/authorize` 到达了我们的服务。** 而它此刻被 Access 保护着——请求能到，
就意味着 webview 完成了 Access 登录、拿到并带上了 cookie、然后跳了回来。

两种预想的失败形态（webview 不共享 Safari cookie、拦住到 IdP 的跳转）**都没有发生**。

### ③ `aud` 在 Access 介入后仍精确绑定端点

`aud = https://grande.agentjoey.ai/mcp/grande-gpt`，与 U1 一致。D5 的每-repo 隔离
不受 Access 影响。

---

## 意外收获：D5 在模型侧的行为验证

测试中问模型能否读取另一个仓库 `urbanbricks`，它答：

> 目前**不能**读取 urbanbricks……当前只暴露了连通性检查 `spike_ping`，没有文件
> 列表、搜索或读取代码的工具。需要先把 @GrandeGPT 的本地仓库端点**切换或注册到**
> urbanbricks，我才能读取它。

**它没有尝试把 `urbanbricks` 当参数传进去。** 因为工具 schema 里根本没有 `repoId`
这个入参——仓库由端点决定（D5）。模型自己推断出「要换端点」，而不是「试试传个参数」。

规格里写 D5「隔离由协议层强制，而非依赖模型自觉」时是设计推理，**现在有实测了**。

它同时准确说出当前只有 `spike_ping` 一个工具——对自己能力边界的判断是对的。

---

## 一个对 S0-D 实现有直接影响的观察

第一次回答里，模型列出了 `demo-app` 的文件清单（`src/parser.ts`、`tests/parser test.ts`
等）。**那是 POC 时期的虚构仓库，早已不存在**——它在从**对话历史**里回忆，而不是
从工具结果里读。第二次它自己纠正了。

这正是规格 §5.5 要求 `taskContext` **每个响应都回带**的理由：不这么做，模型会拿
旧上下文当现实。**S0-D Task 3 实现时这一条不能省。**

---

## 对 S0-D 的结论

- `authorization_endpoint` 保持公网 HTTPS 形态（`https://grande.agentjoey.ai/authorize`），
  由 Access 把守。**Task 2 的地基确定，最后一个阻断项解除。**
- 代码侧仍必须校验 `Cf-Access-Jwt-Assertion`（规格 §7.0⓪）：Access 是仪表盘配置，
  可被误删、改错范围、或整个绕过（直接暴露 8787）。**本次实测只证明 Cloudflare 那层
  能被 iOS 走通，不证明代码门禁能工作**——后者是 Task 2 Step 0 要写并要测的。

## 未覆盖

| # | 未验证 | 何时需要 |
|---|---|---|
| 1 | Access 会话过期后 ChatGPT 的行为 | 长期使用时 |
| 2 | 代码侧 `Cf-Access-Jwt-Assertion` 校验（本轮 spike 服务尚未实现） | Task 2 Step 0 |
| 3 | refresh_token 流程（spike 未实现，正是 S0-D 要补的） | Task 2 |
| 4 | 多 repo 并存时的端点切换体验 | 第二个仓库注册时 |
