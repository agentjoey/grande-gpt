# GrandeGPT Phase 4 · S4–S7 最小完整开发闭环

**日期** 2026-08-18  
**定位** 个人开发者、小团队、中小型/轻量项目  
**前置** S1 Safe filesystem → S2 Local loop → S3 GitHub push/PR

## 0. 目标与边界

Phase 4 的完成定义不是“成为 Agent Platform”，而是让一个 Task 能真正走完：

```text
Request
→ inspect repo
→ plan + acceptance criteria
→ code
→ local verify
→ commit
→ push
→ PR
→ CI
→ fix/re-push when needed
→ merge
→ deploy
→ verify
→ DONE
```

Bug、新需求、Issue 或新的 PR feedback 重新建立一个 Task，继续走同一条路径。没有独立
Requirement Management、Maintenance、Release、Incident 或 Deployment Platform。

明确不做：多 repo orchestration、Jira/Linear 替代、企业审批/RBAC/SSO、release train、
Kubernetes/DevOps orchestration、observability/incident management、multi-agent organization、
plugin marketplace、capability graph/ranking/dependency system、通用 deployment framework、
semantic code graph、自动 model routing、复杂 token/context budget。

---

## 1. S4 — Request → Plan → Development

### 1.1 TaskBrief，不新增 Requirement 对象

`grande_task_open` 新增可选 `brief`：

```json
{
  "source": { "type": "text | github_issue | markdown | bug_report | pr_feedback", "ref": "optional" },
  "request": "用户需求的简洁保真文本",
  "findings": ["与本任务直接相关的 repo 事实"],
  "plan": ["最小实现步骤"],
  "acceptanceCriteria": ["可验证验收标准"]
}
```

`plan` 和 `acceptanceCriteria` 至少各一项。TaskBrief 只是 Task 附属上下文，持久化在
`task_brief`；`grande_task_status` 可跨会话恢复。没有 requirement state、priority、dependency、
approval 等字段。

推荐使用顺序：先对 canonical 使用 `repo_map/search/read` 调研，再 `task_open(..., brief)`，随后完全复用
S1/S2 的 edit/run/diff/commit 流程。

---

## 2. S5 — Thin Capability Invocation

只提供三个 P0 工具：

- `grande_capability_list`
- `grande_capability_inspect`
- `grande_capability_invoke`

支持四种 provider：

- `native`：直接复用 GrandeGPT 现有 ToolDef，不复制实现；
- `mcp`：Streamable HTTP MCP tools/list + tools/call；
- `plugin`：P0 与 MCP provider 使用同一薄 adapter；
- `skill`：读取 `~/.grande-control/skills/` 下的可信 Markdown 指令并返回结构化 instructions。

### 2.1 控制平面配置

`~/.grande-control/config/capabilities.yaml`：

```yaml
providers:
  issue-reader:
    type: mcp
    url: https://example.com/mcp
    risk: read
    tokenFile: issue-reader-token

  deploy-platform:
    type: plugin
    url: https://deploy.example.com/mcp
    risk: production
    tokenFile: deploy-token
    allowProduction: true

  deploy-guidance:
    type: skill
    file: deploy.md
    risk: read
```

凭据只从 `~/.grande-control/secrets/<tokenFile>` 读取，不回退到环境变量。远端 URL 必须 HTTPS；
只有 loopback (`127.0.0.1` / `localhost` / `::1`) 可使用 HTTP。

风险只有四档：`read | write | destructive | production`。远端 MCP annotation 只能把风险提高，不能把
控制平面配置的风险降低。`destructive` 需要 `allowDestructive: true`；`production` 需要
`allowProduction: true`。非 read 调用必须绑定真实 `taskId` 并进入审计。

没有 marketplace、manifest DSL、dependency system、capability graph 或 ranking。

---

## 3. S6 — PR → CI → Fix → Merge

S6 复用 S3 的 GitHub token、remote 解析和 API wrapper，只新增：

- `grande_pr_status { taskId }`
- `grande_pr_merge { taskId }`

两个工具都从 `taskId → task.branch → PR` 单向推导，不接受任意 `repo` / `branch` / `prNumber`。

### 3.1 CI 状态

每次读取 PR 当前 `headSha` 的 GitHub check runs 和 commit statuses，收敛成：

```text
none | pending | passed | failed
```

失败结果只返回与修复直接相关的 check 名、conclusion、details URL 和 check output
`title/summary/text` 的有界 excerpt；不建设 Actions log archive 或 observability 数据库。

