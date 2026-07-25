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

### 0.3 在 ChatGPT 中添加连接器

1. 网页版 → **Settings → Security and login** → 启用 developer mode
2. **Settings → Plugins**（或 `chatgpt.com/plugins`）→ **+** 新建 developer-mode app
3. URL 填 0.2 输出的完整地址
4. 认证方式选 **No Authentication**
5. 保存后确认工具列表显示 **9 个** `grande_*` 工具

> 若此步失败，把失败信息记进观察记录的「未覆盖项」—— 这本身就是 S0 必须解决的问题。

### 0.4 确认训练数据设置（规格 D12）

**Settings → Data Controls** → 确认「用我的内容改进模型」**已关闭**，把结果记进观察记录。

Plus/Free 消费者账号默认是**开启**的，而 POC 之后你的私有代码会流经对话。

---

## 1. 每轮执行

**每轮必须新建对话**，并在该对话中启用 `demo-app` 连接器。

每轮开始前重置状态：重启终端里的 `node src/server.ts` 进程（假仓库与 job 都在内存里，重启即清空），并删除上一轮日志：

```bash
rm -f poc/observe.jsonl
```

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

- [ ] 模型是否用 `cursor` 续读
- [ ] 模型是否仍在使用**正确的 `taskId`**（此时已是第 15–25 次工具调用）

---

## 2. 每轮结束后

```bash
cd /Users/xtation/AgentWorks/GPT_Workspace/grande-gpt/poc
POC_LOG=./observe.jsonl node scripts/report.ts > ../docs/research/poc-round-1.md
```

（第二、三轮改成 `poc-round-2.md` / `poc-round-3.md`）

然后把手工观察项补进生成的报告 —— 报告里 P-2 和 P-4 是空的，**必须由你填**，因为 ChatGPT 不暴露这两项。

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
| 观测日志 | `poc/observe.jsonl`（gitignore） |
| 报告生成 | `node scripts/report.ts` |
| 假仓库文件 | `package.json` · `README.md` · `src/parser.ts` · `src/generated-constants.ts` · `src/big-config.ts` · `tests/parser.test.ts` |
| 可用 profile | `unit` · `unit-file` · `lint` · `typecheck` |
