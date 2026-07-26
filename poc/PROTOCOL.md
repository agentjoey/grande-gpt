# POC 执行协议

> 严格按本文操作。**每一步都要记下你何时打了字** —— 这是判定 P-1 的另一半证据。
> 日志只能证明"调用发生了"，证明不了"是模型自主还是你催的"。两份证据必须互相印证。
>
> **全程手动操作。禁止任何脚本化或无人值守驱动 ChatGPT**（规格 §2.3 合规红线）。

---

## 0. 一次性准备

### 0.1 起服务与隧道

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt/poc
set -a && . ./.env && set +a && node src/server.ts
```

另开一个终端：

```bash
cloudflared tunnel --config ~/.cloudflared/grande-poc.yml run
```

验证公网可达（应返回 `ok`）：

```bash
curl -sS https://gg.agentjoey.ai/healthz
```

### 0.2 取得完整 MCP URL

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt/poc && echo "https://gg.agentjoey.ai/$(grep POC_SECRET .env | cut -d= -f2)/mcp/demo-app"
```

secret 只存在于 `poc/.env`（已 gitignore），**不要**把完整 URL 贴进任何会被提交的文件。

### 0.3 在 ChatGPT 中添加 app

> **别找「连接器」——它已经不叫这个了。** 命名改过三轮：connectors → apps（2025-12）
> → plugins（2026-07-09 目录与 Codex 合并时）。设置项现在叫 **Plugins**，
> UI 里这个东西的正式名称是 **developer-mode app**。

1. 网页版 → **Settings → Security and login** → 打开 **Developer mode**
   **← 不先开这个，第 2 步的菜单根本不会出现**
2. **Settings → Plugins**（或直接 `chatgpt.com/plugins`）→ **+** → 新建 developer-mode app
3. URL 填 §0.2 输出的完整地址
4. 认证方式选 **No Authentication**
5. 保存后确认工具列表显示 **9 个** `grande_*` 工具
   —— 新建的 app 初始存放在 **Drafts** 下，列表里没看到"已启用"是正常的

#### ⚠️ 每个对话都要单独启用一次

在对话输入框的 **「+」菜单 → Developer mode** 里勾上本 app。

**本协议要求每轮用全新对话，所以三轮你要各启用一次。** 忘了启用的症状是模型回你
「我没有这些工具」—— **那不是 P-1 FAIL，只是没启用，别记成实验结果。**

> 若添加这一步本身失败，把失败信息记进观察记录的「未覆盖项」—— 这本身就是 S0 必须解决的问题。

### 0.4 确认训练数据设置（规格 D12）

**Settings → Data Controls** → 确认「用我的内容改进模型」**已关闭**，把结果记进观察记录。

Plus/Free 消费者账号默认是**开启**的，而 POC 之后你的私有代码会流经对话。

---

## 1. 每轮执行

**每轮必须新建对话**，并在该对话中启用 `demo-app` 连接器。

