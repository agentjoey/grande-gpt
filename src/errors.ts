import { PathSecurityError } from "./paths.ts";
import { PolicyError } from "./policy.ts";
import { ProfileError } from "./profiles.ts";
import { EditError } from "./repoFile.ts";
import { SearchError } from "./repoSearch.ts";
import { MapError } from "./repoMap.ts";
import { RunnerError } from "./runner.ts";
import { GitError } from "./worktree.ts";
import { SbplError } from "./sbpl.ts";
import { SandboxError } from "./sandbox.ts";

/** 只有 `.code` 的最小结构化错误。tasks.ts/jobs.ts 从裸 Error 迁到这里。 */
export class StateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `StateError [${code}]`;
    this.code = code;
  }
}

/** 规格 §7 的工具错误码，外加一个 INTERNAL 兜底 */
export type ToolErrorCode =
  | "INVALID_INPUT" | "UNAUTHORIZED" | "POLICY_DENIED" | "REPO_NOT_REGISTERED"
  | "TASK_NOT_FOUND" | "STALE_FILE" | "CANONICAL_BUSY" | "WORKTREE_DIRTY"
  | "PROFILE_NOT_FOUND" | "JOB_TIMEOUT" | "RESOURCE_EXHAUSTED" | "NETWORK_DENIED"
  | "INTERNAL";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

/** 内部码 → 工具码。规格 §7.1 那张表 */
const MAP: Record<string, { code: ToolErrorCode; retryable: boolean }> = {
  PATH_ESCAPE:            { code: "POLICY_DENIED",       retryable: false },
  POLICY_DENIED:          { code: "POLICY_DENIED",       retryable: false },
  BAD_CONFIG:             { code: "POLICY_DENIED",       retryable: false },
  REPO_NOT_REGISTERED:    { code: "REPO_NOT_REGISTERED", retryable: false },
  REPO_NOT_FOUND:         { code: "REPO_NOT_REGISTERED", retryable: false },
  INVALID_INPUT:          { code: "INVALID_INPUT",       retryable: false },
  STALE_FILE:             { code: "STALE_FILE",          retryable: true  },
  FILE_NOT_FOUND:         { code: "INVALID_INPUT",       retryable: false },
  FILE_EXISTS:            { code: "INVALID_INPUT",       retryable: false },
  PROFILE_NOT_FOUND:      { code: "PROFILE_NOT_FOUND",   retryable: false },
  CANONICAL_BUSY:         { code: "CANONICAL_BUSY",      retryable: true  },
  GIT_FAILED:             { code: "INVALID_INPUT",       retryable: false },
  WORKTREE_EXISTS:        { code: "INVALID_INPUT",       retryable: false },
  JOB_NOT_FOUND:          { code: "INVALID_INPUT",       retryable: false },
  // TASK_NOT_FOUND 与 PROFILE_NOT_FOUND 长得像（都是"某个 id 指向的东西不存在"），
  // retryable 却相反，是有意的：taskId 是随对话漂移的会话状态，模型在长会话里
  // 弄丢它是预期内的正常状况（规格里 taskContext 回带机制就是为了缓解这个），
  // 错误信息还会列出活跃任务（I-1d，见 Task 3）供它当场挑一个重试；
  // profile 名是静态配置面，模型本该从工具交互里已经知道有哪些可选，报这个错
  // 多半说明它记错了名字而不是状态丢了——标 retryable 容易鼓励它反复瞎猜同一个
  // 错的名字，而不是先去确认可用列表。
  TASK_NOT_FOUND:          { code: "TASK_NOT_FOUND",      retryable: true  },
  // C-5 新增：STALE_STATE 是 updateTaskState 的乐观并发失败，语义与 STALE_FILE
  // 一致（重读后重试），只是工具码按规格 §7.1 收敛到通用的 INVALID_INPUT。
  STALE_STATE:             { code: "INVALID_INPUT",       retryable: true  },
  // I-1a 新增：SBPL 路径与磁盘实际拼写不一致——规格 §11 明确这意味着一条 deny
  // 规则会静默失效，是策略失败，不是用户输入问题，因此不可重试。
  PATH_SPELLING_MISMATCH:  { code: "POLICY_DENIED",       retryable: false },
};

/**
 * 我们自己的错误类。**只有这些类的实例参与映射** —— 一个裸对象带着
 * `code: "POLICY_DENIED"` 不能被当成合法映射源，否则仓库里的数据
 * （例如一段被 JSON.parse 的测试输出）就能伪造成一次策略决定。铁律一。
 */
const KNOWN = [
  PathSecurityError, PolicyError, ProfileError, EditError,
  SearchError, MapError, RunnerError, GitError,
  SbplError, SandboxError, StateError,
] as const;

function structuredCode(e: unknown): string | null {
  if (!KNOWN.some((C) => e instanceof C)) return null;
  const c = (e as { code?: unknown }).code;
  return typeof c === "string" ? c : null;
}

/**
 * 把任意抛出物翻译成发给 ChatGPT 的 `error{...}`。
 *
 * **绝不解析 message 字符串**：message 会被改写、被本地化、被截断，
 * 而且它可能原样包含另一个错误码的字样。契约建立在 `.code` 上。
 *
 * 未知异常一律降级成 `INTERNAL` 且**丢弃原始 message** —— 内部错误常含
 * 绝对路径、堆栈、配置片段，那些不该进对话。完整信息留在服务端日志。
 *
 * **有意保持签名为单参数、不接 `db`/`layout`**（I-1c/I-1d）：本函数只做
 * 「内部错误 → 工具错误码」这一件事，是纯函数、不做 IO，因此在 `tests/errors.test.ts`
 * 里可以完全脱离数据库和文件系统被单测。两类请求作用域的信息——`TASK_NOT_FOUND`
 * 需要的活跃任务清单（要查 `db`）、`message` 里可能残留的宿主绝对路径需要的脱敏
 * 前缀（要查 `layout`）——都不在这里处理，而是在 Task 3 的工具处理器里（那里本来
 * 就持有 `db`/`layout`，且规格已经把它定为"唯一把内部异常翻译成 error{code} 信封
 * 的地方"）在拿到本函数的结果之后原地补充。把这两样东西塞进这里，换来的只是一个
 * 更难单测、却没有任何调用方需要的可选参数。
 */
export function toToolError(e: unknown): ToolError {
  const code = structuredCode(e);
  const hit = code === null ? undefined : MAP[code];
  if (hit === undefined) {
    return {
      code: "INTERNAL",
      message: "Gateway 内部错误。详情见服务端日志。",
      retryable: false,
      details: {},
    };
  }
  return {
    code: hit.code,
    message: (e as Error).message,
    retryable: hit.retryable,
    details: {},
  };
}

/**
 * 抹掉绝对路径的宿主前缀：错误消息要进 ChatGPT 对话，D12 下等同于对外发布
 * （消费者账号默认用对话内容训练模型）。只做字符串替换，不解析路径——
 * 调用方决定"哪些前缀算敏感"（Task 3 传 `[layout.workspaceRoot, layout.controlRoot]`）。
 * 由 Task 3 的工具处理器在拿到 `toToolError()` 的结果之后调用，见 I-1c。
 */
export function redact(msg: string, roots: readonly string[]): string {
  return roots.reduce((m, r) => m.replaceAll(r, "<workspace>"), msg);
}
