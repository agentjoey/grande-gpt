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
| ④ | `grande_ci_status` —— 查该 PR 的 CI 结论 |

**不做**：合并 PR（那是人的决定）；review 评论的读写；issue 操作；任何对 `main`
或受保护分支的直接写入。

---

## 2. 凭据：GitHub App 还是 PAT

**建议用 fine-grained PAT，不用 GitHub App。理由如下，请 Human Owner 确认。**

| | GitHub App | fine-grained PAT |
|---|---|---|
| 权限粒度 | 更细，可按仓库授权 | 也可按仓库授权 |
| 实现成本 | 需要 JWT 签名 + installation token 交换，**规格 §138 已经为它预留了 `secrets/` 目录** | 一个字符串 |
| 令牌轮换 | 自动（1 小时） | 手动 |
| **单用户场景的实际收益** | **接近零**——App 的价值在于「代表多个安装方行事」，而 D2 明确单用户 | — |

规格 §10 的原话是「GitHub App」，但那是在 D2（单用户）之前的通用写法。
**在单用户前提下 App 的复杂度换不来对应的安全收益**，而 PAT 的过期风险可以用
「fail closed + 明确的过期错误码」覆盖。

**如果 Human Owner 坚持 App，本切片人日要往上调**（JWT 签名、installation token
缓存与刷新、时钟偏移处理），且实现者无法测试真实交换流程。

### 2.1 凭据的存放与使用（无论哪种）

- 位置：`~/.grande-control/secrets/github-token`，**权限 0600**
- **绝不写进 `.git/config`**（那会落到仓库里）、**绝不进 job 环境变量**、
  **绝不出现在任何日志或错误消息里**
- 用 `-c http.extraHeader=...` 或 `credential.helper` 的临时形式传给单次 git 调用
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

### 3.1 只推任务分支

推送目标**恒为 `task.branch`**（`grande/<slug>-<后缀>`），不接受分支参数。

**必须显式拒绝的**：目标分支名等于 remote 的默认分支、或匹配一个受保护分支模式列表。
这不是「不太可能发生」——一次 taskId 碰撞或一个被投毒的配置就够了。
**判据要在代码里，不能只写在文档里。**

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

## 5. `grande_ci_status`

```
grande_ci_status { taskId }
注解 { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
```

只读，但触网，所以 `openWorldHint: true`。

返回该 PR head sha 上的 check runs 汇总：`{ state, checks: [{ name, conclusion }] }`。
**不做轮询**——模型自己会轮询（P-1 已实测），工具只管返回当下状态。

---

## 6. 验收标准

**所有 push/PR 测试都用本地 bare 仓库，不触真实网络。**

### 6.1 凭据

| # | 断言 |
|---|---|
| AC-S3-1 | token 文件缺失 → fail closed，且**不产生任何网络调用** |
| AC-S3-2 | **token 绝不出现在**：`.git/config`、job 环境变量、任何日志行、任何返回给调用方的错误消息 |
| AC-S3-3 | 构造一个回显 token 的上游错误响应 → 最终消息**不含该 token 的任何片段** |

### 6.2 push

| # | 断言 |
|---|---|
| AC-S3-4 | push 到本地 bare 后，**bare 仓库里该分支的 sha 等于任务分支的 sha** |
| AC-S3-5 | 目标是默认分支或受保护模式 → **拒绝，且 bare 仓库无任何变化** |
| AC-S3-6 | 无 commit 的任务 → 拒绝，说明先 commit |
| AC-S3-7 | 没有 remote → 拒绝并说清 |
| AC-S3-8 | **`pre-push` hook 不执行**（形状同 S2 的 AC-S2-1：hook 写标记文件，断言文件不存在）。⚠️ 这条与 AC-S2-1 一样**在沙箱内是假阴性**，见 §7 |

### 6.3 PR / CI

| # | 断言 |
|---|---|
| AC-S3-9 | PR 恒为 draft |
| AC-S3-10 | body 里模型伪造的 `Grande-Attestation:` 被剥掉，最终只出现一次且值由服务端决定 |
| AC-S3-11 | 同一 taskId 重复调用不创建第二个 PR |
| AC-S3-12 | 三个新工具的 `openWorldHint` 都是 `true`；此前 13 个工具仍全部 `false` |

### 6.4 四类探针

**P-A 接线** · **P-B 反向测试** · **P-C 同源漏改**（每一条 git 调用是否都带
`-c core.hooksPath=/dev/null`？每一处凭据使用是否都脱敏？）· **P-D 安全边界**

### 6.5 Load-bearing（必做三条）

| # | 改坏什么 | 应该红的 |
|---|---|---|
| 1 | 去掉受保护分支的拒绝判据 | AC-S3-5 |
| 2 | 去掉错误消息脱敏 | AC-S3-3 |
| 3 | 允许 draft 参数为 false | AC-S3-9 |

---

## 7. ⚠️ 已知：AC-S3-8 在沙箱内无法证明

**与 S2 的 AC-S2-1 完全同源。** 沙箱的 `process-exec` 白名单会让 worktree 里的
hook 静默不执行（`execvp() failed: Operation not permitted`），所以这条 load-bearing
在 `unit-selfhost` 里是**假阴性**——有没有防护测试都绿。

**实现者：撞到这条时不要停机，也不要用形状断言绕过。**
如实记录「该证明需在沙箱外完成」，继续往下做，最后在报告里列出来。
Human Owner 会在沙箱外补。（S2 那轮实现者在此停机是对的——因为当时它不知道这是
已知限制；现在它知道了。）

---

## 8. 给 Human Owner 的问题

1. **PAT 还是 GitHub App？** §2 建议 PAT，理由是单用户场景下 App 的复杂度换不来
   对应收益。你如果坚持 App，请说明，我调整人日估算并重写 §2。
2. **受保护分支模式清单从哪来？** 建议控制平面配一个 `protectedBranches: [main, master, release/*]`，
   fail closed（配置缺失就拒绝所有 push）。
3. **`grande-gpt` 要不要建 remote？** 目前没有。不建的话本切片只能对本地 bare 测试，
   真实连通性由你手工验一次。
