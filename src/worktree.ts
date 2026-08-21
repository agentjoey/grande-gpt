import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspectCanonicalGitState, type CanonicalGitState } from "./canonicalGit.ts";
import { GitExecError, safeGit, type SafeGitOptions } from "./gitExec.ts";
import type { Layout } from "./layout.ts";
import { assertTaskId, assertValidId, resolveRepoPath } from "./paths.ts";
import { loadDepDirs } from "./profiles.ts";
import { registeredIds } from "./registry.ts";

export class GitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `GitError [${code}]`;
    this.code = code;
  }
}

export interface WorktreeInfo {
  taskId: string;
  branch: string;
  baseCommit: string;
  worktreePath: string;
}

function gitDetail(error: unknown): string {
  if (error instanceof GitExecError) return error.message.replace(/^git failed:\s*/u, "");
  return error instanceof Error ? error.message : String(error);
}

/** git 一律以 argv 数组调用并禁用仓库 hooks，绝不拼 shell 字符串（铁律二） */
function git(cwd: string, args: string[], options: SafeGitOptions = {}): string {
  try {
    return safeGit.local(cwd, args, options);
  } catch (error) {
    throw new GitError("GIT_FAILED", `git ${args[0]} 失败：${gitDetail(error)}`);
  }
}

/**
 * `git diff` 家族在「有差异」时以 **exit 1** 退出——那是它的正常成功路径，不是错误。
 * Safe Git 的 diff mode 把 --no-index 的 exit 1 + stdout 还原成正常返回，同时固定
 * --no-ext-diff / --no-textconv，避免仓库配置执行外部 helper。（C-1）
 */
function gitDiff(cwd: string, args: string[]): string {
  try {
    return safeGit.diff(cwd, args);
  } catch (error) {
    throw new GitError("GIT_FAILED", `git diff 失败：${gitDetail(error)}`);
  }
}

/**
 * task/worktree admission 的 fail-closed gate。只把共享的只读 projection 映射回既有
 * GitError 语义：detached / rebase / merge / cherry-pick / index.lock 仍是
 * CANONICAL_BUSY；无 Git repository、无 HEAD 或 probe 本身失败仍是 GIT_FAILED。
 */
function assertCanonicalReady(repoRoot: string): CanonicalGitState {
  const state = inspectCanonicalGitState(repoRoot);
  if (!state.repository) {
    throw new GitError("GIT_FAILED", `${repoRoot} 不是有效 Git repository，不能派生 worktree。`);
  }
  if (state.inspectionError !== null) {
    throw new GitError("GIT_FAILED", `${repoRoot} 无法确认 canonical Git 状态：${state.inspectionError}`);
  }
  if (!state.headExists || state.headSha === null) {
    throw new GitError("GIT_FAILED", `${repoRoot} 没有 baseline commit（HEAD 不存在），不能派生 worktree。`);
  }
  if (state.busyReasons.length > 0) {
    const marker = state.busyReasons[0]!;
    throw new GitError(
      "CANONICAL_BUSY",
      `${repoRoot} 正处于 ${marker} 状态。请先在你自己的 checkout 里处理完，再开新任务。`,
    );
  }
  if (state.detached || state.branch === null) {
    throw new GitError(
      "CANONICAL_BUSY",
      `${repoRoot} 处于 detached HEAD（不在任何分支上）。请先在你自己的 checkout 里切回一个分支，再开新任务。`,
    );
  }
  return state;
}

/**
 * 为一个任务派生 worktree 与分支。
 *
 * **绝不 `git fetch`**（规格 §5.4①）：大仓库上 fetch 可能几十秒，直接撑爆 ChatGPT
 * 那个不可配置的 ~60s 工具超时。base 取本机当前 HEAD。
 *
 * **canonical 不受影响**：`git worktree add` 不会切走用户当前分支 —— 原地模型（D4）
 * 承诺用户可以继续用编辑器干活。
 */
