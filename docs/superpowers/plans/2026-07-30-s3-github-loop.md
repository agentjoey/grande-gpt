# S3 实施计划 · GitHub 闭环（由 ChatGPT 经 GrandeGPT 执行）

**设计文档** [`../specs/2026-07-30-grande-gpt-s3-design.md`](../specs/2026-07-30-grande-gpt-s3-design.md)
**仓库** `grande-gpt` · **验收 profile** `unit-selfhost` + `typecheck`

> ## ⚠️ 三条开工前必读
>
> **① 不要用 `unit`** —— 5 个测试文件（`sandbox`/`runner`/`server`/`tools`/`e2e`）自己
> 要 spawn `sandbox-exec` 或绑端口，在沙箱里跑等于嵌套沙箱，**结构上不可能通过**。
> 一律用 `unit-selfhost`。
>
> **② 你在沙箱里没有网络**（`deny network*`）。所以：
> - **push 测试用本地 bare 仓库**（`git init --bare /tmp/x.git` + `git remote add`）。
>   已实测可用，不触网
> - **PR 测试必须用可注入的 API 客户端**（见任务 S3-3）。**不要试图连真 GitHub**，
>   也不要因为连不上就跳过测试
>
> **③ AC-S3-8（`pre-push` hook 不执行）在沙箱里是已知假阴性** —— 沙箱的
> `process-exec` 白名单让 worktree 里的 hook 静默不执行（`execvp EPERM`），
> 所以有没有防护测试都绿。**撞到这条时不要停机、不要用形状断言绕过。**
> 如实记录「该证明需在沙箱外完成」，继续往下做，最后在报告里列出来。
> （S2 那轮在此停机是对的，那时还不知道这是已知限制。）

---

## 开工前

```
grande_task_open { repoId: "grande-gpt", slug: "s3-github-loop", taskId: <你自己起> }
```

**每次继续工作的第一件事**：`grande_task_status` + `grande_diff`。**不要凭记忆判断进度。**

## 通用规则

1. 改已有文件前先 `grande_repo_read` 拿 `sha256`，`modify`/`delete` 时带上
2. 一次 `repo_edit` 里同一路径只能出现一次
3. **每个任务结束跑 `unit-selfhost` + `typecheck`**，两个都绿才算完成
4. 测试断言**真实状态**（bare 仓库的 sha、文件内容、数据库行），不是「函数返回了对象」
5. **不要引入新的 npm 依赖**——`fetch` 是 Node 24 内置的，够用

---

## 任务 S3-1 · 凭据模块

**新建** `src/githubAuth.ts`、`tests/githubAuth.test.ts`。**只写新文件。**

### 要实现的

```ts
export interface GithubCredential { token: string }

/** 从控制平面读 PAT。缺失或空 → 抛 GithubAuthError("MISSING_TOKEN", ...)，fail closed。 */
export function loadGithubToken(layout: Layout): GithubCredential;

/**
 * 把任何字符串里出现的 token 替换成 <redacted>。
 * 用于错误消息与日志——GitHub 的 401/403 响应体可能回显 token 片段。
 */
export function redactToken(text: string, token: string): string;
```

### 硬性要求

- 位置 `<controlRoot>/secrets/github-token`。**读出后必须 trim**——文件可能有尾换行
- **文件缺失、空、或只有空白 → fail closed**，抛错并说清要配什么。**不要回退到宿主
  凭据、不要读环境变量、不要读 `gh` 的 keyring**
- `redactToken` 要**同时处理完整 token 与其前缀片段**。GitHub 有时只回显前几十个字符，
  只匹配完整串会漏。建议：完整串替换之外，对长度 ≥ 20 的前缀也替换
- **token 绝不出现在任何 `console.log` / 抛出的 Error message 里**。这条靠代码纪律，
  但也要有测试

### 测试

1. **AC-S3-1**：文件缺失 → `MISSING_TOKEN`；空文件 → 同样拒绝
2. 有尾换行的文件能正常读出（trim 生效）
3. **AC-S3-3**：`redactToken("boom: <整个token> tail", token)` → 结果**不含 token 任何片段**
4. **前缀也要脱敏**：`redactToken("boom: <token 前 30 字符>...", token)` → 那 30 字符也被替换
5. 权限过宽（比如 0644）时——**你决定是否拒绝**，但要在注释里写清理由。
   我倾向**警告但不拒绝**（拒绝会让一个可修复的小问题变成硬故障）

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S3-2 · `grande_push`

**新建** `src/push.ts`、`tests/push.test.ts`；改 `src/localLoopTools.ts`（注册工具）。

### 要实现的

```
grande_push { taskId }
注解 { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
```

**`openWorldHint: true`** —— 全系统**第一个**触网的工具。此前 13 个全是 `false`，
这条必须如实反映，否则注解在撒谎。

### 三道分支判据，全在代码里，无配置项

