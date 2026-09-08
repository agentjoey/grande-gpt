# Minimal V2 — Console Delivery Approval API（Gateway → grande-console handoff）

**日期**:2026-09-08
**实现侧事实来源**:`src/consoleRoutes.ts`、`src/consoleAuth.ts`、`src/deliveryAuthorization.ts`、
`tests/consoleDeliveryRoute.test.ts`（真实路由与状态机以此为准，本文不做任何发明）。
**repo 边界**:本文只是 Gateway 到 grande-console 的 handoff 合同。Gateway worker **不得修改
grande-console**;Console 侧 UI（T3）在独立 feature 中实现，不在本文件范围内。

---

## 1. 面与边界

- 只有三个写路由，全部挂在 Gateway 的 Console 写端点面上（与 `/mcp` 完全不同的 Cloudflare
  Access 应用，`access-console.yaml` 的独立 `aud`；启动时 `assertDistinctAudience` 强制两个
  aud 不同，相同即拒绝启动）。
- **Human 的 delivery approval 只在 Console 发生这一次**。approval、nonce、argv **不进入
  public MCP**:`grande_*` 工具表里没有 approval/challenge/nonce 工具（`contract.ts`
  `MCP_WRITE_TOOLS` 亦无）；MCP 侧只有 `grande_task_open` 的可选 `deliveryTarget` 声明意图。
- HTTP handler **零执行**:challenge/approve/reject 只做 durable authorization 状态转移；
  merge/deploy/verify 由后续 GrandeGPT 工具（`grande_pr_merge` / `grande_deploy` /
  `grande_deploy_verify`）按 receipt 推进。Console 不需要、也不能触发执行。
- 单次审批有效期：`expiresAt = createdAt + APPROVAL_TTL_MS`（`deliveryAuthorization.ts`），
  过期后 challenge/approve/reject 一律 409 `auth_expired`，需重新 prepare。

## 2. 认证与 Origin（先于 body 解析、先于查库）

1. `Cf-Access-Jwt-Assertion` 头必须存在且通过 Console 专属 aud 校验；缺失/非法 →
   **403 `access_denied`**。审批人身份（`sub`/`email`）只取自已验证 JWT——请求体里的任何
   `approver` 字段都会被 400 拒绝。
2. `Origin` 头必须**逐字节等于** `access-console.yaml` 的 `origin`（配置启动时归一化：
   仅 https、无路径/query/hash、无尾斜杠；请求侧不做任何归一化）。缺失、字面量
   `"null"`、尾斜杠变体、不同端口 → **403 `origin_denied`**。
3. Gateway 未配置 `consoleOrigin` 时审批面 fail-closed:**403 `access_denied`**
   （缺配置 = 审批面未安装，不是不校验）。

## 3. 路由

### POST `/console/delivery/:authorizationId/challenge`

领取一次性审批 nonce 与 bounded summary。

- Request:`Content-Type: application/json`，body **恰好** `{"bindingDigest": "sha256:<64hex>"}`。
- Success 200:

```json
{
  "ok": true,
  "data": {
    "authorizationId": "authz_<uuid>",
    "bindingDigest": "sha256:<64hex>",
    "status": "READY",
    "expiresAt": 1730000000000,
    "summary": { "…": "见 §4 bounded fields" },
    "approvalNonce": "<256-bit random, base64url, 43 chars>"
  }
}
```

- 每次 challenge 都**轮换** nonce：旧 nonce 立即失效（approve 用旧 nonce → 409 `auth_nonce`）。
- **明文 nonce 只出现在这一次响应里**：库中只有 `nonceDigest`；审计 input 恰好是
  `{authorizationId, bindingDigest}` 的摘要——**nonce 与 JWT 都不进 audit/evidence/log**。

### POST `/console/delivery/:authorizationId/approve`

READY → APPROVED（单事务 CAS，HTTP handler 内零执行）。

- Request:body **恰好** `{"bindingDigest": "…", "approvalNonce": "…"}`。
- Success 200:`{"ok": true, "data": {"authorizationId", "bindingDigest", "status": "APPROVED", "expiresAt"}}`。
- 并发双击/响应丢失重放：最多一次状态转移；重放返回同一 APPROVED 且零写入
  （`updatedAt` 不变）。

