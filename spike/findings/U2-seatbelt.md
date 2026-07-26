# U2 · Seatbelt 可行性 —— 结论：PASS

**日期** 2026-07-26 · **macOS 版本** 26.5.1 (25F80) · **靶子**：`poc/`（pnpm 10.33.0 安装，7 个测试文件，135 用例）
**Node** v24.14.0（原生 strip types，未加 `--experimental-strip-types`）· **pnpm** `10.33.0`，解析路径 `/Users/xtation/.local/bin/pnpm` → `~/.local/lib/node_modules/pnpm/bin/pnpm.cjs`
**本机 `defaultExecRoots()`**：`/usr/bin`, `/bin`, `/usr/sbin`, `/usr/local/bin`, `~/.local/lib/node_modules/pnpm/bin`, `/usr/local/lib/node_modules/npm/bin`

## 结论

**PASS**——在 `(deny default)` + `(deny network*)` 下，真实 pnpm 项目（`poc/`，135 用例）的 `pnpm test` 能完整跑通并全部通过。相对 Task 1 已验证的基线 profile，**PASS 判定所必需**的新增规则只有一条：放行 worktree 内 `node_modules/.bin` 的 `process-exec`（复核后从"放行整个 worktree"收窄到这一个子目录，效果不变，见下文"worktree 内 process-exec"一节）。另外采纳了一条 **PASS 判定不需要、但复核验证为安全、且消除了约 19 倍无意义等待**的规则：`(allow signal (target same-sandbox))`，安全性质与耗时数字见下文"signal"一节。pnpm 的全局 store 不需要放行——但"因为硬链接对文件系统透明"这个机制解释是错的，本轮用 `stat` 实测更正为 APFS clonefile，结论本身不受影响，见下文"pnpm store"一节。`deny default` / `deny network*` 全程原样保留，未做任何放宽。

## 最终放行清单（S0-C 直接照抄）

完整 profile 形状——基线部分继承自 Task 1（已有 23 项行为测试覆盖，此处不重新证明，只为"可直接照抄"而完整列出）。下表已逐条核对过 `buildProfile()` 的真实输出（`(version 1)` 是格式头不是安全规则，不占一行；其余 16 行规则，每一行都能在下表找到对应的一行或被合并进同一行）：

