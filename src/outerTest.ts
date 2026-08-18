import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { StateError } from "./errors.ts";
import type { Layout } from "./layout.ts";
import { getProfile, ProfileError } from "./profiles.ts";
import { getTask } from "./tasks.ts";

/**
 * 「外层测试」—— 自举时跑不了的那些测试文件。
 *
 * ## 为什么需要这个命令
 *
 * `unit-selfhost` profile 排除了几个测试文件，因为它们自己要 spawn `sandbox-exec`
 * 或绑真实端口；在沙箱里跑等于嵌套沙箱，内层只能比外层更严，**结构上不可能通过**。
 *
 * 代价是：**被排除的文件所保护的不变量，在自举期间完全失效**。这不是理论风险，
 * 已经连续三次造成实际后果：
 *
 * - S2：`tools.test.ts` 的工具计数 11→13 变红，实现者看不见
 * - S3：同一处 13→15，**外加**「所有工具 openWorldHint: false（全禁网）」这条
 *   不变量被 S3 有意打破，而断言就在那个看不见的文件里
 * - S3：实现者还把它**跑得到**的另一处计数断言主动改松了——从局部看合理
 *   （那条断言确实缺上下文），但它看不到别处有更强的同类断言
 *
 * 三次都靠 reviewer「恰好记得」手动补跑才发现。**「恰好记得」不是机制。**
 *
 * ## 排除清单为什么从 profile 反推，而不是写在这里
 *
 * 写死在本文件里就会与 `~/.grande-control/config/profiles.yaml` 漂移——
 * 有人往 profile 的排除清单里加一个文件，这个命令却不知道，于是那个文件
 * **既不在自举里跑，也不在外层里跑**，静默地谁都不管。
 *
 * 那正是本项目反复犯过的「同源漏改」。所以这里**只有一个真相源**：
 * 从 `unit-selfhost` 的 argv 里把 `--exclude tests/*.test.ts` 反解出来，
 * 跑的就是它们的补集。profile 改了，这个命令自动跟上。
 */

/** 每个被排除文件为什么跑不进沙箱。未登记意味着 profile 漂移，必须 fail closed。 */
const WHY: Record<string, string> = {
  "tests/sandbox.test.ts": "自己 spawn sandbox-exec（测的就是沙箱本身）",
  "tests/runner.test.ts": "起真实 job，经沙箱",
  "tests/server.test.ts": "startGateway 绑真实端口",
  "tests/tools.test.ts": "工具层里跑真实 job",
  "tests/e2e.test.ts": "完整闭环，含跑测试",
};

export interface OuterTestPlan {
  /** 要跑的测试文件（= `unit-selfhost` 排除掉的那些）。 */
  files: string[];
  /** 每个文件的排除理由。planOuterTest 保证这里不会出现 undefined。 */
  reasons: Map<string, string>;
  /** 反推所依据的 profile 名。 */
  fromProfile: string;
}

/**
 * 选择 outer-test 真正执行 vitest 的 cwd。
 *
 * 不传 taskId 保持旧的 canonical 行为；自举产出在合并前必须显式传 taskId，
 * 否则会出现「canonical 绿，但待合并 worktree 根本没被测」的假验收。
 */
export function resolveOuterTestCwd(
  db: DatabaseSync,
  layout: Layout,
  repoId: string,
  taskId?: string,
): string {
  if (taskId === undefined) return join(layout.workspaceRoot, repoId);
  const task = getTask(db, taskId);
  if (!task) throw new StateError("TASK_NOT_FOUND", `任务 ${taskId} 不存在。`);
  if (task.repoId !== repoId) {
    throw new StateError(
      "INVALID_INPUT",
      `任务 ${taskId} 属于仓库 ${task.repoId}，不能用于验收仓库 ${repoId}。`,
    );
  }
  return task.worktreePath;
}

/**
 * 从 `unit-selfhost` 的 argv 反推出「外层要跑哪些文件」。
 *
 * 只取 `tests/` 下的排除项——`**\/node_modules\/**` 一类是 vitest 的默认排除，
 * 不是「沙箱跑不了」的意思，混进来会让这个命令去跑不存在的东西。
 */
export function planOuterTest(layout: Layout, repoId: string, profileName = "unit-selfhost"): OuterTestPlan {
  const profile = getProfile(layout, repoId, profileName);
  const argv = profile.argv;
  const files: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "--exclude") continue;
    const pattern = argv[i + 1]!;
    if (pattern.startsWith("tests/")) files.push(pattern);
  }
  if (files.length === 0) {
    throw new ProfileError(
      "PROFILE_NOT_FOUND",
      `${profileName} 的 argv 里没有任何 \`--exclude tests/...\`——要么该 profile 不再排除` +
        `任何测试文件（那 outer-test 就没有意义，直接跑 pnpm test），要么排除清单的写法变了` +
        `而本命令的反推逻辑没跟上。请人工确认，不要猜。`,
    );
  }

  const reasons = new Map<string, string>();
  for (const f of files) {
    const reason = WHY[f];
    if (reason === undefined) {
      throw new ProfileError(
        "PROFILE_NOT_FOUND",
        `${profileName} 排除了 ${f}，但 outer-test 的 WHY 表没有登记理由。` +
          `这通常表示生产 profile 已发生漂移；请先确认为什么该测试不能在 selfhost 沙箱中运行，再登记理由。`,
      );
    }
    reasons.set(f, reason);
  }
  return { files, reasons, fromProfile: profileName };
}
