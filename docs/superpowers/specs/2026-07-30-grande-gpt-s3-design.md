# GrandeGPT S3 设计 · GitHub 闭环

**日期** 2026-07-30 · **前置** S0 → S2 已完成并合并
**上游规格** [`2026-07-25-grande-gpt-s0-design.md`](2026-07-25-grande-gpt-s0-design.md)（§10 路线图）
**实现者** ChatGPT，经 GrandeGPT 自身完成（第三次自举）

---

## 0. 本切片的性质：第一次打开网络面

到 S2 为止，整个系统是 `deny network*` 的——那是很多安全性质的**前提**而不是附带效果。
S3 要打开它，因此本切片的风险等级高于此前任何一个。

**三条边界，一条都不能松：**

| # | 边界 |
|---|---|
| ① | **沙箱仍然 `deny network*`。** 网络只在 Gateway 进程里发生，和 `git commit` 一样。**绝不为 push 放开沙箱的网络** |
| ② | **凭据只在控制平面。** 仓库里、worktree 里、job 环境变量里都不得出现任何 token |
| ③ | **绝不 push 受保护分支**（规格 §2.3 永久非目标）。只 push 任务分支 |

### 0.1 实现者的处境（设计必须绕开）

**`grande-gpt` 自己没有 remote。** 我实测确认：`git remote -v` 为空。
所以实现者**无法对真实 GitHub 测试**，也不应该——它不该拿到你的凭据。

**唯一可行的测试形态：本地 bare 仓库当远端。**

```
git init --bare /tmp/fake-remote.git
git remote add origin /tmp/fake-remote.git
git push origin <branch>          ← 实测可用，不触网
```

我已实测这条路走得通。**所有 push 测试都必须用这个形态。**
真实 GitHub 的连通性由 Human Owner 在沙箱外单独验证一次，不进自动化测试。

### 0.2 仍然做不到的

1. 没有 shell；验证只能经 `grande_run` 跑已注册 profile
2. **`unit` 在沙箱里永远绿不了**——一律用 `unit-selfhost`
3. 不能新增 profile
4. **不能访问真实网络**（沙箱禁网），也不该拿到任何真实凭据

---

## 1. 范围

| # | 内容 |
|---|---|
| ① | 凭据存取：GitHub token 从控制平面读，永不落盘到工作区 |
| ② | `grande_push` —— 把任务分支推到 remote |
| ③ | `grande_pr_open` —— 开一个 **Draft** PR |

**不做**：
- **CI 状态查询** —— 实测确认：`urbanbricks` 与 `grande-gpt` **都没有 `.github/`
  目录，没有任何 CI**。规格 §10 把 CI 列进 S3，但那是在任何仓库接入之前写的。
  给不存在的东西做接口，还要靠猜 PAT 权限项，两头都不划算。
  **等你真的给某个 repo 加了 Actions 再做**——那时建 PAT 时能在 UI 里看到实际选项，
  且能确定该读 check runs 还是 workflow runs（取决于用什么 CI）。加一个只读工具是小活。
- 合并 PR（那是人的决定）；review 评论；issue 操作；任何对 `main` 或受保护分支的直接写入。

---

## 2. 凭据：第一个决定是「专用凭据 vs 宿主凭据」

**它现在就已经能连 GitHub 了——这恰恰是问题。** 实测（2026-07-30）：

```
git ls-remote origin HEAD   → 成功，零显式凭据
```

因为本机有两套现成认证：`credential.helper = store`（token **明文**在
`~/.git-credentials`）+ `gh` 已登录（`gho_` token 在 keyring）。

**所以 `grande_push` 什么都不做就能跑通，而那意味着模型继承你的全部 GitHub 权限：**

| | 用宿主现成凭据 | 专用 PAT |
|---|---|---|
| 能碰哪些仓库 | **你能碰的全部** | 只有你授权的那几个 |
| GitHub 审计日志里是谁 | **是你** | 是 GrandeGPT 的 token |
| 要撤销时 | 撤了你自己也用不了 | 单独吊销，不影响你 |
| 别的代码路径误触 | 能拿到（在 ambient 环境里） | 拿不到 |

这与铁律三同源：「模型不该 push 到别的仓库」如果只靠它自觉就是**软约束**；
换成一个只授权了那几个仓库的 PAT，它**做不到**。

**因此：必须显式传专用凭据，并主动阻断 ambient 凭据。**
`grande_push` 要用 `-c credential.helper=` （**空值，清掉继承来的 helper**）
再显式给自己的凭据。**这一条要有测试**：断言 git 调用里出现了清空 helper 的参数。

### 2.0 PAT 权限清单（fine-grained）

**Repository access：只勾那几个已注册仓库，绝不选 "All repositories"。**
这是第一道也是最有效的一道。

| 权限 | 级别 | 用途 |
|---|---|---|
| **Metadata** | Read | 强制项，其余权限的前置 |
| **Contents** | Read and write | `git push` |
| **Pull requests** | Read and write | 开 Draft PR；查「是否已存在」做幂等 |