| 规则 | 为什么需要 | 不加会怎样 |
|---|---|---|
| `(deny default)` + `(deny network*)` | 硬约束的起点：默认拒绝一切，网络整体禁止 | 若省略等于没有沙箱——本次验证的前提就是二者原样保留、全程未松动 |
| `(allow file-read*)` 全局，挖掉 `controlRoot`/`worktreesRoot` 两个 subpath | node/npm/tsc/vitest 会读大量意料之外的系统路径（模块解析、locale 等），逐目录白名单会陷入无穷调试 | 几乎任何工具链命令都会因读不到某个路径而报错，且报错通常不会直接点名"是沙箱挡的" |
| **`(allow file-read* (subpath worktree))`** | **本轮复核补齐的缺失行**：生产环境的真实目录形状是 worktree 嵌在 `worktreesRoot` 之下（`worktreesRoot/<repo>/<task>/`）。上一行对 `worktreesRoot` 的 `deny` 会连带覆盖到嵌套在其中的本任务 worktree，这条 `allow` 靠"最具体规则优先"把它重新挖出来——没有这一行，`(deny file-read* (subpath worktreesRoot))` 会把自己的 worktree 也读不到 | 复核用嵌套布局（worktree = `worktreesRoot` 的子目录，与生产环境同形）实测：去掉这条规则后 `cat` 自己 worktree 内的文件直接 `Operation not permitted`（exit 1）——沙箱连自己的任务文件都读不到。**已知盲区**：本仓库现有的 `u2-real-vitest.test.ts` 用的是非嵌套布局（`worktree=poc/`、`worktreesRoot` 是无关空目录），去掉这条规则后该测试依然会通过（全局 `(allow file-read*)` 兜底）——这是当前测试覆盖的一个盲区，记录在案，不代表这条规则可有可无 |
| `(allow file-write* (subpath worktree))` + `(allow file-write* (subpath jobTmp))` | vitest 需要写 `.vite`/`.vite-temp` 缓存等临时产物 | vitest 启动阶段写缓存目录失败，直接 EPERM 退出 |
| `(deny file-write* (subpath canonicalGit))` + `(deny file-write* (subpath worktree/.git))` | canonical 仓库的 `.git`（hooks 等）为所有 worktree 共享；worktree 自己的 `.git` 是指向 canonical 的文件——改写任一个都能劫持后续 git 操作 | 本次实验里 `poc/` 不是 git worktree，这两条规则命中的是空占位目录，不影响 U2 判定；但生产环境这是完整性边界，必须保留 |
| `(allow process-exec ...execRoots)`，`execRoots` 由 `defaultExecRoots()` 按机器解析 | node/pnpm/npm/npx 与标准系统工具（sh、cat、env…）必须能被 exec；具体目录随安装方式变化，不能硬编码 | Task 1 已实测：硬编码 `/opt/homebrew` 在本机漏放行 `/usr/local/bin/node`，报 `Operation not permitted`（exit 71），会把"能不能跑"误判为"不能"——本任务继承这个教训，全程用 `defaultExecRoots()` |
| **`(allow process-exec (subpath worktree/node_modules/.bin))`** | pnpm/npm 把包的可执行入口（如 `node_modules/.bin/vitest`）生成为物理落在 worktree 内的 POSIX shell shim（不是符号链接出去的），`pnpm test` 经由该 shim 的 shebang 调起，因此 shim 自身必须可 exec。**本轮复核收窄**：原先放行整个 worktree，复核证明只放行 `node_modules/.bin` 即可得到完全相同结果（135/135、exit 0），已收窄到这一个子目录；已知局限（monorepo/workspace 未覆盖）见下文 | 去掉此规则：`sh: .../node_modules/.bin/vitest: /bin/sh: bad interpreter: Operation not permitted`，**exit code 126**（本轮复核对新规则重新做过 remove → fail → restore → pass，与首轮同一失败签名） |
| `(allow process-fork)` | vitest 默认 `pool: forks`（每测试文件一个真实子进程）必须能 fork | fork 被拒会让任何多进程 pool 直接失败 |
| `(allow sysctl-read)` | Node/V8 启动时探测 CPU 核数等常规调用 | 被拒通常表现为启动期的诡异报错，与"沙箱"两个字对不上号，容易被误诊为别的问题 |
| **`(allow signal (target same-sandbox))`** | **本轮复核新增，是这张表里唯一一条"PASS 判定不依赖它"的规则**：vitest 的 `forks` pool 收尾阶段要 `kill()` 自己 fork 出的子进程，`(deny default)` 默认拒绝这个自我发信号动作 | 不加不会导致 PASS 变 FAIL——只是慢且吵：135 用例套件耗时从 580ms（有这条规则）暴涨到 10702ms（没有，约 18.5 倍），且 stderr 会有 EPERM/超时噪音，容易被误诊成测试出了别的问题。三条已验证的安全性质见下文"signal"一节 |

**PATH 与 execRoots 同源**（Task 1 已修，此处复述因为它是 U2 能跑通的前提之一）：子进程的 `PATH` 环境变量由 `execRoots.join(":")` 派生，不是与 profile 平行的第二处硬编码——否则会出现"exec 权限有了，但 pnpm 的 `#!/usr/bin/env node` shebang 解析不到 node"这种更隐蔽的失败（exit 127，历史上真实出现过，见 commit `0391ebb`）。

### worktree 内 process-exec 收窄到 node_modules/.bin——安全取舍怎么权衡的