export function openWorktree(
  layout: Layout,
  repoId: string,
  slug: string,
  taskId: string,
): WorktreeInfo {
  assertValidId(taskId, "taskId");
  // C4：taskId 的路径形状校验现在单一权威定义在 paths.ts（assertTaskId），
  // worktree.ts/runner.ts/tasks.ts 三处共用同一份，不再各自维护拷贝。
  // assertTaskId 抛的是 PathSecurityError（.code 同样是 INVALID_INPUT），
  // 调用方只应依赖 .code，不应依赖具体的 Error 子类。
  assertTaskId(taskId);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) {
    throw new GitError("INVALID_INPUT", `slug 必须是 1–40 个小写字母、数字或连字符，收到：${slug}`);
  }

  const repoRoot = resolveRepoPath(layout, repoId, registeredIds(layout));
  const canonical = assertCanonicalReady(repoRoot);

  const dir = join(layout.worktreesRoot, repoId, taskId);
  if (existsSync(dir)) {
    throw new GitError("WORKTREE_EXISTS", `${taskId} 的 worktree 已存在：${dir}`);
  }

  const baseCommit = canonical.headSha!;
  const canonicalBranch = canonical.branch!;
  // 后缀取 taskId 的**末 4 位字母数字**，而不是裸 `slice(-4)`：`TASK_ID_RE` 允许 taskId
  // 里带 `-`/`_`，生产实测 `task-ub-probe-20260729-001` 的末 4 位是 `-001`，拼在
  // `${slug}-` 后面就成了 `grande/ub-probe--001` 的双连字符。滤掉分隔符后既不会与前面
  // 那个连接符撞车，也不会因末 4 位全是分隔符而变成空串（`TASK_ID_RE` 保证首字符是
  // 字母数字，所以匹配结果至少有一个元素）。
  const suffix = (taskId.match(/[A-Za-z0-9]/g) ?? []).slice(-4).join("");
  const branch = `grande/${slug}-${suffix}`;
  git(repoRoot, ["worktree", "add", "-b", branch, dir, baseCommit], {
    expectedBranch: canonicalBranch,
    expectedHead: baseCommit,
  });

  cloneDepDirs(layout, repoId, repoRoot, dir);

  return { taskId, branch, baseCommit, worktreePath: realpathSync(dir) };
}

/**
 * 把 canonical 里已经存在的依赖目录（`profiles.yaml` 顶层 `depDirs.<repoId>` 声明，
 * 见 `src/profiles.ts` 的 `loadDepDirs`）克隆进新 worktree。（I-6）
 *
 * **为什么需要这一步**：`git worktree add` 产出的是一份干净 checkout，`node_modules`
 * 通常被 gitignore，新 worktree 里天然没有它；而 S0 全离线（Global Constraints）
 * 意味着新 worktree 里没法 `pnpm install` 补回来。没有这一步，`pnpm test`——大概率
 * 是第一个被注册的 profile——会在**每一个** worktree 里失败，等于 runner 跑不了
 * 这个项目自己的测试套件。
 *
 * 用 APFS `cp -Rc`（clonefile）：写时复制、零额外磁盘、保留符号链接（本机 macOS
 * 26.5.1 实测核对：dest 与 src 的同一文件 inode 不同但字节内容相同，符号链接原样
 * 保留，与 U2 spike 记录的 pnpm store 内部机制是同一种复制方式，见
 * `spike/findings/U2-seatbelt.md`「pnpm store」一节）。canonical 里不存在的目录
 * 直接跳过——不是错误（例如一个还没跑过 `pnpm install` 的全新仓库）。目标已存在
 * 也跳过——`cp -R` 在目标已存在时会把源目录**嵌套**进目标而不是替换它，那不是
 * 想要的语义，而正常路径下 `worktreeDir` 是刚建出来的全新 checkout，dest 不应该
 * 已经存在。
 */
