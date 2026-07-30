# S3 宿主验收：三项沙箱内不可证明的判据（2026-07-30）

S3 合并时有三项判据**结构上只能在沙箱外做**。本文是它们的实测记录。
其中第 ② 项**查出一个真缺陷：`grande_push` 从未真正推成功过一次。**

---

## ① AC-S3-8 / AC-S2-1：git hooks 不执行 —— ✅ 通过

沙箱的 `process-exec` 白名单会让 worktree 里的 hook 拿到 `execvp EPERM`，
git 收到后**静默当作「没有 hook」继续**。所以这两条断言在 `unit-selfhost` 里
**无论有没有防护都绿**——是假阴性，不是证明。

宿主上重做（先确认前提，再拆防护）：

```
① 能读 ~/.npmrc                    → 确认不在沙箱内（否则整个证明无意义）
② 临时 hook 脚本能执行              → 确认假阴性条件不存在
③ 基线（防护在位）                  → 绿
④ 从 push.ts 删掉 core.hooksPath   → ✗ AC-S3-8  expected true to be false
⑤ 从 commit.ts 删掉 core.hooksPath → ✗ AC-S2-1
⑥ 还原                             → 全绿
```

第 ④ 步的 `expected true to be false` 是 marker 文件**真的被 hook 创建了**——
即宿主上 hook 确实会跑，`-c core.hooksPath=/dev/null` 是唯一挡住它的东西。

**这两条断言在宿主上承重。** 此前 CLAUDE.md 记的「由 reviewer 在沙箱外补完」
现在有了可复现的步骤。

---

## ② 真实 GitHub 连通性 —— ❌ 查出真缺陷，已修

### 症状

用控制平面的 PAT 对 `agentjoey/urbanbricks-poc` 做 `git ls-remote`：
`fatal: Authentication failed`。

### 单变量隔离

| 探针 | 结果 |
|---|---|
| REST API + `Authorization: Bearer <PAT>` | ✅ HTTP 200 |
| `git ls-remote` + `Authorization: Bearer <PAT>` | ❌ Authentication failed |
| `git ls-remote` + `Authorization: Basic base64(x-access-token:<PAT>)` | ✅ 成功 |

**token 本身有效且已授权该仓库**（第一行证明）。差别只在认证方案。

### 根因

`githubGitArgv` 用的是 `http.extraHeader=Authorization: Bearer <token>`。
**GitHub 的 REST API 与 git 智能 HTTP 端点接受的认证方式不是同一套**：
REST API 接受 Bearer，git 端点只接受 Basic（token 作密码）。

**`grande_push` / `grande_pr_open` 从来没有真正工作过。**

### 为什么 606 个测试全绿也没发现

**S3 的测试全部推向本地 bare 仓库**——那里根本不需要认证，
`Authorization` 头被完全忽略。AC-S3-4「push 后 bare 仓库的 sha 等于任务分支的 sha」
在认证完全错误的情况下照样通过。

这是本项目一个**新形状**的漏网，和以前的都不一样：不是漏改、不是空转测试，
而是**测试替身把被测的那一层整个绕开了**。断言本身正确、非空转、也没写错——
只是它验证的东西里不包含认证。

**一般化：凡是「用本地替身代替远端」的测试，都要问一句「这个替身是否让某一层
变成了 no-op」。** 本地 bare remote 让认证层变成 no-op；本地 fixture 让网络层
变成 no-op；`/dev/null` 让写入层变成 no-op。

### 修复

`Basic base64("x-access-token:<token>")`，收敛在 `githubAuth.ts` 的
`basicCredential()`，理由与实测判决写在那里的 JSDoc 里。

**连带修了一个新泄漏口**：`redactToken` 原先只抹原始 token，抹不掉 base64 变形——
而那个变形解一次就是明文 PAT。凡是回显了 `http.extraHeader` 的输出
（git 的部分报错、`GIT_TRACE`、`GIT_CURL_VERBOSE`）都会整条漏出去。
现在两种形态都抹，前缀也抹（base64 按 3 字节一组编码，截断的前缀仍能解出前半段）。

