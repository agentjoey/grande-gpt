# s05-2-sandbox-git — 让 `git` 在 Seatbelt 沙箱里可用

**归属**：S0.5 可用性收尾。

## 现状与根因（orchestrator 已实测复现，不要重新猜）

不修的后果：**没法用 GrandeGPT 开发 GrandeGPT**——本仓库自身有 6 个测试文件调真实
`git`，在沙箱里全部失败。自举是最重要的数据来源。

用真实 `buildProfile()` 生成的 SBPL 复现，失败是**两层**：

```
$ sandbox-exec -f <真实profile> /usr/bin/git -C <worktree> status --short
git: warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR
git: error: couldn't create cache file '/tmp/xcrun_db-jBnlIs96' (errno=Operation not permitted)
git: error: couldn't spawn '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild'
git: error: unable to locate xcodebuild, please make sure the path to the Xcode folder is set correctly!
```

**第一层**：`/usr/bin/git` 不是 git，是 `xcrun` shim。它要写 `DARWIN_USER_TEMP_DIR`
缓存、再 exec `Xcode.app` 里的 `xcodebuild` 去定位真实工具链。

**第二层**：绕开 shim、直接 exec 真二进制
`/Applications/Xcode.app/Contents/Developer/usr/bin/git` 之后，剩下：

```
fatal: could not open '/dev/null' for reading and writing: Operation not permitted
```

## 已验证的最小修法（orchestrate 已实测通过，照做）

**① 解析到真实 git 二进制，不走 `/usr/bin/git` shim。**

`src/sandbox.ts` 里已经有完全相同的原则与现成机制——`PACKAGE_MANAGER_BINARIES` +
`resolveBinaryDirs()`，注释里写着「解析到真实二进制，比 PATH 查找更权威」。
**把 `git` 纳入同一机制**，让它的真实所在目录进 `execRoots`（从而也自动进 PATH）。

⚠️ **绝对不要**把 `/Applications/Xcode.app` 整个 `subpath` 放进沙箱——那是巨大的
攻击面，而且没必要：只需要那**一个 bin 目录**。

⚠️ 解析必须是**运行时**的，不能硬编码 `/Applications/Xcode.app/...`。别的机器可能是
Command Line Tools（`/Library/Developer/CommandLineTools/usr/bin/git`）或 Homebrew git。
`resolveBinaryDirs` 已经处理这类分歧，沿用它。仓库里有一条既有教训：
`defaultExecRoots` 早先硬编码 `/opt/homebrew`，计划文档因此被改过一次。

**② 放行 `/dev` 下的三个字符设备**（`src/sbpl.ts`）：

```
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read*             (literal "/dev/urandom") (literal "/dev/random"))
```

用 `literal` 不用 `subpath`——`(subpath "/dev")` 会把整个设备树放进来。

## 修完必须成立（orchestrator 实测过，你要复现出同样结果）

正向——这四条在沙箱里都要成功：
```
git status --short      → 空输出（干净）
git log --oneline -1    → 5318add docs: add HANDOFF.md for agent handoff  （形如）
git rev-parse HEAD      → 40 位 sha
git diff --stat HEAD    → 正常
```

反向——沙箱**不能因此被放松**，这两条必须仍然失败：
```
sh -c 'echo x > ~/pwned.txt'          → Operation not permitted
git ls-remote https://github.com/...  → cannot exec 'git-remote-https': Operation not permitted
```

## 测试要求

### `tests/sbpl.test.ts`
- 生成的 profile 含 `/dev/null` 的读写放行，且**不含** `(subpath "/dev")`
- `execRoots` 里出现真实 git 所在目录

### `tests/sandbox.test.ts`（**真跑沙箱，不是断言字符串**）
本文件已有真实 `sandbox-exec` 用例（S0-C 的 U2 spike 建立的范式），照它写：
1. 沙箱内 `git rev-parse HEAD` 返回 40 位 sha —— **这是本任务的核心行为断言**
2. 沙箱内 `git status --short` 在干净 worktree 上返回空
3. **反向**：沙箱内写 worktree 之外的路径仍被拒
4. **反向**：沙箱内 `git ls-remote <https url>` 仍失败（网络仍被拒）

第 3、4 条是**必须的**——没有它们，这个任务在审查眼里就是「为了让 git 跑起来
把沙箱拆了」。规格 §4 的最小权限原则要求每条新增放行都能说清为什么。

## 硬性约束

- **只改 `src/sandbox.ts` 与 `src/sbpl.ts`**。不要碰 `src/tools.ts`（s05-1 的范围）、
  不要碰 `src/cli.ts`（s05-3 的范围）
- 每条新增的 SBPL 规则都要在代码注释里写清**为什么需要它**、**为什么这个范围是最小的**。
  `src/sbpl.ts` 现有注释就是这个标准，照着写
- 记住 macOS SBPL 语义：**最具体的规则胜出，不是书写顺序胜出**

## verify

`pnpm test && pnpm typecheck`

## 完成前必做

1. **Load-bearing 证明**：把 `/dev/null` 放行删掉，确认「沙箱内 git rev-parse」变红；
   把 git 从 execRoots 摘掉，确认同样变红。还原后确认变绿
2. **最小性证明**：对你新增的每一条放行，说明删掉它之后哪条测试会红。
   删掉不影响任何测试的规则**不要留**
3. 全量 `pnpm test` + `pnpm typecheck`
4. 报告里贴出正向 4 条与反向 2 条的**真实输出**，不要只写「通过」