function cloneDepDirs(layout: Layout, repoId: string, repoRoot: string, worktreeDir: string): void {
  for (const rel of loadDepDirs(layout, repoId)) {
    const src = join(repoRoot, rel);
    if (!existsSync(src)) continue;
    const dest = join(worktreeDir, rel);
    if (existsSync(dest)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    try {
      execFileSync("/bin/cp", ["-Rc", src, dest], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message: string };
      const detail = err.stderr ? String(err.stderr).trim() : err.message;
      throw new GitError("GIT_FAILED", `克隆依赖目录 ${rel} 到 worktree 失败：${detail}`);
    }
  }
}

/**
 * 移除 worktree。用 `--force` 是因为里面必然有未提交改动（S0 不做 commit）。
 *
 * **随手删掉分支**（MINOR 修复）：`git worktree remove` 只删工作目录，分支本身
 * 留在 canonical 里。不删的后果不是美观问题——`openWorktree` 的分支名是
 * `grande/<slug>-<taskId 末 4 位字母数字>`，重新用同一个 (slug, taskId 末 4 位字母数字) 组合开
 * 新任务时，`git worktree add -b <同名分支>` 会因为分支已存在而失败，报出一个
 * 跟真实原因（上一次没清理干净）毫无关系的 `GIT_FAILED`。
 *
 * 分支删除失败不应该掩盖「worktree 目录本身已经被成功移除」这个事实，但也不能
 * 假装什么都没发生——重新抛成 `WORKTREE_EXISTS`，如实反映下一次同名 open 会
 * 撞到的真实症状。
 */
export function removeWorktree(
  layout: Layout,
  info: { repoId: string; worktreePath: string; branch: string },
): void {
  const repoRoot = resolveRepoPath(layout, info.repoId, registeredIds(layout));
  git(repoRoot, ["worktree", "remove", "--force", info.worktreePath]);
  try {
    git(repoRoot, ["branch", "-D", info.branch]);
  } catch (e) {
    throw new GitError(
      "WORKTREE_EXISTS",
      `worktree 已移除，但清理分支 ${info.branch} 失败：${(e as Error).message}。` +
        `再次使用同一个 slug/taskId 末 4 位字母数字开新任务前，可能需要手动清理该分支。`,
    );
  }
}

const splitZ = (s: string): string[] => s.split("\0").filter((x) => x.length > 0);

/**
 * worktree 相对 base 改动过的文件，排序后返回（顺序必须确定）。
 *
 * **必须用 `-z`**：默认 `core.quotePath=true` 下，非 ASCII 文件名会被 git 输出成
 * C 风格转义的字面量（`café.ts` → `"caf\303\251.ts"`，实测）。那个字符串既不能给人看，
 * 拿回去当 pathspec 也匹配不到任何文件——diff 于是恒为空。`-z` 输出原始 UTF-8 字节、
 * 以 NUL 分隔，顺带也解决了文件名里含换行的情况。（C-1）
 */
export function listChangedFiles(worktreePath: string, baseCommit: string): string[] {
  const tracked = splitZ(gitDiff(worktreePath, ["diff", "--name-only", "-z", baseCommit]));
  const untracked = splitZ(git(worktreePath, ["ls-files", "-z", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

export interface DiffResult {
  truncated: boolean;
  nextCursor: string | null;
  files: { path: string; hunks: string }[];
}

const DEFAULT_MAX_DIFF_LINES = 400;

/**
 * worktree 相对 base 的 diff，**按文件分页**（规格 §5.4②，上限 400 行）。
 *
 * 按文件而不是按行分页，是因为半个 hunk 对模型没有意义。
 * `cursor` 是「已经给过多少个文件」的偏移量。
 */
export function repoDiff(
  worktreePath: string,
  baseCommit: string,
  opts?: { maxLines?: number; cursor?: string | null },
): DiffResult {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_DIFF_LINES;
  const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new GitError("INVALID_INPUT", `cursor 必须是非负整数，收到：${opts?.cursor}`);
  }

  const paths = listChangedFiles(worktreePath, baseCommit);
  const files: DiffResult["files"] = [];
  let lines = 0;
  let i = offset;

  for (; i < paths.length; i++) {
    const p = paths[i]!;
    // 对未跟踪文件 `git diff <base> -- <path>` 是空的，用 --no-index 与 /dev/null 比。
    // --no-index 有差异时 exit 1，Safe Git diff mode 会把它还原为正常 diff 输出。（C-1）
    let hunks = gitDiff(worktreePath, ["diff", "--no-color", baseCommit, "--", p]);
    if (hunks.length === 0) {
      hunks = gitDiff(worktreePath, [
        "diff", "--no-color", "--no-index", "--", "/dev/null", p,
      ]);
    }
    const n = hunks.split("\n").length;
    // 至少给出一个文件，否则单个超大文件会导致永远返回空、cursor 原地踏步（I-2）
    if (files.length > 0 && lines + n > maxLines) break;
    files.push({ path: p, hunks });
    lines += n;
    if (lines >= maxLines) {
      i++;
      break;
    }
  }

  const truncated = i < paths.length;
  return { truncated, nextCursor: truncated ? String(i) : null, files };
}