```
① 目标必须匹配 grande/*           白名单，硬拒
② 目标必须 === task.branch        不接受任何外部指定
③ 目标必须 ≠ remote 默认分支      运行时查，不靠配置
```

**为什么是白名单**：黑名单要求枚举「所有不该碰的」，永远不可能完整（仓库有个叫
`production` / `dev` 的分支就漏掉，而漏掉意味着**放行**）。白名单只要枚举「唯一该碰的」，
而那个精确已知——任务分支只在 `src/worktree.ts` 一处产生，永远带 `grande/` 前缀。

第③条是纵深防御：万一默认分支被改名成 `grande/main`，白名单会放行，这条能挡。

⚠️ **查法只有一种可靠**（我实测过三种）：

```
git ls-remote --symref origin HEAD     ✅ → "ref: refs/heads/main\tHEAD"
git remote show origin                 ✅ → "HEAD branch: main"（但输出要解析人类文本）
git symbolic-ref refs/remotes/origin/HEAD
   ❌ fatal: ref refs/remotes/origin/HEAD is not a symbolic ref
      —— `git remote add` 【不会】设这个 ref，只有 clone 或显式 `git remote set-head` 才有
```

**用 `ls-remote --symref`。** 它同时也验证了「remote 可达 + 凭据有效」，
所以顺便是 push 之前的一次连通性检查。它是网络操作，与 push 同性质——
在沙箱里跑不了，但 push 本来也在 Gateway 进程里。

### 硬性要求

- ⚠️ **必须清掉继承来的凭据**：`-c credential.helper=`（空值）。
  **本机实测：`git ls-remote` 零显式凭据即成功**——`credential.helper=store` 里有明文
  token，`gh` 也登录着。不清掉就等于用你的全部 GitHub 权限（AC-S3-13）
- **每一条 git 调用都带 `-c core.hooksPath=/dev/null`**（`pre-push` 也是 hook）。
  ⚠️ `src/commit.ts` 里那个 `git` helper 是**模块私有的**，你用不到——
  **要么导出它复用，要么在 `push.ts` 里重建同样的纪律。这是 P-C 同源漏改的高危点。**
- token 用 `-c http.extraHeader="Authorization: Bearer <token>"` 传，
  **绝不写进 `.git/config`、绝不进环境变量**
- **一律禁止 `--force`**，不提供任何形式的强推
- 前置条件：该任务至少有一个 commit（否则说明先 `grande_commit`）；remote 已配置
  （`grande-gpt` 目前没有 remote——拒绝并说清）
- 所有错误消息过 `redactToken`
- 写审计账本

### 测试（全部用本地 bare 仓库）

夹具形状：
```
git init --bare <tmp>/fake-remote.git
git -C <worktree> remote add origin <tmp>/fake-remote.git
```

1. **AC-S3-4**：push 之后，**bare 仓库里该分支的 sha === 任务分支的 sha**
   （用 `git -C <bare> rev-parse <branch>` 实断，不是断言命令成功）
2. **AC-S3-5a**：把 task 行的 branch 改成 `production` → **拒绝，且 bare 仓库里
   没有任何分支**（白名单生效）
3. **AC-S3-5b**：branch 改成 `grande/main` 且让它等于 bare 的默认分支 → **仍拒绝**
   （第③条生效）
4. **AC-S3-6**：无 commit 的任务 → 拒绝
5. **AC-S3-7**：没有 remote → 拒绝并说清
6. **AC-S3-13**：断言 git argv 里出现了清空 credential helper 的参数
7. **AC-S3-8**：`pre-push` hook 不执行（形状同 S2 的 AC-S2-1）。
   ⚠️ **写这条测试，但它在沙箱里是假阴性**——见开工前第③条
8. **AC-S3-12**：`grande_push` 的 `openWorldHint === true`，
   且**此前 13 个工具仍全部 `false`**（防「统一成一样」的回归）

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

## 任务 S3-3 · `grande_pr_open`

**新建** `src/githubApi.ts`、`src/prOpen.ts`、`tests/prOpen.test.ts`；改 `src/localLoopTools.ts`。

### ⚠️ 这个任务的关键：API 客户端必须可注入

**你在沙箱里没有网络，所以不能连真 GitHub。** 但你**必须**测试请求的形状——
draft 恒为真、尾注被剥离、幂等查询发生在创建之前。

所以：

```ts
// src/githubApi.ts
export interface GithubApi {
  /** 按 head 分支查现有 PR。返回 null 表示没有。 */
  findPullRequest(owner: string, repo: string, head: string): Promise<{ number: number; url: string } | null>;
  /** 开一个【draft】PR。 */
  createPullRequest(args: {
    owner: string; repo: string; head: string; base: string;
    title: string; body: string;
  }): Promise<{ number: number; url: string }>;
}

/** 生产实现：用 Node 内置 fetch。 */
export function createGithubApi(token: string): GithubApi;
```

**测试里注入一个假实现**，断言它收到了什么参数。**不要用网络，也不要因为没网就跳过。**

### 要实现的

