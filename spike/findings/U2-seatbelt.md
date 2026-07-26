# U2 · Seatbelt 可行性 —— 结论：PASS

**日期** 2026-07-26 · **macOS 版本** 26.5.1 (25F80) · **靶子**：`poc/`（pnpm 10.33.0 安装，7 个测试文件，135 用例）
**Node** v24.14.0（原生 strip types，未加 `--experimental-strip-types`）· **pnpm** `10.33.0`，解析路径 `/Users/xtation/.local/bin/pnpm` → `~/.local/lib/node_modules/pnpm/bin/pnpm.cjs`
**本机 `defaultExecRoots()`**：`/usr/bin`, `/bin`, `/usr/sbin`, `/usr/local/bin`, `~/.local/lib/node_modules/pnpm/bin`, `/usr/local/lib/node_modules/npm/bin`

## 结论

**PASS**——在 `(deny default)` + `(deny network*)` 下，真实 pnpm 项目（`poc/`，135 用例）的 `pnpm test` 能完整跑通并全部通过。相对 Task 1 已验证的基线 profile，只需新增**一条**规则：放行 worktree 自身的 `process-exec`。pnpm 的全局 store 不需要放行（硬链接假设成立，实测确认）。`deny default` / `deny network*` 全程原样保留，未做任何放宽。

## 最终放行清单（S0-C 直接照抄）

完整 profile 形状——基线部分继承自 Task 1（已有 23 项行为测试覆盖，此处不重新证明，只为"可直接照抄"而完整列出）；标记"本任务新增"的是本次 U2 实验唯一新增的规则：

| 规则 | 为什么需要 | 不加会怎样 |
|---|---|---|
| `(deny default)` + `(deny network*)` | 硬约束的起点：默认拒绝一切，网络整体禁止 | 若省略等于没有沙箱——本次验证的前提就是二者原样保留、全程未松动 |
| `(allow file-read*)` 全局，挖掉 `controlRoot`/`worktreesRoot` 两个 subpath | node/npm/tsc/vitest 会读大量意料之外的系统路径（模块解析、locale 等），逐目录白名单会陷入无穷调试 | 几乎任何工具链命令都会因读不到某个路径而报错，且报错通常不会直接点名"是沙箱挡的" |
| `(allow file-write* (subpath worktree))` + `(allow file-write* (subpath jobTmp))` | vitest 需要写 `.vite`/`.vite-temp` 缓存等临时产物 | vitest 启动阶段写缓存目录失败，直接 EPERM 退出 |
| `(deny file-write* (subpath canonicalGit))` + `(deny file-write* (subpath worktree/.git))` | canonical 仓库的 `.git`（hooks 等）为所有 worktree 共享；worktree 自己的 `.git` 是指向 canonical 的文件——改写任一个都能劫持后续 git 操作 | 本次实验里 `poc/` 不是 git worktree，这两条规则命中的是空占位目录，不影响 U2 判定；但生产环境这是完整性边界，必须保留 |
| `(allow process-exec ...execRoots)`，`execRoots` 由 `defaultExecRoots()` 按机器解析 | node/pnpm/npm/npx 与标准系统工具（sh、cat、env…）必须能被 exec；具体目录随安装方式变化，不能硬编码 | Task 1 已实测：硬编码 `/opt/homebrew` 在本机漏放行 `/usr/local/bin/node`，报 `Operation not permitted`（exit 71），会把"能不能跑"误判为"不能"——本任务继承这个教训，全程用 `defaultExecRoots()` |
| **`(allow process-exec (subpath worktree))`** | **U2 实测新增**：pnpm/npm 把包的可执行入口（如 `node_modules/.bin/vitest`）生成为物理落在 worktree 内的 POSIX shell shim（不是符号链接出去的），`pnpm test` 经由该 shim 的 shebang 调起，因此 shim 自身必须可 exec | 实测现象：`pnpm test` 尝试 exec 该 shim 时失败——`sh: .../node_modules/.bin/vitest: /bin/sh: bad interpreter: Operation not permitted`，**exit code 126**。已做自查：删除此规则可 100% 复现该失败（remove → fail → restore → pass），详见下节 |
| `(allow process-fork)` | vitest 默认 `pool: forks`（每测试文件一个真实子进程）必须能 fork | fork 被拒会让任何多进程 pool 直接失败 |
| `(allow sysctl-read)` | Node/V8 启动时探测 CPU 核数等常规调用 | 被拒通常表现为启动期的诡异报错，与"沙箱"两个字对不上号，容易被误诊为别的问题 |