这是 brief 明确要求"诚实权衡"的一点，不是加规则了事。**上一版这里写"这条 allow 并未新增可达的攻击面"，这个说法不成立，已被复核用实测推翻，本节予以更正，而不是只软化措辞。**

**复核提供、本轮逐条重新验证过的证据**（数字与复核报告一致）：

- **narrower 规则不影响结果**：用同一份 135 用例套件验证，只放行 `node_modules/.bin` 而不是整个 worktree，结果完全相同——135/135 通过，exit 0。收窄没有牺牲任何已验证的功能。
- **真实边际效果的测量**：把一个新编译、未签名（ad-hoc 签名，非正式证书签名）的 Mach-O 二进制（`clang` 直接编译一个空 `main()`）放进 worktree：
  - 完全没有 worktree-exec 规则时，直接 exec 这个二进制：`sandbox-exec: execvp() of '.../probe-root' failed: Operation not permitted`，**exit 71**
  - 放行**整个 worktree**（旧规则）时，同一个二进制直接 exec 成功，**exit 0**
  - 只放行 `node_modules/.bin`（新规则）、二进制仍放在 worktree 根（不在 `.bin` 内）时：**仍是 exit 71**，跟完全没有规则时一样被拒；把同一个二进制挪进 `node_modules/.bin` 才能成功（exit 0）
- **对照：shell 脚本为什么"本来就能跑"是真的，但跟上面不是一回事**：同一个"完全没有 worktree-exec 规则"的沙箱里，`sh script.sh`（显式调解释器）能正常执行（输出 `script ran`，exit 0）——这条命令的 execve 目标是 `/bin/sh`，已经在 `execRoots` 里被信任，脚本内容只是被当数据 `read()` 进去，从未对 `script.sh` 这个文件本身发起 execve。但如果换成直接执行该脚本文件（触发内核处理 `#!` 这一步，对脚本文件自身发起 execve），同样"无 worktree-exec 规则"的条件下会被拒（同样 exit 71）——这正是 `node_modules/.bin/vitest` 会撞到的路径：pnpm 是通过 shim 文件自身的 execve 被内核调起的，不是通过某个已被信任的进程显式 `sh vitest`。

**结论（更正后）**：旧规则"放行整个 worktree"的真实边际效果是——**worktree 里任何位置放一个自包含可执行文件（不需要任何额外的受信任解释器）都能被直接启动**，这在收窄前是新增的能力：不放行时该二进制无法启动（exit 71），放行后可以（exit 0）。这与"反正 `pnpm test` 已经在跑图灵完备的 JS 代码，所以无所谓"是两件不同的事——JS 代码要经由已经被信任的 node 解释器读入执行，解释器本身已经在 `execRoots` 里；而一个自包含的编译好的二进制不需要任何受信任的中间解释器，属于"是否可以脱离受信执行器、直接跑一个任意二进制"这一类不同的能力。收窄前后的差别是真实、可测量的，不是形式主义。收窄到 `node_modules/.bin` 后，这个能力被限制到刚好覆盖 pnpm/npm 生成 shim 所需的那一个目录，worktree 其余位置新增可执行文件依旧被拒（同上，exit 71）。

其余边界原样保留、与这条规则正交，没有变化：

- `(deny network*)` 依然全局生效——`node_modules/.bin` 里的任何东西一样连不出网；
- `controlRoot`（审计/配置）与 `worktreesRoot` 之外的兄弟 worktree，读权限依然被排除在外；
- `canonicalGit` 与 `worktree/.git` 依然不可写。