### POST `/console/delivery/:authorizationId/reject`

READY → REJECTED；尚未开始执行的 APPROVED → REVOKED。EXECUTING 及以后 → 409
（已发生的 side effect 走运维路径，不由本 API 收回）。

- Request/Response：与 approve 同形，`status` 为 `REJECTED` 或 `REVOKED`。
- 终态后同请求重放幂等：返回同一状态，零写入。

### 错误码一览

| HTTP | code | 含义 |
|---|---|---|
| 403 | `access_denied` | 无/非法 Access JWT；或审批面未配置可信 Origin |
| 403 | `origin_denied` | Origin 未逐字节匹配可信配置 |
| 400 | `not_json` | Content-Type 不是 application/json |
| 400 | `bad_json` | body 不是合法 JSON |
| 400 | `bad_body_shape` | 字段集不恰好/值非字符串（自报 `approver`/`taskId`/SHA 等一律落这里） |
| 404 | `auth_not_found` | authorizationId 不存在 |
| 409 | `stale_state` | bindingDigest 漂移、并发 CAS 冲突、非法当前状态 |
| 409 | `auth_nonce` | nonce 错误或已被轮换 |
| 409 | `auth_expired` | 已过 `expiresAt` |

### Security headers（`/console/delivery/*` 全部响应，含 4xx）

```
Content-Security-Policy: default-src 'self'; frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

## 4. Bounded summary（Console 只允许展示的字段）

challenge 响应的 `summary` 只含 Human 判断所需字段，**不含** PR 标题/日志/HTML 自由文本，
**不下发** `worktreeRealpath` 等本机路径：

- 公共:`authorizationKind`、`taskId`、`repoId`、`deployTarget`、`deploySpecDigest`、
  `policyDigest`、`runtimeBuild`、`toolsetEpoch`、`toolsDigest`、`createdAt`、`expiresAt`
- delivery（`authorizationKind: "delivery"`）另含:`prNumber`、`baseRef`、`baseSha`、
  `headSha`、`mergeMethod`、`expectedMergeTree`、`deployRef`、`verifyRef`
- rollback（`authorizationKind: "rollback"`）另含:`currentDeploymentId`、`currentSourceSha`、
  `rollbackDeploymentId`、`rollbackSourceSha`、`rollbackArtifactDigest`（可选）、`rollbackRef`

## 5. Deploy / rollback 授权分离与 DONE evidence

- **deploy 与 rollback 是两条独立 authorization**：rollback 绝不复用 delivery
  authorization；delivery 的 approve 不授予任何 rollback 能力，反之亦然。
- delivery DONE 的 durable evidence（`deployment_receipt`，Console 只读展示）:
  `verifyComplete: true` + `verifyEvidence: { target, deploymentId, sourceSha,
  artifactDigest? }`，且 `sourceSha` 精确等于 exact merge receipt 的 `mergeSha`;
  authorization 同时 CAS 到 `SUCCEEDED`。缺 evidence 时投影 fail-closed 为
  `DELIVERY_FAILED`，绝不捏造身份。
- 对 `repoId = grande-gpt`（Gateway 自身）的交付另有 Task 7 门禁：进入 DONE 前必须存在
  durable activation receipt/readback；缺失时 `grande_deploy_verify` fail closed，
  authorization 保持 EXECUTING。其他 repo 不经此门禁。

## 6. 身份与 CAS 要点（Console 实现须知）

- `authorizationId` 走 URL path;`bindingDigest` 必须在 body 中回传并与 durable 值精确
  一致——不匹配即 409 `stale_state`， Console 应重新 challenge 拿最新 summary。
- 所有状态转移由 `deliveryAuthorization.ts` 的单事务 CAS 承担；Console 不需要、也不应
  实现任何本地状态推断，以响应的 `status` 为准。
- 重放安全：approve/reject 幂等；nonce 一次性且随每次 challenge 轮换。
