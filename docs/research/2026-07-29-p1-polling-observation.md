# P-1 · 真实 ChatGPT 对话中的模型自主轮询 —— 结论：**PASS**

**日期** 2026-07-29 · **端点** `https://grande.agentjoey.ai/mcp`（D18 单一端点）
**客户端** ChatGPT Plus 桌面版 · **权限档** `Allow low-risk actions`
**任务** `task-ub-probe-20260729-001` · **仓库** urbanbricks · **profile** `probe-slow`（90s）

---

## 结论

**模型会自主轮询到终态。** 一条用户消息触发，随后 5 次 `grande_run_result`
全部由模型自己发起，中间**没有任何用户输入**。

```
job 窗口: 02:41:21.984 → 02:42:52.019  (90.0s)

02:41:22.118  grande_run                              ← 唯一由用户提示触发的调用
02:41:27.327  grande_run_result  +5.3s   距上次  5.3s  → running（非终态）
02:41:36.399  grande_run_result  +14.4s  距上次  9.1s  → running（非终态）
02:42:13.511  grande_run_result  +51.5s  距上次 37.1s  → running（非终态）
02:42:42.112  grande_run_result  +80.1s  距上次 28.6s  → running（非终态）
02:43:10.821  grande_run_result  +108.8s 距上次 28.7s  → 终态 passed
```

**4 次拿到非终态，4 次都自己再取。** 这正是此前两轮实测没能覆盖的场景。

间隔形态：先短促试探（5.3s / 9.1s），随后拉长并收敛到约 28 秒。ChatGPT UI 显示
「Worked for 2m 6s」，与 job 90s + 末次轮询滞后 19s 吻合。

---

## 为什么前两轮测不出来

| 轮次 | job | 时长 | `run_result` 次数 | 为什么无效 |
|---|---|---|---|---|
| AC-13 | grande-gpt `unit` | 3.2s | 1 | 短于模型的首次等待，一次就是终态 |
| D18 验证 | urbanbricks `lint` | 2.7s | 1 | 同上。UI 显示 27s，说明模型**等了**，但只取了一次 |
| **本轮** | urbanbricks `probe-slow` | **90.0s** | **5** | 终于构成需要轮询的场景 |

POC 阶段的「4/4 自主轮询、最长链 17 次」是在秒回的假服务端上测的。真实的
几十秒等待直到这一轮才被覆盖——**规格 §9.2 的 P-1 至此才真正闭合**。

## 顺带确认的两件事

- **沙箱资源统计可信**：峰值内存 44 MB、退出码 0、无 stderr、未触发超时或强杀。
- **worktree 零副作用**：`工作区变更文件数: 0`——一个只 sleep 的 job 不该改任何文件，
  确实没有。

---

## 方法学：为什么这次的证据是可信的

两点纪律，缺一就不成立：

1. **发出提示词后全程不再说话。** 任何一条用户消息都会让「模型自主轮询」与
   「被用户推着走」无法区分。POC 阶段的 P-1 判据就是这么定的。
2. **网关日志此前没有时间戳**，只能数出「调了几次」，量不出间隔——本轮之前先
   给 `[gw]`/`[tool]` 两条日志加上了墙钟时间戳（`src/server.ts`），才有了上面那张
   把每次轮询对齐到 job 窗口的表。

## 探针本身

`probe-slow` 是为这次测量临时加的 profile，argv 为
`["node", "-e", "…setTimeout(…, 90000)…"]`，**测完即删**。

它不构成逃生舱：模型只能提交 profile **名字**，argv 写死在控制平面
`~/.grande-control/config/profiles.yaml` 里，仓库内容改不动它（铁律一 + 铁律二）。
`node` 可执行是因为 `defaultExecRoots()` 本就包含 node 自身的 bin 目录——
`pnpm`/`vitest` 都要靠它。