**PATH 与 execRoots 同源**（Task 1 已修，此处复述因为它是 U2 能跑通的前提之一）：子进程的 `PATH` 环境变量由 `execRoots.join(":")` 派生，不是与 profile 平行的第二处硬编码——否则会出现"exec 权限有了，但 pnpm 的 `#!/usr/bin/env node` shebang 解析不到 node"这种更隐蔽的失败（exit 127，历史上真实出现过，见 commit `0391ebb`）。

### worktree 可执行——安全取舍怎么权衡的

这是 brief 明确要求"诚实权衡"的一点，不是加规则了事：

- **代价**：worktree 装的是不可信仓库内容。放行 `process-exec (subpath worktree)` 之后，沙箱内进程理论上可以在运行期动态生成新脚本再执行（`echo '#!/bin/sh...' > x.sh && chmod +x x.sh && ./x.sh`——写与 exec 都落在同一个已放行的 subpath 内，`chmod` 属于 `file-write*` 的一部分同样已放行）。
- **为什么这个代价比听起来的小**：`pnpm test` 本身已经在执行仓库自带的、图灵完备的代码——`vitest.config.ts`、`setup` 文件、测试文件本身都是"愿意跑它"这个意义上被信任、以任意逻辑运行的 JS。exec 位放开只是把"不可信代码被执行"这件事从"脚本内容"延伸到"脚本文件本身的 exec 位"，**可达的攻击面没有变化**，因为其余边界原样保留且与这条新规则正交：
  - `(deny network*)` 依然全局生效——动态生成的脚本一样连不出网，读不到的东西出不去；
  - `controlRoot`（审计/配置）与 `worktreesRoot` 之外的兄弟 worktree，读权限依然被排除在外；
  - `canonicalGit` 与 `worktree/.git` 依然不可写。
- **结论**：这是一个真实但可接受的权衡，不是形式主义。核心约束（禁网、控制平面隔离、任务间隔离）没有被这条规则触碰。

## pnpm store

**结论：硬链接对沙箱透明，不需要给 `~/Library/pnpm/store` 放行。**

把 `controlRoot` 故意设成 `~/Library/pnpm/store`（真实存在的全局 store；这让 profile 生成 `(deny file-read* (subpath "~/Library/pnpm/store"))`，让整个 store 对沙箱内进程整体不可读）后重跑 `pnpm test`，逐字实测输出：

```
store 不可读时 exitCode = 0 killedBy = null
包含 '135 passed' ？ true
包含 '7 passed' (Test Files) ？ true
durationMs = 10711  peakRssMb = 267
```

（另一次独立重跑得到 `durationMs = 10687`，两次结果一致，非偶然。）

135 个用例全部通过，与 store 可读时结果完全一致。原因：pnpm 把 store 里的包内容**硬链接**进 `worktree/node_modules/.pnpm/...`——硬链接是同一个 inode 的另一个目录项，没有路径间接，Seatbelt 按路径做 subpath 匹配，走的是 `node_modules/.pnpm/...`（在 worktree 允许范围内），从不会真正打开 `~/Library/pnpm/store` 下的路径。**S0-C 的放行清单不需要为 pnpm store 单独开一条规则**——这避免了一条"以防万一"式、实际上从未被读到的放行，减少了不必要的攻击面。

## 资源兜底

- **RSS 轮询是否生效**：生效，但有实测量化的超调（overshoot）。用一个 `for(;;) a.push(Buffer.alloc(50MB))` 的紧凑分配循环、`maxRssMb=300` 作为阈值：`killedBy = "rss"`，进程组在 `durationMs ≈ 2033ms` 时被杀掉（对应代码里 `RSS_POLL_MS=2000` 的轮询周期——基本是第一次轮询就命中），但此时 `peakRssMb` 已经到 **1037 MB**，超过阈值约 3.5 倍。这是代码注释"这不是 cgroup——采样窗口内仍可冲高，是已接受的取舍"的量化版本：轮询确实会杀掉进程（不会无限跑下去），但对来势凶猛的分配模式，实际生效前的峰值可能是设定阈值的数倍。**给 S0-C 的建议**：`maxRssMb` 要按"host 实际可用内存 ÷ 3～4"左右的安全边际设置，不能卡着字面阈值设。（注：这个 3.5 倍只是这一种分配模式下的实测数据点，不是普适上界——见"未覆盖"一节。）
- **`RLIMIT_AS` 对 Node 24 是否可用**：**不可用，且与 Seatbelt 无关**——这是 macOS/XNU 内核层面的限制，不是 Seatbelt 挡的。沙箱内外用同一条 `ulimit -v 262144` 探测，得到完全相同的报错：

  ```
  ulimit: virtual memory: cannot modify limit: Invalid argument   (exit 1)
  ```

  在沙箱外单独验证过（不经 `sandbox-exec`，直接跑同一条命令），报错文本逐字相同，证明这不是"Seatbelt 挡住了 setrlimit"，而是 macOS 内核从不支持修改 `RLIMIT_AS`（与 Linux 不同，是已知的 Darwin 平台差异，`setrlimit(RLIMIT_AS, ...)` 在 Darwin 上恒定返回 `EINVAL`）。规格 §6.5"实测再定，不预先承诺"在这里落定为：**RLIMIT_AS 不能作为第一道防线，只能靠 RSS 轮询兜底**——与 CLAUDE.md "已接受的风险"一节的描述一致，这次是把它从"预期"变成"实测证实"。