**已知局限（不假装它能泛化）**：`.bin` 单目录放行是针对 `poc/` 验证的——`poc/` 不是 pnpm workspace（没有 `pnpm-workspace.yaml`，`node_modules/.bin` 只有一层，4 个 shim：`tsc`/`tsserver`/`vite`/`vitest`，均为物理 shell 脚本、非符号链接）。真实的 monorepo/pnpm workspace 会有多个 `packages/*/node_modules/.bin`，各自需要放行——这不是把这一行 `subpath` 换个路径就能覆盖的，需要递归匹配（按 workspace 清单枚举各包目录后逐条生成 `subpath` 规则，或换一种前缀匹配策略），是需要单独设计的后续工作。**S0-C 实现前必须先确认目标仓库的 workspace 布局，不能直接照抄这一行当成万能规则。**

### signal——为什么这轮加上了 `(allow signal (target same-sandbox))`

不影响 U2 本身的 PASS/FAIL——去掉这条规则，`pnpm test` 依然 exit 0、135 用例依然全过。这是上面清单里**唯一一条不满足"不加会 FAIL"标准、却仍然采纳**的规则，基于以下证据，本轮复核判断收益足够明确：

**现象与根因**：vitest 默认 `pool: forks`（`poc/vitest.config.ts` 未覆盖），全部测试跑完后主进程 `kill()` 自己 fork 出的 worker 子进程做收尾清理，这个自我发信号在 `(deny default)` 下被拒：

```
code: 'EPERM', syscall: 'kill'
[vitest-pool]: Timeout terminating forks worker for test files .../mcpResponse.test.ts.
...(7 个测试文件各一条)
```

之后 vitest 退回"等超时"的兜底路径，最终仍 exit 0、135 用例全过，但每个 worker 都要等一轮超时。

**本轮用真实 `poc/` 135 用例套件重新实测的耗时数字**（非模拟，两次独立测量）：

- 没有这条规则：`durationMs = 10702`（exit 0，135 passed，但 stderr 有上面那种 EPERM/超时噪音）
- 加上这条规则：`durationMs = 580`（无 EPERM/超时噪音，exit 0，135 passed）
- 约 **18.5 倍**（本轮实测），与首轮报告的约 19 倍（0.55s 宿主机 vs 10.7s 沙箱）量级一致，同一个瓶颈

**三条安全性质**（本轮复核用独立的手写 SBPL profile 重新验证，不依赖 `sbpl.ts` 里的实现代码，绕开被测代码本身做交叉验证，三条全部通过）：

1. **同一 sandbox 内自我发信号成功**：`sandbox-exec` 内 fork 一个 `sleep 30 &` 子进程后 `kill -TERM` 它——有这条规则时 `kill_exit=0`；没有这条规则时 `kill: Operation not permitted`，`kill_exit=1`（对照组，证明现象真实存在）。
2. **沙箱内进程碰不到沙箱外、哪怕同 uid 的宿主进程**：宿主机（不经 `sandbox-exec`）起一个 `sleep 60 &`，沙箱内进程（带这条规则）对它 `kill -0` → `Operation not permitted`，`kill_exit=1`；作为对照，同一个 `kill -0` 从沙箱外直接跑（不经 `sandbox-exec`，纯 Unix 同 uid 权限）→ 成功，`kill_exit=0`。证明 `same-sandbox` 是按"这次 `sandbox-exec` 调用生成的容器实例"区分，比同 uid 的 Unix 权限更严格，不是形同虚设。
3. **两个独立 `sandbox-exec` 调用互不能发信号**（模拟两个并发 job）：job A 对 job B 的 pid `kill -TERM` → `Operation not permitted`，`kill_exit=1`；job B 完整跑满自己的 12 秒 `sleep` 并写下收尾 marker 文件，证明没有被 job A 提前终止。

三条性质合起来说明：这条规则只让"进程能收拾自己 fork 出的子进程"这一件事成立，不会让任务间隔离或沙箱边界松动——收益（每个用 forks/多进程 pool 的 job 少等约 10 秒 + 干净的 stderr，并发场景下这个成本会累加）对应的代价是零可证明的越权能力，因此本轮予以采纳。

## pnpm store

**结论不变，机制解释有误，本轮已更正。**