**只要这三项。** CI 相关的权限本切片不需要（见 §1「不做」）。

**明确不给的**，每条都有理由：

| 不给 | 后果 |
|---|---|
| **Workflows** | **见 §2.0.1——不给它反而是本切片最有价值的一条** |
| Actions | 给了就能触发/取消 workflow |
| Administration | 能改仓库设置与分支保护规则——正是我们的边界所依赖的东西 |
| Secrets / Variables / Environments | 能读写 CI 密钥 |
| Webhooks | 能改事件投递 |

#### 2.0.1 不给 `Workflows`：把软约束换成硬约束

**没有这个权限，GitHub 服务端会拒掉任何修改 `.github/workflows/**` 的 push。**

我们本来打算用 S1.5 的 `readOnlyPaths` 挡 workflow 文件——但那是**我们的代码**在挡，
代码可能有 bug、可能被绕过。**GitHub 在服务端拒绝，我们的代码有没有 bug 都一样。**

两层叠加，各有各的价值：
- 我们的 policy 挡在 `repo_edit`（**早**，错误消息清楚，模型能自己改正）
- GitHub 挡在 push（**晚**，但**不可绕**）

⚠️ 这一条**只能在真实 GitHub 上验证**，实现者用本地 bare 测不出来。
由 Human Owner 手工验一次：故意改一个 workflow 文件，确认 push 被 GitHub 拒。

### 2.0.2 PAT 会过期

fine-grained PAT 最长 1 年。过期后 push 失败，**必须映射成一个明确的错误码**
（不是笼统的「push 失败」），消息里说清「PAT 已过期，去控制平面换一个」。
fail closed 且可诊断。

### 2.1 凭据的存放与使用

- 位置：`~/.grande-control/secrets/github-token`，**权限 0600**
- **绝不写进 `.git/config`**（那会落到仓库里）、**绝不进 job 环境变量**、
  **绝不出现在任何日志或错误消息里**
- 用 `-c http.extraHeader=...` 的临时形式传给单次 git 调用，**并同时 `-c credential.helper=` 清掉继承来的 helper**（见 §2 开头）
- **文件缺失 → fail closed**，拒绝并说明要配什么
- **错误消息必须脱敏**：GitHub 的 401/403 响应体可能回显 token 前缀，
  转发给模型之前要过一遍脱敏

**这一条要有测试**：构造一个包含 token 的错误响应，断言最终返回给调用方的消息里
**不含该 token 的任何片段**。

---

## 3. `grande_push`

```
grande_push { taskId }
注解 { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
```

**`openWorldHint: true`** —— 这是全系统**第一个**触网的工具，注解必须如实反映。
此前所有工具都是 `false`，这条改变会让 ChatGPT 的权限档对它另眼相看，那是对的。

### 3.1 只推任务分支：用白名单，不用黑名单

推送目标**恒为 `task.branch`**，不接受分支参数。三道判据**全部在代码里**，无配置项：

```
① 必须匹配 grande/*        ← 白名单，硬拒
② 必须 === task.branch     ← 不接受任何外部指定
③ 必须 ≠ remote 默认分支    ← 运行时查，不靠配置
```

**为什么是白名单而不是「受保护分支清单」**（本文件初稿写的是后者，是错的形状）：

| | 黑名单 `[main, master, release/*]` | 白名单 `grande/*` |
|---|---|---|
| 仓库有个叫 `production` / `dev` 的分支 | **漏掉，放行** | 拒绝 |
| 需要配置 | 要，**配错就是个洞** | **不用** |
| 未知情况 | **fail open** | **fail closed** |

黑名单要求预先枚举「所有不该碰的东西」——那是一份永远不可能完整的清单。
白名单只要枚举「唯一该碰的东西」，而那个精确已知：任务分支只在
`src/worktree.ts` 的 `const branch = "grande/<slug>-<suffix>"` 一处产生，
永远带 `grande/` 前缀。

**第③条是纵深防御**：假如哪天默认分支被改名成 `grande/main`（离谱但不违法），
白名单会放行，这一条能挡。它是运行时查（**`git ls-remote --symref origin HEAD`** —— 实测确认
`git symbolic-ref refs/remotes/origin/HEAD` 在 `git remote add` 之后会
`fatal: not a symbolic ref`，因为那个 ref 只有 clone 才会设），仍然不需要配置。

### 3.2 `--force` 一律禁止

不提供任何形式的强推。任务分支只应线性增长；需要重写历史就换个任务。

### 3.3 前置条件

- 该任务必须有至少一个 commit（否则拒绝，说明先 `grande_commit`）
- remote 必须已配置（`grande-gpt` 目前没有——拒绝并说明）
- 带 `-c core.hooksPath=/dev/null`（**S2 的结论在这里同样成立**，`pre-push` 是 hook）

---

## 4. `grande_pr_open`

```
grande_pr_open { taskId, title, body }
注解 { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
```

### 4.1 只开 Draft

