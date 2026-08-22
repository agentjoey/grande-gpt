import { mkdirSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

export interface Layout {
  /** 代码工作区根 = 可注册域。仓库以普通 checkout 形式作为其直接子目录存在 */
  workspaceRoot: string;
  /** 控制平面根：状态、配置、审计、artifact。**沙箱不可见** */
  controlRoot: string;
  stateDb: string;
  /** 受管状态库备份根；旧测试/调用方未提供时从 controlRoot 固定派生 */
  stateBackupsDir?: string;
  configDir: string;
  reposConfig: string;
  artifactsDir: string;
  /** 派生数据（worktree 等）。在工作区之下，因为它属于代码工作区而非控制平面 */
  derivedRoot: string;
  worktreesRoot: string;
}

/**
 * 判断 child 是否真的在 parent 之下（而不只是字符串前缀相同，如 /a/bc 相对 /a/b）。
 * 与 `paths.ts` 里同名函数逻辑一致，这里单独放一份而不是跨模块引入运行时依赖：
 * `paths.ts` 只在类型层（`import type { Layout }`）依赖 `layout.ts`，`layout.ts`
 * 不应该反过来在运行时依赖 `paths.ts`——两者的依赖方向应该保持单向。
 */
function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
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
 *
 * **D3（CLAUDE.md「不得静默推翻的决定」）在这里落成硬约束**：canonical 化之后，
 * 两个根之间不能有包含关系（任一方向）。这条边界此前只写在文档与目录约定里，
 * 代码从未检查过——把 `GRANDE_CONTROL` 设在工作区内部会被默默接受，`resolveInRepo`
 * 之后甚至能算出一条落在仓库里、指向审计库本体的合法写入目标：审计账本从此
 * 沦为一个普通的仓内文件，S0-B 的写工具碰得到它，S0-C 沙箱对整棵树的写权限也
 * 会覆盖它，AC-14「deny-list 读自不可信仓库内容读不到的地方」这条假设一并塌陷。
 * 反方向（工作区落在控制平面之内）目前没有具体后果，但同样破坏「两棵树互不
 * 包含」这条前提，一并拒绝。铁律三：能做成硬约束的绝不做成软约束。
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

  if (isUnder(controlRoot, workspaceRoot)) {
    throw new Error(
      `GRANDE_WORKSPACE（${workspaceRoot}）落在 GRANDE_CONTROL（${controlRoot}）之内——` +
        `工作区不能是控制平面的子目录：控制平面存的是审计与状态，被审计的代码不能反过来包住它（D3）。`,
    );
  }
  if (isUnder(workspaceRoot, controlRoot)) {
    throw new Error(
      `GRANDE_CONTROL（${controlRoot}）落在 GRANDE_WORKSPACE（${workspaceRoot}）之内——` +
        `控制平面不能是工作区的子目录：D3 要求被审计者不能拥有审计记录的写权限，一旦控制平面` +
        `落在工作区之内，审计账本就变成一条普通的仓内路径，S0-B 的写工具与 S0-C 的沙箱都会对` +
        `它有写权限。`,
    );
  }

  const derivedRoot = join(workspaceRoot, ".grande-work");
  return {
    workspaceRoot,
    controlRoot,
    stateDb: join(controlRoot, "state", "grande.db"),
    stateBackupsDir: join(controlRoot, "backups", "state"),
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
