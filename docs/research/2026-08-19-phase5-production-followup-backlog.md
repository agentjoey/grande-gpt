# Phase 5 production follow-up backlog

日期：2026-08-19

背景：Phase 5（S8–S10）代码已合并到 canonical。首次把 production Gateway 切换到 Phase 5 运行时的过程中，暴露了以下真实运维/闭环问题。此文件只是现有 GrandeGPT backlog 的 follow-up 记录，不引入新的 issue/workflow 系统。

## P0 — `grande gateway restart` 不是失败安全的

### 观察

执行：

```bash
node --disable-warning=ExperimentalWarning src/cli.ts gateway restart
```

结果：旧 LaunchAgent 已被 `bootout`，随后 `launchctl bootstrap` 返回：

```text
Bootstrap failed: 5: Input/output error
```

之后：

- `grande gateway status` 明确显示 `gui/501/ai.agentjoey.grande-gateway` 未加载；
- plist 仍存在；
- `plutil -lint` 返回 `OK`；
- `launchctl print gui/501` 中没有 GrandeGPT job；
- 单独执行 `grande gateway start` 随后成功，Gateway 恢复 `state=running`。

### 风险

`restart` 当前可能完成了 destructive half（停止旧 production），却没有完成 recovery half（启动新 production），把服务留在离线状态。

### 建议 hardening

保持现有 LaunchAgent 架构，不增加新 subsystem。最小目标：

1. restart 前确认当前 loaded state；
2. `bootout` 后等待 `launchd` 确认 job 已完全 unloaded；
3. 再执行 bootstrap，并对 error 5 做有限重试/诊断；
4. bootstrap 成功后确认 job loaded/running；
5. 最后做 Gateway health/selfcheck；
6. 若新 bootstrap 最终失败，输出明确 recovery command，避免把“restart 失败”误解为“旧服务仍在运行”。

不要用 `sudo` 绕过用户级 LaunchAgent 语义。

## P1 — canonical merge 与 production runtime activation 之间没有显式闭环

### 观察

Phase 5 已合并到 canonical，但长期运行的 Node Gateway 仍保持 Phase 4 进程。因为 Phase 5 没新增 MCP tool，`tools/list` 仍是 23 tools，所以单看工具数量无法发现 runtime stale。

真正的判据来自 S10 行为：restart/start 后 `grande_task_status` 才开始返回：

- `progress.stages`
- `completed`
- `cleanupRequired`
- `blocker`
- `nextAction`

### 风险

“代码 merged”可能被误报为“production 已升级”。如果 schema/tool count 没变化，当前 `selfcheck` 也不能证明正在运行的是哪个 commit/version。

### 建议 hardening

优先考虑极小的 runtime identity / activation evidence，而不是建设 deployment platform，例如：

- Gateway 启动日志记录 canonical commit；或
- health/selfcheck 返回 build/runtime commit；或
- GrandeGPT 自身 closeout 明确要求 `gateway restart/start → selfcheck → behavior/version probe`。

## P1 — remote `main` 合并后 local canonical 不自动 refresh

### 观察

`grande_pr_merge` 更新 GitHub remote `main`，但 GrandeGPT 的 canonical 是本机 checkout；现有 `grande_sync_base` 只同步到“本机 canonical HEAD”，明确不 fetch。因此 merge 后若 Human 没有更新 local canonical，后续 `task_open` 仍可能基于旧 HEAD。

Phase 4 closeout 时已经实际出现：GitHub PR 已 merged，但本机 canonical README/closeout 文档仍是旧版本。

### 风险

连续 autonomous tasks 可能从 stale base 开始，增加不必要的同步/冲突风险，也会让“remote 已上线”和“本机 source of truth”短暂分叉。

### 建议 hardening

保持 `task_open` 不做隐式长耗时 fetch 的既有原则。单独设计一个窄语义的 safe canonical refresh 或 Human-side CLI：固定 registered repo / origin / default branch，只允许 clean working tree 下 fast-forward，不允许 force/reset/arbitrary ref。

## P2 — `grande selfcheck` 对交互 shell 的 `GRANDE_ISSUER` 依赖容易造成误判

### 观察

Gateway 已经由 LaunchAgent 正常运行并持有 production issuer，但在普通 shell 直接运行：

```bash
node --disable-warning=ExperimentalWarning src/cli.ts selfcheck
```

会因为当前 shell 没有 `GRANDE_ISSUER` 而失败，并提示手工设置：

```text
GRANDE_ISSUER=https://grande.agentjoey.ai grande selfcheck
```

这不是 Gateway outage，只是 CLI 本进程缺少 issuer。

### 风险

生产恢复后，Human 容易把 selfcheck 的环境错误误判成 Gateway 仍未恢复。

### 建议 hardening

不降低 issuer/audience 校验。可以改善 ergonomics：

- `gateway status` 显示 LaunchAgent 已配置的 issuer；
- selfcheck 在 issuer 缺失时给出更明确的“Gateway 可能正常，只是当前 shell 未配置”的诊断；
- 如果能安全读取可信 LaunchAgent/config 中的 issuer，可考虑显式 opt-in 复用；不能可靠证明来源时继续 fail closed。

## External observation — ChatGPT 既有会话可能不热刷新 GrandeGPT tool registry

### 观察

一个已经打开的 ChatGPT 会话中，即使 UI 显示 `@GrandeGPT` enabled，模型 runtime 没有拿到 `grande_*` tools；新建会话后第一条直接 `@GrandeGPT 查询 task 状态` 即正常加载并调用 production tools。

### 分类

当前证据指向 ChatGPT conversation/runtime 级 App/tool binding 行为，不是 GrandeGPT Gateway 故障：同一时刻另一会话可正常发现 23 tools 并调用 `grande_task_status`。

### 处理

先作为外部平台观察项保留，不为单次样本修改 GrandeGPT 协议。若重复出现，再补运维文档：启用/更新 GrandeGPT App 后遇到“UI enabled 但无 tools”时，优先用新会话验证，避免误查 Gateway。

## 已验证的最终 Phase 5 production 状态

恢复步骤：

```text
gateway restart → bootstrap error 5 / offline
gateway start   → success
```

随后 production `grande_task_status(task-obsidian-v1-20260818-001)` 已真实返回 S10 progress projection：

```text
Code ✓  Tests ✓  PR ·  CI ·  Merged ·  Deploy —  Verify —
nextAction: grande_push 后 grande_pr_open
```

因此 Phase 5 当前状态可标记为：

```text
source/canonical merged  ✅
production Gateway       ✅ running
Phase 5 runtime loaded   ✅ behaviorally verified
```