每轮开始前重置状态：**停掉服务，用该轮专属的日志文件重启**（假仓库与 job 都在内存里，重启即清空）。

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt/poc
set -a && . ./.env && set +a
POC_LOG=./observe-round-1.jsonl node src/server.ts     # 第二、三轮改成 -round-2 / -round-3
```

> **不要删除上一轮的日志。** 原始日志才是 POC 的真交付物 —— 渲染出来的 markdown 是它的
> 派生物。万一之后发现报告生成器还有 bug，只有留着原始日志才能重新分析，否则三轮实测白跑。
> 每轮一个文件，也避免了多轮事件混进同一个日志里互相污染判定
> （`truncated` 的"已见过截断"状态会跨轮粘住，上一轮的 `TASK_NOT_FOUND` 也会算到下一轮头上）。

### 消息 1 —— 主循环（原样粘贴）

```
用 demo-app 这个仓库开一个开发任务，目标是「修复 parser 对空输入的处理」。
先看看代码结构，找到相关文件读一下，然后跑单元测试看看现在是什么情况。
```

**然后停手。一个字都不要再打。**

记录：

- [ ] 模型是否自己调用了 `grande_task_open`
- [ ] 模型是否自己调用了 `grande_run`
- [ ] **模型是否在你没打字的情况下自己调用了 `grande_run_result`（← 这就是 P-1）**
- [ ] 它轮询了几次？
- [ ] 弹了几次确认框？分别是哪个工具？
- [ ] **你在此期间打字了吗？** 若打了，记下时刻与内容

> **若模型停下来问你「要我继续检查测试结果吗」之类的话 —— 这就是 P-1 FAIL 的直接证据。**
> 记下它的**原话**，然后回复「继续」让流程走下去。

测试跑 20 秒（`POC_JOB_DURATION_MS` 默认 20000）。第一次必然失败 —— `src/parser.ts` 有个真实缺陷：空输入返回 `[""]` 而非 `[]`。

### 消息 2 —— 修复循环

在模型报告测试失败之后：

```
修一下这个问题，然后重新跑测试确认通过。
```

再次停手，记录同样的项目。这次测试应当通过。

### 消息 3 —— 读取截断（测 P-5）

```
把 src/big-config.ts 完整读一遍，告诉我里面一共定义了多少个 key。
```

该文件约 89 KB，超过 64 KB 上限，响应会被标记 `truncated`。

- [ ] 模型是否**注意到**响应被截断
- [ ] 模型是否用 `lineRange` 继续读取
- [ ] 还是直接基于残缺内容给了个数字？（这是最危险的情况）

### 消息 4 —— 搜索截断与 taskId 保持（测 P-5 / P-3）

```
搜一下仓库里所有的 export const，看看有多少个。
```

命中 201 处，超过 50 条上限。

- [ ] 模型是否用 `cursor` 续读（现在带 cursor 会真的返回下一页，不再是摆设）
- [ ] 模型是否仍在使用**正确的 `taskId`**

### 消息 5 —— 压到 30 次调用（测 P-3）

规格 §9.1 的 P-3 判定标准是「连续 **30 次**工具调用后模型是否仍记得 `taskId`」，而前四条消息通常只到 15–25 次。用这条把深度压上去：

```
把仓库里每个文件都完整读一遍，然后总结这个项目是干什么的、有哪些已知问题。
```

- [ ] 第 30 次调用时 `taskId` 是否仍然正确
- [ ] 有没有出现 `TASK_NOT_FOUND`
- [ ] 有没有出现「参数校验失败」类的报错（模型漏传 `taskId` 时是这种形态，不是 `TASK_NOT_FOUND`）

> 报告里会打印总调用次数。**若不足 30 次，P-3 只能记「判定不充分」，不能记 PASS。**

---

## 1.5 P-6 · 移动端可用性（只需做一次，约 10 分钟）

这一项验证的是整个项目**最主要的立项理由** —— 规格 §13.3 把「从移动端驱动本机开发」列为
Codex CLI 与 Claude Code 给不了的唯一结构性差异化。它值得单独花十分钟测准。

**背景**：官方 developer mode 文档只写「on the web」，全文未提移动端；二手来源报告
「MCP write actions are currently disabled on mobile devices」（只读可用）。**两者都不足以定论**，
所以要实测。

在网页版把连接器配好之后，拿 iOS app 新建一个对话，依次记录：

- [ ] **连接器是否出现在可选列表里？** 不出现 → 结论立即明确，后面几步不用做了
- [ ] 若出现，先调只读工具：`看一下 demo-app 的目录结构`（触发 `grande_repo_map`）
      → 成功 / 失败？
- [ ] **再调写工具：`在 demo-app 上开个任务，目标是修复空输入处理`**（触发 `grande_task_open`）
      → **这一步的结果就是答案**
- [ ] 写工具的表现属于哪一种：
      - 正常执行（移动端不限制写）
      - 弹出确认框、确认后执行（限制的是"自动执行"而非"写"本身）
      - 被拒绝 —— **记下报错原话**
      - 工具压根没被模型选中（可能被客户端从工具列表里隐藏了）
- [ ] 若写工具可用，继续试 `grande_run` 与 `grande_run_result`：**测试能不能在手机上跑起来并轮询**
- [ ] 确认框在移动端的形态与网页版是否一致？"记住"选项还在吗？

**服务端不用改任何东西。** 观测日志会自动记下这些调用，`remoteUa` 字段能区分手机与网页来源
（报告里有 UA 分布表）。跑完照常生成报告即可。

> **判定口径**：只读通、写被拒 ⇒ 移动端只能做审阅与监控，规格 §13.3 的价值①需要降级重写。
> 读写都通 ⇒ 价值①成立，是项目最硬的立项理由。

---

## 2. 每轮结束后

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt/poc
POC_LOG=./observe-round-1.jsonl node scripts/report.ts > ../docs/research/poc-round-1.md
```

