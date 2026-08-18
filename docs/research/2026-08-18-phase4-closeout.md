# GrandeGPT Phase 4 Closeout

**日期** 2026-08-18  
**范围** S4–S7 · Request → Development → GitHub → Deploy/Verify  
**结论** Completed · merged · production verified

## 1. 收口结论

GrandeGPT Phase 4 已完成。产品当前具备面向个人开发者、小团队和中小型/轻量项目的最小完整代码开发闭环：

```text
Request
→ repo inspect
→ TaskBrief / acceptance criteria
→ edit + local verify
→ commit + push
→ ready PR
→ CI status / diagnosis
→ merge
→ approved deploy
→ verify
→ DONE
```

Bug、新需求和 PR feedback 重新创建 Task，继续使用同一条闭环；没有引入 requirement management、release train、incident platform 或通用 DevOps orchestration。

## 2. 最终能力

### S4 — Request → Plan → Development

- `grande_task_open` 支持轻量 `TaskBrief`；
- source 支持 `text / github_issue / markdown / bug_report / pr_feedback`；
- plan 与 acceptance criteria 持久化在 Task 上，可跨会话通过 `grande_task_status` 恢复；
- Task 仍是唯一核心执行对象。

### S5 — Thin Capability Invocation

- `grande_capability_list / inspect / invoke`；
- native / MCP / plugin / skill 四类 provider；
- `read / write / destructive / production` 四级风险；
- production/destructive 无显式控制平面放行时 fail closed。

### S6 — PR → CI → Fix → Merge

- 新 PR 固定 ready，不再制造 Draft 人工断点；
- CI 与 attestation 绑定当前 PR head SHA；
- Checks API 403 时回退 Actions workflow runs，并使用 `head_sha` 精确绑定当前 head；
- fallback 自身失败仍 fail closed；
- merge 携带 expected head SHA，旧 CI/attestation 不能为新 SHA 背书。

### S7 — Deploy → Verify

- repo 只能引用控制平面已批准 profile/capability；
- 不接受任意 shell/argv；
- deployment receipt 与 deploy spec digest 绑定；
- deploy + verify 都成功才返回 DONE；
- rollback 只调用项目已经声明的机制。

最终工具面为 **23 tools：9 read-only / 14 write**。

## 3. Phase 4 合并记录

| PR | Head | 内容 | 状态 |
|---|---|---|---|
| #1 | `c4c4e7c` | S4–S7 主实现 + GitHub CI auth compatibility | merged |
| #2 | `9ed740c` | Node 24 strip-only runtime compatibility | merged |
| #3 | `b0cb326` | production Gateway launchd 常驻 | merged |

PR #1 的首次合并发生在旧 production Gateway 无法调用新 fallback 的 bootstrap 窗口，因此由 Human Owner 手工完成；合并后的 production Gateway 已真实证明新的 `grande_pr_status` 可正常工作。PR #2 和 #3 均由 GrandeGPT 自己完成 status/merge。

## 4. 验收证据

### Repository / self-host

- `unit-selfhost`：**53 files / 566 tests passed**；
- `typecheck`：passed；
- host outer-test：**5 files / 132 tests passed**。

### Production runtime

Phase 4 首次上线后发现 `GithubApiError` 使用 TypeScript parameter property；Node v24.14.0 直接运行 `.ts` 的默认 strip-only 模式无法解析该语法。修复后：

- parameter property 改为显式 field + assignment；
- 增加真实子 Node 进程直接 import production TS 模块的 regression；
- production 不依赖 `--experimental-transform-types`。

这个缺陷说明 `tsc + Vitest` 不能替代 production Node runtime compatibility probe，该回归现已进入 `unit-selfhost`。

### Production Gateway

最终实机状态：

```text
LaunchAgent  ai.agentjoey.grande-gateway
state        running
listener     127.0.0.1:8787
selfcheck    HTTP 200
MCP tools    23 = 9 read-only + 14 write
```

Gateway 使用 macOS 用户级 LaunchAgent：登录后自动启动、异常退出 KeepAlive 拉起；stdout/stderr 写入 `~/.grande-control/logs/`。Cloudflare Tunnel 继续指向 loopback 8787，不改变公网端点与 OAuth 架构。

## 5. 运维入口

```bash
node --disable-warning=ExperimentalWarning src/cli.ts gateway status
node --disable-warning=ExperimentalWarning src/cli.ts gateway restart
node --disable-warning=ExperimentalWarning src/cli.ts gateway stop
node --disable-warning=ExperimentalWarning src/cli.ts gateway start
```

安装/更新 LaunchAgent：

```bash
GRANDE_WORKSPACE=/absolute/path/to/GPT_Workspace \
GRANDE_ISSUER=https://grande.agentjoey.ai \
node --disable-warning=ExperimentalWarning src/cli.ts gateway install
```

## 6. 收口后的边界

Phase 4 到此不再继续扩展。下一阶段应继续遵守 GrandeGPT 的产品定位：优先补真实使用中暴露的闭环缺口，不把系统扩成大型软件工程平台。

早期 S0/S1/S2/S3 设计与 `.superpowers/sdd/progress.md` 保留为历史执行记录；其中旧 roadmap、工具数量、Draft PR 等描述是当时快照，不再代表当前产品状态。当前入口以 `README.md`、Phase 4 规格和本 closeout 为准。
