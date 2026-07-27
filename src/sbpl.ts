import { isAbsolute, join } from "node:path";

/**
 * I3：`sbpl.ts` 里此前有两处裸 `Error`（`q()` 的相对路径校验、`buildProfile()`
 * 的空 `execRoots` 校验），二者都经由 `runSandboxed`/`startJob` 可达
 * `grande_run` 这条工具调用路径。规格 §7.1 要求任何能到达工具层的异常都带
 * 结构化 `.code`——裸 `Error` 没有，响应信封的 `{code, message}` 没法按码分支，
 * 调用方只能靠正则匹配 message（已实测：`sbpl.test.ts` 曾经就是这么测的，
 * message 文案一改这类测试就跟着悄悄失真）。形状与 `PathSecurityError` 保持
 * 一致：`.code` 是结构化字段，`name` 带码供日志/堆栈定位，`message` 保持干净。
 */
export class SbplError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `SbplError [${code}]`;
    this.code = code;
  }
}

export interface SandboxPaths {
  /** 当前任务 worktree —— 唯一可写的仓库路径 */
  worktree: string;
  /** canonical 仓库的 .git 目录。worktree 里的 .git 是个文件、指向这里，
   *  而 hooks 存放于此且为所有 worktree 共享——必须整体不可写 */
  canonicalGit: string;
  /** 本 job 的临时目录，同时用作 HOME 与 TMPDIR */
  jobTmp: string;
  /** 控制平面根（状态/配置/审计）——被审计者不能读 */
  controlRoot: string;
  /** 全部 worktree 的父目录——先整体拒读，再单独放行本任务的 */
  worktreesRoot: string;
  /** 允许 process-exec 的根目录列表。显式作为输入而非硬编码常量：node/pnpm 的
   *  实际安装位置因安装方式而异（官方安装器、nvm、volta、asdf、Intel/Apple
   *  Silicon Homebrew 各不相同），硬编码在换一台机器时会悄悄漏放行、
   *  报 `Operation not permitted`。本机的默认值见 sandbox.ts 的 defaultExecRoots()
   *  ——那里才是允许碰真实文件系统（realpathSync/which）的层。 */
  execRoots: string[];
}