### 3.2 Merge 门禁

合并必须同时满足：

1. PR 属于 `task.branch`；
2. PR 当前 head SHA 等于任务 worktree 当前 HEAD；
3. PR 不是 Draft；
4. `mergeable === true`；
5. 当前 head SHA 有本机 attestation；
6. CI 不能是 `pending` 或 `failed`；
7. GitHub merge 请求携带同一个 expected head SHA。

`CI=none` 对没有远端 CI 的轻量项目允许继续，但仍必须满足当前 SHA attestation。
旧 SHA 的 CI 或 attestation 永远不能替新 SHA 背书。

### 3.3 S3 Draft 决策更新

Phase 4 的 Golden Path 不应人为停在 “Ready for review”。因此 **GrandeGPT 新创建的 PR 固定为
ready（`draft: false`）**，调用方不能改回 Draft。历史 Draft PR 仍由 `grande_pr_merge` 拒绝，
不会被自动越过。

---

## 4. S7 — Deploy → Verify → Maintenance Re-entry

S7 不接受任意 shell/argv。Repo 只能声明“使用哪个已经批准的 profile/capability”。固定配置文件：

`.grande/deploy.yaml`

### 4.1 Repo-defined profile

```yaml
deploy:
  profile: deploy
verify:
  profile: smoke
rollback:
  profile: rollback
```

profile 本身仍由控制平面 `profiles.yaml` 白名单定义；repo 不能从 deploy spec 注入 command。
部署 profile 必须命名为 `deploy` 或 `deploy-*`，rollback profile 必须是 `rollback` 或 `rollback-*`。
因此已有项目脚本可由 Human Owner 预先批准的 profile（例如 `pnpm run deploy`）复用，而不会打开通用 shell。

### 4.2 External deployment capability

```yaml
deploy:
  capability:
    provider: deploy-platform
    name: deploy
    arguments:
      environment: production
verify:
  capability:
    provider: deploy-platform
    name: verify
rollback:
  capability:
    provider: deploy-platform
    name: rollback
```

角色门禁：

- deploy capability 必须是 `production`；
- verify capability 必须是 `read`；
- rollback capability 必须是 `production` 或 `destructive`。

### 4.3 Receipt 与 DONE

S7 使用一张轻量 `deployment_receipt` 附属表，只记录当前 Task 的 deploy/verify job 或 capability
执行结果以及 deploy spec digest。它不是 deployment state platform。

- merge 前不能 `grande_deploy`；
- 没有真实 deployment receipt 不能 `grande_deploy_verify`；
- deploy 后 `.grande/deploy.yaml` 变化时旧 receipt 失效；
- 只有 deploy 成功 + verify 成功才返回 `DONE`；
- rollback 只调用 repo 已声明、平台已经存在的 rollback；没有声明时 fail closed，不猜通用方案。

Profile deploy/verify 是异步的：返回 jobId 后，后续再次调用 `grande_deploy_verify` 会读取真实 job 状态并继续。

---

## 5. 最终工具增量

Phase 4 在 S1–S3 的 15 个工具上新增 8 个：

```text
grande_capability_list
grande_capability_inspect
grande_capability_invoke
grande_pr_status
grande_pr_merge
grande_deploy
grande_deploy_verify
grande_deploy_rollback
```

最终 23 tools：9 read-only、14 write。`openWorldHint=true` 的精确名单由宿主 `tools.test.ts`
钉住；高风险 destructive 工具同样使用精确名单，不用“至少一个”这类弱断言。

S4 没有新增工具：它只是给现有 Task 生命周期补上 TaskBrief。

---

## 6. 验证策略

自举期间：

```text
unit-selfhost
typecheck
```

合并前：

```text
grande outer-test --run
```

`unit-selfhost` 刻意排除了自身需要 spawn sandbox 或绑定真实端口的测试，不能替代宿主 outer-test。
Phase 4 的 load-bearing 重点包括：

1. invalid TaskBrief 在 worktree 创建前拒绝；
2. destructive/production capability 没有控制平面放行时拒绝；
3. PR head SHA 变化后旧 CI/attestation 不能 merge；
4. merge 前不能 deploy；
5. deploy spec 变化后旧 receipt 不能 verify；
6. verify failure 不能产生 DONE；
7. Bug/New Request 只建立新 Task，重新进入同一 S4→S7 路径。
