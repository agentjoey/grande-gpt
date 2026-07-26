import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface Layout {
  /** 代码工作区根 = 可注册域。仓库以普通 checkout 形式作为其直接子目录存在 */
  workspaceRoot: string;
  /** 控制平面根：状态、配置、审计、artifact。**沙箱不可见** */
  controlRoot: string;
  stateDb: string;
  configDir: string;
  reposConfig: string;
  artifactsDir: string;
  /** 派生数据（worktree 等）。在工作区之下，因为它属于代码工作区而非控制平面 */
  derivedRoot: string;
  worktreesRoot: string;
}

/**
 * 从环境变量解析布局。
 *
 * `GRANDE_WORKSPACE` **没有默认值**是刻意的：猜错工作区意味着在错误的目录树上
 * 执行文件操作，失败得响远比失败得静默好。
 *
 * 两个根都做 `realpathSync`。原因不只是整洁：macOS 的 Seatbelt 在真实文件操作里
 * 解析符号链接、但**不**解析策略文本里的路径，未 canonical 化的路径会让 allow 规则
 * 过严、**deny 规则静默失效**（spike U2 实测）。路径比较同理——`/tmp/x` 与
 * `/private/tmp/x` 是同一个目录，字符串比较却不相等。统一在入口 canonical 化。
 */
export function loadLayout(): Layout {
  const rawWs = process.env.GRANDE_WORKSPACE;
  if (!rawWs) {
    throw new Error(
      "GRANDE_WORKSPACE 未设置。请指向代码工作区根的绝对路径，" +
        "例如 GRANDE_WORKSPACE=/Users/you/AgentWorks/GPT_Workspace",
    );
  }
  if (!isAbsolute(rawWs)) throw new Error(`GRANDE_WORKSPACE 必须是绝对路径，收到：${rawWs}`);
  if (!existsSync(rawWs)) throw new Error(`GRANDE_WORKSPACE 指向的目录不存在：${rawWs}`);

  const rawCtrl = process.env.GRANDE_CONTROL ?? join(homedir(), ".grande-control");
  if (!isAbsolute(rawCtrl)) throw new Error(`GRANDE_CONTROL 必须是绝对路径，收到：${rawCtrl}`);

  const workspaceRoot = realpathSync(rawWs);
  // controlRoot 可能还不存在（首次运行），先建再 realpath
  mkdirSync(rawCtrl, { recursive: true });
  const controlRoot = realpathSync(rawCtrl);

  const derivedRoot = join(workspaceRoot, ".grande-work");
  return {
    workspaceRoot,
    controlRoot,
    stateDb: join(controlRoot, "state", "grande.db"),
    configDir: join(controlRoot, "config"),
    reposConfig: join(controlRoot, "config", "repos.yaml"),
    artifactsDir: join(controlRoot, "artifacts"),
    derivedRoot,
    worktreesRoot: join(derivedRoot, "worktrees"),
  };
}

/** 创建控制平面目录。**不创建 workspaceRoot** —— 那是用户的目录。 */
export function ensureLayout(l: Layout): void {
  for (const d of [join(l.controlRoot, "state"), l.configDir, l.artifactsDir]) {
    mkdirSync(d, { recursive: true });
  }
}