**恒为 draft，不接受参数控制。** 理由：PR 从 draft 转 ready 是一个「我认为这可以被
审阅了」的判断，那是人的判断。模型可以准备好一切，但不替你做这个决定。

### 4.2 body 必须带可信尾注

与 `grande_commit` 同一形状（S2 §3.3）：

```
<模型给的正文>

---
Grande-Task: <taskId>
Grande-Attestation: <attestationId 或 none>
Grande-Commit: <被推送的 sha>
```

**模型正文里出现这三个键必须剥掉再追加**，理由同 S2：否则模型能伪造「已验证」。

### 4.3 幂等

同一 taskId 重复调用 → **不创建第二个 PR**，返回已存在的那个。
判据：先按 head 分支查询现有 PR。

---

## 5. 验收标准

**所有 push/PR 测试都用本地 bare 仓库，不触真实网络。**

### 5.1 凭据

| # | 断言 |
|---|---|
| AC-S3-1 | token 文件缺失 → fail closed，且**不产生任何网络调用** |
| AC-S3-2 | **token 绝不出现在**：`.git/config`、job 环境变量、任何日志行、任何返回给调用方的错误消息 |
| AC-S3-3 | 构造一个回显 token 的上游错误响应 → 最终消息**不含该 token 的任何片段** |

### 5.2 push

| # | 断言 |
|---|---|
| AC-S3-4 | push 到本地 bare 后，**bare 仓库里该分支的 sha 等于任务分支的 sha** |
| AC-S3-5a | 目标不匹配 `grande/*` → **拒绝，且 bare 仓库无任何变化**（白名单生效） |
| AC-S3-5b | 目标匹配 `grande/*` **但等于 remote 默认分支** → 仍拒绝（第③条纵深防御生效） |
| AC-S3-6 | 无 commit 的任务 → 拒绝，说明先 commit |
| AC-S3-7 | 没有 remote → 拒绝并说清 |
| AC-S3-8 | **`pre-push` hook 不执行**（形状同 S2 的 AC-S2-1：hook 写标记文件，断言文件不存在）。⚠️ 这条与 AC-S2-1 一样**在沙箱内是假阴性**，见 §6 |

### 5.3 PR 与工具注解

| # | 断言 |
|---|---|
| AC-S3-9 | PR 恒为 draft |
| AC-S3-10 | body 里模型伪造的 `Grande-Attestation:` 被剥掉，最终只出现一次且值由服务端决定 |
| AC-S3-11 | 同一 taskId 重复调用不创建第二个 PR |
| AC-S3-12 | **两个**新工具的 `openWorldHint` 都是 `true`；此前 13 个工具仍全部 `false` |
| AC-S3-13 | git 调用里出现清空 ambient credential helper 的参数——**不继承宿主凭据** |

### 5.4 四类探针

**P-A 接线** · **P-B 反向测试** · **P-C 同源漏改**（每一条 git 调用是否都带
`-c core.hooksPath=/dev/null`？每一处凭据使用是否都脱敏？）· **P-D 安全边界**

### 5.5 Load-bearing（必做三条）

| # | 改坏什么 | 应该红的 |
|---|---|---|
| 1 | 去掉 `grande/*` 白名单判据 | AC-S3-5a |
| 2 | 去掉错误消息脱敏 | AC-S3-3 |
| 3 | 允许 draft 参数为 false | AC-S3-9 |

---

## 6. ⚠️ 已知：AC-S3-8 在沙箱内无法证明

**与 S2 的 AC-S2-1 完全同源。** 沙箱的 `process-exec` 白名单会让 worktree 里的
hook 静默不执行（`execvp() failed: Operation not permitted`），所以这条 load-bearing
在 `unit-selfhost` 里是**假阴性**——有没有防护测试都绿。

**实现者：撞到这条时不要停机，也不要用形状断言绕过。**
如实记录「该证明需在沙箱外完成」，继续往下做，最后在报告里列出来。
Human Owner 会在沙箱外补。（S2 那轮实现者在此停机是对的——因为当时它不知道这是
已知限制；现在它知道了。）

---

## 7. Human Owner 已确认（2026-07-30）

| # | 决定 |
|---|---|
| 1 | **用专用 fine-grained PAT**，三项权限（Metadata:R / Contents:RW / Pull requests:RW），只授权已注册仓库。放 `~/.grande-control/secrets/github-token`，`chmod 600` |
| 2 | **不做 CI 状态查询** —— 两个已注册仓库都没有任何 CI（实测确认） |
| 3 | **`grande-gpt` 建 remote 与本切片无关**，已从问题清单移除。备份是独立议题——且真正不可重建的是控制平面（审计账本 146 行、checkpoints），不是代码 |

| 4 | **不做 `protectedBranches` 配置项。** 改用白名单 `grande/*`（§3.1）——黑名单要求枚举「所有不该碰的」，永远不可能完整；白名单只要枚举「唯一该碰的」，而那个精确已知 |

**本切片已无待定配置项。**