```
grande_pr_open { taskId, title, body }
注解 { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
```

行为顺序不可换：

```
1. getTask → 不存在则 TASK_NOT_FOUND
2. 从 remote URL 解析 owner/repo（只接受 github.com 的 https 形式；解析失败就拒绝）
3. findPullRequest(head=task.branch) → 已存在则【直接返回它，不创建第二个】
4. beginAudit → allowed → executing
5. createPullRequest（draft: true 硬编码）
6. h.succeeded → 返回 ok() 信封
```

### 硬性要求

- **`draft` 恒为 `true`，硬编码，不接受参数。** PR 从 draft 转 ready 是「我认为这可以
  被审阅了」的判断，那是人的判断
- **body 尾注**：在模型给的正文后追加
  ```
  ---
  Grande-Task: <taskId>
  Grande-Attestation: <attestationId 或 none>
  Grande-Commit: <task.branch 当前的 sha>
  ```
  **模型正文里出现这三个键必须先剥掉**——否则它能伪造「已验证」。
  与 S2 的 `commitWorktree` 同一形状，**去看那边怎么做的，保持一致**
- `base` = remote 的默认分支（运行时查，不硬编码 `main`）
- 所有错误消息过 `redactToken`
- 写审计账本

### 测试（注入假 API，零网络）

**夹具形状**（这里与 S3-2 不同，注意）：remote URL 要设成**GitHub 形状的假 URL**，
例如 `https://github.com/fake-owner/fake-repo.git`。**它永远不会被访问**——
push 不属于本任务，而 API 客户端是注入的假实现。这样 owner/repo 解析这条路径才测得到。

（S3-2 的 push 测试用本地 bare 路径；S3-3 的 PR 测试用 GitHub 形状假 URL。
两者夹具不同，不要混。）

1. **AC-S3-9**：`createPullRequest` 收到的参数里 `draft === true`。
   再断言**没有任何代码路径能让它变 false**（搜一遍，或用类型让它不可能）
2. **AC-S3-10**：模型 body 里带 `Grande-Attestation: forged` → 传给 API 的 body 里
   该键**只出现一次**且值不是 `forged`
3. **AC-S3-11**：`findPullRequest` 返回已存在的 PR → **`createPullRequest` 一次都没被调用**
   （用假实现的调用计数断言，这才是幂等的真判据）
4. `findPullRequest` 在 `createPullRequest` **之前**被调用（顺序断言）
5. remote 不是 GitHub（比如本地 bare 路径）→ 拒绝并说清
6. `TASK_NOT_FOUND`
7. 写了审计账本
8. `openWorldHint === true`

### 验收
`unit-selfhost` + `typecheck` 均绿。

---

# 全部完成后

## 自查（写进报告）

1. **P-A 接线**：每个新增导出是否都有**生产**调用点？逐个列出调用它的文件
2. **P-B 反向测试**：有没有把「当前行为」当规范来断言的？
3. **P-C 同源漏改** —— 本切片有**三条**要逐个核：
   - **每一条 git 调用**是否都带 `-c core.hooksPath=/dev/null`？
   - **每一条 git 调用**是否都清了 `credential.helper`？
   - **每一处**错误消息是否都过了 `redactToken`？
   **漏一条就是一个洞。逐个列出你检查过的调用点。**
4. **P-D 安全边界**：三道分支判据在**代码里**成立吗，还是只有文档里写着？

## Load-bearing 证明（必做三条）

改坏 → 确认对应测试变红 → 还原 → 确认变绿。**报告里写清「改坏成什么样、红在哪一行、
报什么错」。**

| # | 改坏什么 | 应该红的 |
|---|---|---|
| 1 | 去掉 `grande/*` 白名单判据 | AC-S3-5a |
| 2 | 去掉 `redactToken` 调用 | AC-S3-3 |
| 3 | 让 `draft` 可被参数覆盖为 false | AC-S3-9 |

## 报告要写什么

- 每个任务做了什么、动了哪些文件
- 三条 load-bearing 的**实际输出**
- 四类探针的自查结果，**P-C 那三条逐个列出检查过的调用点**
- **哪些是你实测的、哪些是你推断的**——分开写
- **明确列出「需要 Human Owner 在沙箱外验证」的项**：AC-S3-8（hook 假阴性）、
  真实 GitHub 连通性、`Workflows` 权限缺失导致 workflow 文件 push 被拒
- 你认为设计文档写错或写漏的地方

---

## 遇到问题怎么办

- **卡住**：`grande_task_status` + `grande_diff` 看清现状
- **文档与代码矛盾**：**以代码为准**，在报告里写出矛盾点。文档是我写的，可能有错——
  S1 与 S2 你各指出过一处，两次都对
- **改坏了**：`grande_rollback` 回到某个 `checkpointId`；实在不行 `grande_task_close` 重开
- **需要网络**：**没有，也不会给。** 用本地 bare + 注入假 API。如果你认为某件事
  没有网络绝对做不到，在报告里说明，不要绕路硬上