## 其他观察（未写入必需清单，但对生产实现有参考价值）

这两条都不影响 U2 本身的 PASS/FAIL——去掉它们，`pnpm test` 依然 exit 0、135 用例依然全过，所以没有按"实测证明必需"的标准写入上面的放行清单（也做不出"删掉就 fail"的自查，见 Step 6 自查要求）。但都是有具体数据支撑的真实发现，值得让 S0-C 的实现者知情后自行决定是否采纳。

### 1. vitest 的 `pool: forks` 清理阶段因 signal 被拒，白白多等 ~10 秒

**现象**：`poc/vitest.config.ts` 未指定 `pool`，用的是 vitest 4.x 的默认值 `forks`（每个测试文件一个真实子进程）。全部测试跑完后，vitest 主进程尝试 `kill()` 自己 fork 出来的 worker 子进程做收尾清理，这在沙箱里失败：

```
code: 'EPERM', syscall: 'kill'
[vitest-pool]: Timeout terminating forks worker for test files .../mcpResponse.test.ts.
[vitest-pool]: Timeout terminating forks worker for test files .../envelope.test.ts.
...(7 个测试文件各一条)
```

之后 vitest 退回"等超时"的兜底路径，最终仍然 `exitCode=0`、135 用例全过，但每个 worker 都要等一轮超时——实测总耗时（`RunResult.durationMs`，两次独立测量一致）**10687ms / 10711ms**，而宿主机不经沙箱跑同一套测试只要 **550ms**（`time -p pnpm test`：`real 0.55`）。这近 10 秒纯粹是死等，且 stderr 里的 EPERM 堆栈与超时提示很容易被误读成"测试出问题了"。

**根因**：`(deny default)` 默认也拒绝 `signal` 操作类；vitest 主进程向自己 fork 出的子进程发信号收尾，这个"沙箱内进程互相发信号"的动作没有被放行。

**验证过的修复与安全性**：加一条 `(allow signal (target same-sandbox))` 后，EPERM 与超时提示完全消失，总耗时降到 **676ms**，与宿主基线同一量级。为确认这条规则没有扩大攻击面，做了两个独立的反向测试（均通过）：

1. 宿主机（不经沙箱、同 uid）起一个 `sleep 60`，沙箱内进程对它执行 `kill -0` → 失败（`Operation not permitted`）——证明 `same-sandbox` 不会让沙箱内进程碰到沙箱外、哪怕是同用户的进程（正常 Unix 权限下同 uid 本可以 `kill -0`，Seatbelt 在这之上又加了一层）。
2. 两个独立的 `sandbox-exec` 调用（各自独立的 worktree/jobTmp/controlRoot/worktreesRoot，模拟两个并发 job）：job A 尝试对 job B 的 pid `kill -TERM` → 失败，job B 完整跑满 15 秒 `sleep`、未被提前终止——证明 `same-sandbox` 不会让不同 job 之间互相信号。

**建议**：本任务判定 U2 PASS 不依赖这条规则，因此没有写入"最终放行清单"（该清单的标准是"实测证明必需"，且要能"删掉就 fail"——这条规则删掉并不会 fail）。但基于以上数据，**建议 S0-C 生产实现主动加上 `(allow signal (target same-sandbox))`**：收益明确（每个用 forks/多进程 pool 的 job 少等约 10 秒 + 更干净的 stderr，并发场景下这个成本会累加），且已用两个独立场景验证过不会让沙箱内进程越权触达沙箱外或其他 job。这条规则**没有**被加进 `spike/src/sbpl.ts`，留给 S0-C 决定。

### 2. `/dev/null` 可读不可写

**现象**：`cat /dev/null` 成功（exit 0），但 `echo hi > /dev/null` 失败（`/bin/sh: /dev/null: Operation not permitted`，exit 1）。

**根因**：`file-read*` 是全局放行（只挖掉两块），但 `file-write*` 只放行了 `worktree` 与 `jobTmp` 两个 subpath，`/dev/null` 不在其中。