上一版写"硬链接对文件系统透明"。复核指出：检查 `.pnpm/vitest@.../node_modules/vitest/` 下一个真实文件，`nlink=1`，在 `~/Library/pnpm/store` 下找不到匹配的 inode——这指向 **APFS clonefile**（macOS 上 pnpm 的默认导入方式之一），不是硬链接。本轮独立复现，用 `stat` 逐字核对（`poc/node_modules/.pnpm/vitest@4.1.10_.../node_modules/vitest/index.cjs`，以及 store 内经 `cmp -s` 确认字节级完全相同内容的对应文件）：

```
worktree 内 index.cjs：    device=16777232  inode=112879383  nlink=1  size=412
store 内容完全相同的文件： device=16777232  inode=89253919   nlink=1  size=412
```

两者是**同一个 device**（同一块卷，硬链接在技术上原本是可能的），但 **inode 不同**，且两边 `nlink` 都是 1。这与硬链接的定义直接矛盾——硬链接是同一个 inode 的另一个目录项，必然表现为**同一 inode、`nlink ≥ 2`**。这里观察到的是两个完全独立的 inode，只是内容字节级相同——与 APFS `clonefile()`（写时复制克隆）的行为一致：克隆出的文件是一个新的、独立的文件对象，`stat` 层面看不出和源文件有任何关联，只是底层存储块可能共享（这是文件系统内部实现，`stat` 的标准字段不会暴露，也不影响下面的安全结论）。

**为什么这不影响 PASS 结论**：无论是硬链接还是 clonefile，`pnpm test` 实际打开的文件都是 `worktree/node_modules/.pnpm/.../node_modules/vitest/...` 这个路径本身——它已经在 `(allow file-read* (subpath worktree))` 的放行范围内。Seatbelt 按路径做 subpath 匹配，不关心这个路径背后的 inode 是和另一个路径共享（硬链接）还是各自独立（clonefile）；两种机制下，沙箱内进程都从未需要真正打开 `~/Library/pnpm/store` 下的路径。因此**结论本身（S0-C 的放行清单不需要为 pnpm store 单独开一条规则）是稳固的**，本轮用 deny-store 测试在收窄+新增信号规则后的完整 profile 下重新验证过（两次独立重跑，逐字实测输出）：

```
第一次：exitCode = 0  killedBy = null  durationMs = 676   包含 '135 passed' true   包含 '7 passed' true
第二次：exitCode = 0  killedBy = null  durationMs = 598   包含 '135 passed' true   包含 '7 passed' true
```

两次结果一致，非偶然；耗时数字远低于首轮报告的 10687/10711ms——那是首轮尚未加 `(allow signal ...)` 时的数字（同一个 forks-pool 收尾超时问题），不是这次复核发现了新问题，只是这次的完整 profile 本身更快。**S0-C 的放行清单不需要为 pnpm store 单独开一条规则**——这避免了一条"以防万一"式、实际上从未被读到的放行，减少了不必要的攻击面。

## 资源兜底