/** SBPL 字符串字面量里只需转义反斜杠与双引号 */
function q(path: string): string {
  if (!isAbsolute(path)) {
    throw new SbplError("INVALID_INPUT", `SBPL 的 subpath 必须是绝对路径，收到：${path}`);
  }
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 生成本 job 的 SBPL 策略。
 *
 * 裁决语义（2026-07-25 于 macOS 26.5.1 实测）：**按最具体规则优先，不是按书写顺序**。
 * 因此 `deny (subpath worktreesRoot)` + `allow (subpath worktree)` 能实现
 * 「只见自己、不见他人」，且新建的 worktree 自动被父目录的 deny 覆盖，
 * 无需在每次 job 启动时枚举其他任务。
 *
 * 读权限整体放宽（除控制平面根与他人 worktree 外），因为 node/npm/tsc 会读大量
 * 意想不到的系统路径，逐目录白名单会陷入无穷调试；而全禁网意味着读到的东西出不去。
 */
export function buildProfile(p: SandboxPaths): string {
  if (p.execRoots.length === 0) {
    throw new SbplError(
      "INVALID_INPUT",
      "execRoots 不能为空：空数组会让 (allow process-exec) 退化成不带过滤条件的规则，等于放行一切可执行文件",
    );
  }
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "",
    ";; 读：整体放宽，再挖掉两块",
    "(allow file-read*)",
    `(deny file-read* (subpath "${q(p.controlRoot)}"))`,
    `(deny file-read* (subpath "${q(p.worktreesRoot)}"))`,
    `(allow file-read* (subpath "${q(p.worktree)}"))`,
    "",
    ";; 写：只有本任务 worktree 与本 job 临时目录",
    `(allow file-write* (subpath "${q(p.worktree)}"))`,
    `(allow file-write* (subpath "${q(p.jobTmp)}"))`,
    `(deny file-write* (subpath "${q(p.canonicalGit)}"))`,
    `(deny file-write* (subpath "${q(p.worktree)}/.git"))`,
    "",
    ";; 执行：根目录列表由调用方传入（见 SandboxPaths.execRoots），不是硬编码常量",
    `(allow process-exec ${p.execRoots.map((root) => `(subpath "${q(root)}")`).join(" ")})`,
    ";; worktree 内也要放行 exec，但只到 node_modules/.bin——U2 实测：pnpm/npm 把包的可执行",
    ";; 入口（如 node_modules/.bin/vitest）生成为物理落在 worktree 内的 POSIX shell shim（不是",
    ";; 符号链接出去），`pnpm test` 经由该 shim 的 shebang 调起，因此 shim 自身必须可 exec。",
    ";; 复核发现原先放行整个 worktree 过宽：复核用同一份 135 用例套件验证，只放行",
    ";; node_modules/.bin 得到完全相同的结果（135/135 通过、exit 0），因此收窄到这一个子目录。",
    ";;",
    ";; 「放行整个 worktree 到底多让出了什么」——之前的注释声称『并未新增可达的攻击面』，",
    ";; 这个说法不成立，已用实测推翻：把一个新编译、未签名的 Mach-O 二进制放进 worktree 里",
    ";; （不在 .bin 下），没有本条规则时 exec 被拒（sandbox-exec 报 `Operation not permitted`，",
    ";; exit 71）；放行整个 worktree 后同一个二进制能被直接 exec（exit 0）。这与「shell 脚本",
    ";; 本来就能跑」不是一回事：`sh script.sh` 这种写法从不对 script.sh 本身发起 execve——",
    ";; 解释器 /bin/sh 已经在 execRoots 里被信任，脚本内容只是被当数据 read() 进去；但",
    ";; `pnpm test` 触发的是 shim 文件自身的 execve（内核处理 #! 这一步），跟 node_modules/.bin",
    ";; 之外新扔一个二进制文件、直接执行它，是完全相同性质的操作。所以放行整个 worktree 的",
    ";; 真实边际效果是『worktree 里任何位置放一个自包含可执行文件都能被直接启动』——不是",
    ";; 『反正已经能跑图灵完备代码所以无所谓』。收窄到 node_modules/.bin 后，worktree 其余",
    ";; 位置新增的可执行文件依旧被拒（同上，exit 71），只有这一个目录例外。",
    ";;",
    ";; 已知局限：.bin 单目录放行是针对 poc/（非 pnpm workspace，只有一层 node_modules/.bin）",
    ";; 验证的。若生产环境目标是 pnpm workspace/monorepo，会有多个",
    ";; packages/*/node_modules/.bin，需要递归匹配（例如按 glob 枚举各包目录后逐条放行，或",
    ";; 换一种从子目录到根的匹配策略）——这不是把这一行 subpath 换个路径就能覆盖的，是需要",
    ";; 单独设计的后续工作，S0-C 实现前必须先确认目标仓库的 workspace 布局。",
    `(allow process-exec (subpath "${q(join(p.worktree, "node_modules", ".bin"))}"))`,
    "(allow process-fork)",
    "(allow sysctl-read)",
    "",
    ";; vitest 默认 pool: forks 在收尾阶段会 kill() 自己 fork 出的子进程；(deny default) 下这个",
    ";; 自我发信号被拒（EPERM），vitest 退回逐 worker 超时等待，实测让真实 135 用例套件耗时",
    ";; 从 580ms（有这条规则）暴涨到 10702ms（没有，约 18.5 倍），量级与首轮报告的",
    ";; 0.55s（宿主机）vs 10.7s（沙箱、无信号规则）一致，同一个瓶颈。",
    ";; 加这条前独立验证过三条安全性质（均通过，见 findings/U2-seatbelt.md）：",
    ";; 1) 同一 sandbox 内自我发信号成功；2) 沙箱内进程对沙箱外、哪怕同 uid 的宿主进程",
    ";; 发信号依旧被拒；3) 两个独立 sandbox-exec 调用（模拟两个并发 job）互相发信号依旧被拒。",
    ";; `same-sandbox` 是按 sandbox 实例（这次调用 sandbox-exec 生成的那一个容器）区分的，",
    ";; 不是按 uid，所以收益只覆盖「进程信自己」，不会让任务间或沙箱内外的隔离松动。",
    "(allow signal (target same-sandbox))",
    "",
  ].join("\n");
}