**影响面**：这次实验没有踩到——`poc/` 的 vitest 全流程没有依赖写 `/dev/null`。但常见 shell 惯用法（`cmd > /dev/null 2>&1`）在未来别的任务类型里可能会撞上，报错信息不会直接说"是 /dev/null 的问题"，容易被误诊。

**建议的最小修复**（未加入本次放行清单，因未被本次实验证明必需）：`(allow file-write-data (literal "/dev/null"))`——用 `literal` 而非 `subpath`，精确到这一个设备节点，不放大范围。这与 Apple 自带系统 sandbox profile（如 `bsd.sb`）对 `/dev/null`/`/dev/zero`/`/dev/random` 的处理方式一致。这条同样**没有**被加进 `spike/src/sbpl.ts`。

## 未覆盖

- Python / Rust(cargo) 生态未测——本次只验证了 Node/pnpm 工具链，这也是 brief 明确指定的靶子。
- npm（非 pnpm）的 `node_modules` 布局未测——只测了 pnpm 的符号链接布局（`.pnpm/` + 顶层符号链接）。npm 的扁平化布局理论上不应比 pnpm 更麻烦（同样会有 `node_modules/.bin/*` 物理落在 worktree 内的 shim，同一条 `process-exec (subpath worktree)` 规则理应同样覆盖），但未实测，不应不经验证就假定成立。
- yarn（尤其 PnP 模式，`.pnp.cjs` + zip 虚拟文件系统）未测——这是与 pnpm/npm 都不同的机制，读文件的方式本质不同（走自定义 loader 而非普通文件系统 path），不能想当然认为这份放行清单直接适用。
- 只测了单 job 串行跑的情形；未对"多个 job 并发跑、且都放行 `(allow signal (target same-sandbox))`"做压力测试——不过"其他观察 §1"里的两个反向测试已经确认跨 job 隔离在功能上成立，只是没有在真实并发负载下测过。
- `maxRssMb` 的超调量化只来自一种分配模式（紧凑循环、每次分配 50MB）；更慢的内存增长模式下超调幅度会更小，实测的 3.5 倍不是普适上界，只是这次实测的一个具体数据点，不能直接当成通用安全边际公式。

## 实验代码

- `spike/tests/u2-real-vitest.test.ts`——已提交，是 U2 判定本身的回归测试（在真实 `poc/` 上完整跑一次 `pnpm test`，断言 exit 0 且输出包含 "135 passed"）。
- pnpm store 假设（Step 4）、资源兜底（Step 5）、以及"其他观察"两条的验证脚本是一次性的，**未提交**——brief 原文用 `node --input-type=module -e '...'` 内联跑，这里等价地落成 scratchpad 目录下的 `.mjs` 文件跑（跑完即删），避免内联多行字符串在 shell 里转义出错。本文档每一段引用的输出都逐字摘录自实际运行结果，不是转述。

## brief 脚本与当前 API 的出入（已在实现时修正，供复核）

brief 的 Step 2/4/5 内联脚本写于 Task 1 的 API 定型之前，三处已知的过时之处，本次都已按当前实现修正：

1. **`realpathSync` 强制要求路径存在**：`canonicalGit: join(POC, ".git-nonexistent")` / `join(jobTmp, ".nope")`、`worktreesRoot: join(tmpdir(), "u2-worktrees-none")` 这类"故意指向不存在路径"的写法，在当前 `runSandboxed` 里会直接踩雷——Task 1 起，`runSandboxed` 对 `SandboxPaths` 全部路径字段做 `realpathSync`（load-bearing：Seatbelt 按内核解析后的路径做 subpath 匹配，profile 文本里的路径必须与之一致），路径不存在会在 `buildProfile` 之前就抛 `ENOENT`，测试还没跑就先崩溃。修正为：在 `jobTmp` 下建空目录占位，语义不变（对这些测试场景而言仍是"空/不相关"），且随 `jobTmp` 一并被 `afterEach`/脚本收尾清理，全程不碰 `poc/` 本身。
2. **`node --input-type=module` 用法**：`--input-type=module` 只能配合 `-e` / `--print` / stdin 使用，不能同时指定脚本文件路径（会报 `ERR_INPUT_TYPE_NOT_ALLOWED`）。落成 `.mjs` 文件跑时改为直接 `node script.mjs`——文件扩展名已表明是 ESM，不需要这个 flag。
3. **PATH 与 execRoots 的合流时间线**：brief 写作时二者尚未合流（这是 Task 1 收尾时才修的，见 commit `0391ebb`）。当前 `paths.execRoots` 同时决定 profile 的 exec 放行与子进程的 `PATH`，两者不可能再分叉；brief 脚本原样能用，未做改动，此处仅记录时间线避免复核时误以为是本任务引入的差异。