### 修复后的真实闭环

`repo_edit → commit → push → pr_open`，对着真实 GitHub，**每一步都从对端独立核对**，
不只看工具自己的返回值：

| 判据 | 独立核对 |
|---|---|
| 连通性 | `ls-remote` 拿到 `ref: refs/heads/main HEAD` |
| **确实用 PAT，没有回落宿主 ambient 凭据** | 换一个垃圾 token → 失败。这是 AC-S3-13 缺的**行为**证明（原断言只查 argv 形状） |
| push | remote 侧 `refs/heads/grande/ub-probe-...--001` = `c62ecc0`，与本地 HEAD 一致 |
| PR 恒为 draft | GitHub API 返回 `draft=True` |
| 不推默认分支 | PR 是 `grande/...` → `main`，main 未被动过 |
| attestation 尾注唯一 | body 里 `Grande-Attestation` 恰好 1 次 |

产物：PR #1 `agentjoey/urbanbricks-poc`（Draft）+ 分支 `grande/ub-probe-20260729-001--001`。
**验证用，可删。**

---

## ③ 缺 `Workflows` 权限时 push 被拒 —— ✅ 通过，但暴露一个配置缺口

```
! [remote rejected] grande/ub-probe-... -> grande/ub-probe-...
  (refusing to allow a Personal Access Token to create or update workflow
   `.github/workflows/grande-probe.yml` without `workflow` scope)
```

拒绝消息**直接点名文件和缺失的 scope**，不是难懂的 403。判据满足。

### 但顺手发现：这条路径上 GitHub 是唯一防线

原本预期 S1.5 的 `readOnlyPaths` 会先拦住。**实测没有**：
`grande_repo_edit` 允许写 `.github/workflows/grande-probe.yml`。

原因是 **`readOnlyPaths` 门禁代码存在，但一条规则都没配置**——
`~/.grande-control/config/policy.yaml` 与 `urbanbricks/.grande/policy.yaml` 都不存在。
S1.5 设计里 `.github/workflows/**` 只是**举例**，从未落成实际配置。

所以现在：**每个已注册仓库的 `.github/workflows/**` 对 GrandeGPT 都是可写的**，
唯一阻止它生效的是 PAT 恰好没给 `workflow` 权限。那是「配置恰好安全」，
不是「设计上安全」——换一个给了 workflow 权限的 PAT，这层当场消失。

已记入 CLAUDE.md 遗留表。修法是给全局 policy 配上 `readOnlyPaths`，
而不是依赖 PAT 权限——**能做成硬约束的绝不做成软约束**（铁律三）。

---

## ④ 附带发现：参数名写错时的报错不可用

我第一次调 `grande_repo_edit` 时把参数名写成 `edits`（正确是 `ops`），
得到的是：

```
{"code":"INTERNAL","message":"Gateway 内部错误。详情见服务端日志。"}
```

**模型撞上同样的错会完全无从下手**——它看不到服务端日志，而这条消息
既没说是哪个参数、也没说缺了什么。schema 校验失败应当返回
`INVALID_INPUT` 并点名字段，而不是折叠成 `INTERNAL`。

已记入 CLAUDE.md 遗留表。

---

## 结论

| 判据 | 结果 |
|---|---|
| ① git hooks 不执行（AC-S3-8 / AC-S2-1） | ✅ 宿主上承重，有可复现步骤 |
| ② 真实 GitHub 连通性 | ❌→✅ 查出真缺陷（Bearer/Basic），已修并真实跑通全链路 |
| ③ 缺 Workflows 权限 → push 被拒 | ✅ 通过；顺带发现 `readOnlyPaths` 完全未配置 |

**S3 现在才算真的验收完。** 合并时的「完成」是基于一套绕开了认证层的测试。