- **RSS 轮询是否生效**：生效，但有实测量化的超调（overshoot）。用一个 `for(;;) a.push(Buffer.alloc(50MB))` 的紧凑分配循环、`maxRssMb=300` 作为阈值：`killedBy = "rss"`，进程组在 `durationMs ≈ 2033ms` 时被杀掉（对应代码里 `RSS_POLL_MS=2000` 的轮询周期——基本是第一次轮询就命中），但此时 `peakRssMb` 已经到 **1037 MB**，超过阈值约 3.5 倍。这是代码注释"这不是 cgroup——采样窗口内仍可冲高，是已接受的取舍"的量化版本：轮询确实会杀掉进程（不会无限跑下去），但对来势凶猛的分配模式，实际生效前的峰值可能是设定阈值的数倍。**给 S0-C 的建议**：`maxRssMb` 要按"host 实际可用内存 ÷ 3～4"左右的安全边际设置，不能卡着字面阈值设。（注：这个 3.5 倍只是这一种分配模式下的实测数据点，不是普适上界——见"未覆盖"一节。）
- **`RLIMIT_AS` 对 Node 24 是否可用**：**不可用，且与 Seatbelt 无关**——这是 macOS/XNU 内核层面的限制，不是 Seatbelt 挡的。沙箱内外用同一条 `ulimit -v 262144` 探测，得到完全相同的报错：

  ```
  ulimit: virtual memory: cannot modify limit: Invalid argument   (exit 1)
  ```

  在沙箱外单独验证过（不经 `sandbox-exec`，直接跑同一条命令），报错文本逐字相同，证明这不是"Seatbelt 挡住了 setrlimit"，而是 macOS 内核从不支持修改 `RLIMIT_AS`（与 Linux 不同，是已知的 Darwin 平台差异，`setrlimit(RLIMIT_AS, ...)` 在 Darwin 上恒定返回 `EINVAL`）。规格 §6.5"实测再定，不预先承诺"在这里落定为：**RLIMIT_AS 不能作为第一道防线，只能靠 RSS 轮询兜底**——与 CLAUDE.md "已接受的风险"一节的描述一致，这次是把它从"预期"变成"实测证实"。

## 其他观察（未写入必需清单，但对生产实现有参考价值）

不影响 U2 本身的 PASS/FAIL——去掉它，`pnpm test` 依然 exit 0、135 用例依然全过，所以没有按"实测证明必需"的标准写入上面的放行清单。但是有具体数据支撑的真实发现，值得让 S0-C 的实现者知情后自行决定是否采纳。

### `/dev/null` 可读不可写

**现象**：`cat /dev/null` 成功（exit 0），但 `echo hi > /dev/null` 失败（`/bin/sh: /dev/null: Operation not permitted`，exit 1）。

**根因**：`file-read*` 是全局放行（只挖掉两块），但 `file-write*` 只放行了 `worktree` 与 `jobTmp` 两个 subpath，`/dev/null` 不在其中。

**影响面**：这次实验没有踩到——`poc/` 的 vitest 全流程没有依赖写 `/dev/null`。但常见 shell 惯用法（`cmd > /dev/null 2>&1`）在未来别的任务类型里可能会撞上，报错信息不会直接说"是 /dev/null 的问题"，容易被误诊。

**建议的最小修复**（未加入本次放行清单，因未被本次实验证明必需）：`(allow file-write-data (literal "/dev/null"))`——用 `literal` 而非 `subpath`，精确到这一个设备节点，不放大范围。这与 Apple 自带系统 sandbox profile（如 `bsd.sb`）对 `/dev/null`/`/dev/zero`/`/dev/random` 的处理方式一致。这条同样**没有**被加进 `spike/src/sbpl.ts`。

## 未覆盖