（第二、三轮改成对应的 `-round-2` / `-round-3`）

然后把手工观察项补进生成的报告。报告里有三处**必须由你填**，生成器填不了：

| 项 | 为什么机器填不了 |
|---|---|
| **P-1 的「执行者未打字」确认** | 日志只能证明调用发生了，证不了是模型自主还是你催的。**P-1 的 PASS 带「待人工确认」后缀，你不签字它就不算数。** |
| P-2 额度消耗 | ChatGPT 不暴露 |
| P-4 确认框次数 | ChatGPT 不暴露 |

---

## 3. 额度记录（P-2）

每轮**开始前**与**结束后**各记一次：

| 项 | 轮次开始 | 轮次结束 |
|---|---|---|
| 使用的模型（Sol / Terra / Luna） | | |
| 是否出现额度提示 | | |
| 剩余额度（若界面可见） | | |

如果可能，**至少一轮用 Sol、一轮用 Terra** —— 不同模型层级的工具遵循度可能差别很大，而这直接影响规格 §19.2 的模型分工建议。

---

## 4. 三轮跑完

汇总成 `docs/research/2026-07-26-poc-observation.md`，必须含：

- **结论：S0 go / no-go**（一句话）
- P-1～P-5 逐项判定 + 证据
- **未覆盖项** —— 至少要写上：OAuth 2.1 + PKCE 握手未验证（POC 用的是 No Authentication），S0 第一周必须单独验证，该项失败会阻塞 S0
- 对规格的修订建议

**P-1 是硬门禁。** 不通过则暂停项目、重新设计交互模型，不得直接进入 S0。
不通过时第一件要试的事：把 `poc/.env` 加一行 `POC_HINT_LANG=en`，重启服务，重跑一轮 —— 模型对英文指令的遵循度可能更高。

---

## 附：环境速查

| 项 | 值 |
|---|---|
| 服务端口 | `8787` |
| 公网入口 | `https://gg.agentjoey.ai` |
| 健康检查 | `https://gg.agentjoey.ai/healthz` → `ok` |
| MCP 路径 | `/<POC_SECRET>/mcp/demo-app` |
| 隧道配置 | `~/.cloudflared/grande-poc.yml`（专用隧道，不影响 home-mac 上的 SSH/VNC/ocrc/pactify） |
| 观测日志 | `poc/observe-round-<N>.jsonl`（gitignore；**每轮一个文件，跑完不要删**） |
| 报告生成 | `POC_LOG=./observe-round-<N>.jsonl node scripts/report.ts` |
| 假仓库文件 | `package.json` · `README.md` · `src/parser.ts` · `src/generated-constants.ts` · `src/big-config.ts` · `tests/parser.test.ts` |
| 可用 profile | `unit` · `lint` · `typecheck`（只有这三个；传别的会返回 `PROFILE_NOT_FOUND`） |
