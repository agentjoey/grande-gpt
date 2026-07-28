# S0-D E2E 闭环观察记录

| | |
|---|---|
| **执行日期** | 2026-07-28 |
| **切片** | s0d-6-e2e |
| **自动化测试** | `tests/e2e.test.ts`（10 tests，435 tests total across 24 files） |

---

## 一、自动化 E2E 测试

### 1.1 测试覆盖的闭环

在 fixture 仓库上跑通了完整工具闭环：

```
task_open → repo_read → repo_edit → grande_run → grande_run_result（失败）
         → repo_edit → grande_run → grande_run_result（通过）
```

**10 个测试**覆盖以下维度：

| # | 测试 | 覆盖 |
|---|------|------|
| 1 | 完整闭环（8 步） | `task_open` → `repo_read` → `repo_edit` → `run` → `run_result(fail)` → `repo_edit` → `run` → `run_result(pass)` |
| 2 | 六个只读工具信封 | `task_status` / `repo_map` / `repo_search` / `repo_read` / `diff` / `run_result` |
| 3 | taskId 全链路一致性 | `task_open` → `repo_edit` → `grande_run` → `run_result` 四步 taskId 不变 |
| 4 | edit-run 闭环（独立 task） | 同一个 task 上 edit → run(fail) → edit → run(pass) |
| 5 | repo_search 验证落盘 | `repo_edit` 创建文件后 `repo_search` 可搜到 |
| 6 | AC-11 reconcile | `reconcileRunningJobs` 在工具调用前标记已死 job 为 killed |
| 7-10 | truncated 字段顺序 | `repo_map` / `repo_search` / `repo_read` / `run_result` |

### 1.2 关键技术发现

#### 发现 1：`repo_edit` 与 `grande_run` 操作不同目录

- `repo_edit` 通过 `resolveRepoPath` 操作 `{workspaceRoot}/{repoId}`（canonical 仓库）
- `grande_run` 以 `cwd: worktreePath` 运行，位于 `{worktreesRoot}/{repoId}/{taskId}`
- 二者物理路径不同，`repo_edit` 的改动不会直接出现在工作树内

**解法**：E2E 测试中，profile 命令通过**绝对路径**引用 repo 内的脚本文件。沙箱的 `(allow file-read*)` 全局规则允许读取 canonical 仓库路径（未被 `worktreesRoot` / `controlRoot` deny 覆盖）。

#### 发现 2：沙箱中 `/dev/null` 不可达

`(deny default)` 默认拒绝所有未显式放行的操作。`2>/dev/null` 这类常见 shell 重定向在沙箱中会触发 `Operation not permitted`，导致命令意外失败。

**解法**：E2E 测试中的 shell 脚本改用 `read` 内置命令替代 `head` + `/dev/null` 重定向：
```sh
read line < '/path/to/file'   # shell builtin, no /dev/null needed
```

#### 发现 3：`grande_run_result` 对 exit ≠ 0 仍返回 `ok: true`

`jobStateToError()` 只对 `timeout` 和 `killed+rss` 返回 ToolError。普通 `failed`（exit 1）是正常的 job 结果——job 基础设施成功运行了，只是被测试的命令返回了非零退出码。`ok: true` 配合 `data.state: "failed"` 和 `data.exitCode: 1` 是正确的协议设计。

### 1.3 关键 sandbox 行为确认

| 场景 | 沙箱行为 | 确认 |
|------|----------|------|
| 读取 workspace 下文件 | `(allow file-read*)` 全局放行 | PASS — profile 命令成功读取 `check-status.sh` 和 `status.txt` |
| 执行 `/bin/sh` | `/bin` 在 `execRoots` 内 | PASS — 10 个 E2E 测试全部通过 |
| `read` 内置命令 + `<` 重定向 | shell 内置，不触发额外 exec | PASS |
| `/dev/null` 访问 | `(deny default)` 拒绝 | CONFIRMED — 第一次失败就是此原因 |

---

## 二、人工 ChatGPT 观察模板

> **状态：待执行。** 以下为观察框架——人工在 ChatGPT 对话中完成闭环时填入。

### 2.1 观察矩阵

| # | 观察项 | 记录位置 |
|---|--------|----------|
| 对话轮数 | 从任务创建到最终 run_result 通过，经历了几轮对话？ |  |
| 确认框次数 | 写操作出现几次确认弹框？是否 app 级还是工具级？ |  |
| 模型选错工具 | 模型是否有选择了错误工具后自我纠正的情况？次数？ |  |
| taskId 丢失 | taskId 是否在任何一步被模型遗忘或替换？ |  |
| 自主轮询 | 模型是否在 `grande_run` 后自主调用 `grande_run_result` 轮询？间隔？ |  |
| 截断续读 | 模型是否在收到 truncated 后正确使用 cursor/lineRange 续读？ |  |

### 2.2 参考基准

基于 POC 第一轮（2026-07-26，Sol）的数据作为对照：

| 指标 | POC 第一轮值 |
|------|-------------|
| 对话轮数 | 5 条用户消息（含 17 次最长自主链） |
| 确认框 | 整轮 1 次 app 级 |
| 选错工具 | 0 次 |
| taskId 丢失 | 0 次（40/40 含最后一次） |
| 自主轮询 | 4/4 jobs，间隔 3–6s |
| 截断续读 | 5 次截断 → 8 次续读 |

本轮的「人工闭环」应作为第二轮数据填入，并与基准对比。

---

## 三、AC-13 交付物

**规格 §9.2**：AC-13 的观察记录直接决定 S1–S5 的工具设计，必须成文留存。

本文件即为 AC-13 的**程序化部分**交付物。人工观察部分待人来完成表格填写。关键发现（目录分离、沙箱限制）已记录在第一部分，供 S1 工具设计时参考。