- Python / Rust(cargo) 生态未测——本次只验证了 Node/pnpm 工具链，这也是 brief 明确指定的靶子。
- npm（非 pnpm）的 `node_modules` 布局未测——只测了 pnpm 的符号链接布局（`.pnpm/` + 顶层符号链接）。**本轮收窄后这一条的不确定性变大，需要特别注意**：pnpm 的 `.bin` shim 是物理落在 worktree 内的 POSIX shell 脚本，而 npm 传统上把 `node_modules/.bin/*` 做成**符号链接**，指向 `node_modules/<pkg>/<entry>`。`runSandboxed` 已经证实内核在做 Seatbelt subpath 匹配前会解析符号链接（`/tmp -> /private/tmp` 那类），如果 npm 的符号链接目标解析后落在 `node_modules/.bin` **之外**（例如直接指向 `node_modules/<pkg>/bin/cli.js`），现在收窄后的 `.bin`-only 规则可能覆盖不到——这在放行整个 worktree 的旧规则下不是问题，但收窄后是一个新引入的、未经验证的风险点，不应假定"pnpm 能跑 npm 也理应能跑"。**S0-C 支持 npm 项目前必须实测这条路径**。
- pnpm workspace / monorepo（`packages/*/node_modules/.bin` 多个嵌套目录）未测——见上文"worktree 内 process-exec"一节的"已知局限"，需要递归匹配，不是本次一行 `subpath` 收窄能覆盖的。
- yarn（尤其 PnP 模式，`.pnp.cjs` + zip 虚拟文件系统）未测——这是与 pnpm/npm 都不同的机制，读文件的方式本质不同（走自定义 loader 而非普通文件系统 path），不能想当然认为这份放行清单直接适用。
- 只测了单 job 串行跑的情形；未对"多个 job 并发跑、且都放行 `(allow signal (target same-sandbox))`"做压力测试——不过上文"signal"一节的两个反向测试（沙箱内→宿主机、job A→job B）已经确认跨进程/跨 job 隔离在功能上成立，只是没有在真实并发负载下测过。
- `maxRssMb` 的超调量化只来自一种分配模式（紧凑循环、每次分配 50MB）；更慢的内存增长模式下超调幅度会更小，实测的 3.5 倍不是普适上界，只是这次实测的一个具体数据点，不能直接当成通用安全边际公式。

## 实验代码

- `spike/tests/u2-real-vitest.test.ts`——已提交，是 U2 判定本身的回归测试（在真实 `poc/` 上完整跑一次 `pnpm test`，断言 exit 0 且输出包含 "135 passed"）。
- pnpm store 假设（Step 4）、资源兜底（Step 5）、"其他观察"、以及本轮审查修复（收窄 exec 规则的 Mach-O 差异测试、signal 三条安全性质、pnpm store 的 `stat` 核对、deny-store 复测）的验证脚本都是一次性的，**未提交**——落成 scratchpad 目录下的 `.mjs`/`.sb` 文件跑（跑完即删），避免内联多行字符串在 shell 里转义出错。本文档每一段引用的输出都逐字摘录自实际运行结果，不是转述。

## brief 脚本与当前 API 的出入（已在实现时修正，供复核）

brief 的 Step 2/4/5 内联脚本写于 Task 1 的 API 定型之前，三处已知的过时之处，本次都已按当前实现修正：

1. **`realpathSync` 强制要求路径存在**：`canonicalGit: join(POC, ".git-nonexistent")` / `join(jobTmp, ".nope")`、`worktreesRoot: join(tmpdir(), "u2-worktrees-none")` 这类"故意指向不存在路径"的写法，在当前 `runSandboxed` 里会直接踩雷——Task 1 起，`runSandboxed` 对 `SandboxPaths` 全部路径字段做 `realpathSync`（load-bearing：Seatbelt 按内核解析后的路径做 subpath 匹配，profile 文本里的路径必须与之一致），路径不存在会在 `buildProfile` 之前就抛 `ENOENT`，测试还没跑就先崩溃。修正为：在 `jobTmp` 下建空目录占位，语义不变（对这些测试场景而言仍是"空/不相关"），且随 `jobTmp` 一并被 `afterEach`/脚本收尾清理，全程不碰 `poc/` 本身。
2. **`node --input-type=module` 用法**：`--input-type=module` 只能配合 `-e` / `--print` / stdin 使用，不能同时指定脚本文件路径（会报 `ERR_INPUT_TYPE_NOT_ALLOWED`）。落成 `.mjs` 文件跑时改为直接 `node script.mjs`——文件扩展名已表明是 ESM，不需要这个 flag。
3. **PATH 与 execRoots 的合流时间线**：brief 写作时二者尚未合流（这是 Task 1 收尾时才修的，见 commit `0391ebb`）。当前 `paths.execRoots` 同时决定 profile 的 exec 放行与子进程的 `PATH`，两者不可能再分叉；brief 脚本原样能用，未做改动，此处仅记录时间线避免复核时误以为是本任务引入的差异。
