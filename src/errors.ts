import { ArgError } from "./argCheck.ts";
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

/** 规格 §7 的工具错误码，外加 S2 merge 冲突与一个 INTERNAL 兜底 */
export type ToolErrorCode =
  | "INVALID_INPUT" | "UNAUTHORIZED" | "POLICY_DENIED" | "REPO_NOT_REGISTERED"
  | "TASK_NOT_FOUND" | "STALE_FILE" | "CANONICAL_BUSY" | "WORKTREE_DIRTY"
  | "PROFILE_NOT_FOUND" | "JOB_TIMEOUT" | "RESOURCE_EXHAUSTED" | "NETWORK_DENIED"
  | "MERGE_CONFLICT" | "INTERNAL";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

/** 内部码 → 工具码。规格 §7.1 那张表，外加 S2 的 MERGE_CONFLICT。 */
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
  WORKTREE_DIRTY:         { code: "WORKTREE_DIRTY",      retryable: false },
  MERGE_CONFLICT:         { code: "MERGE_CONFLICT",      retryable: false },
  JOB_NOT_FOUND:          { code: "INVALID_INPUT",       retryable: false },
  TASK_NOT_FOUND:         { code: "TASK_NOT_FOUND",      retryable: true  },
  JOB_RUNNING:            { code: "INVALID_INPUT",       retryable: true  },
  STALE_STATE:            { code: "INVALID_INPUT",       retryable: true  },
  PATH_SPELLING_MISMATCH: { code: "POLICY_DENIED",       retryable: false },
};

/**
 * 我们自己的错误类。只有这些类的实例参与映射；仓库数据不能靠伪造 code 字段
 * 冒充一次可信的策略或状态决定。
 */
const KNOWN = [
  ArgError,
  PathSecurityError, PolicyError, ProfileError, EditError,
  SearchError, MapError, RunnerError, GitError,
  SbplError, SandboxError, StateError,
] as const;

function structuredCode(e: unknown): string | null {
  if (!KNOWN.some((C) => e instanceof C)) return null;
  const c = (e as { code?: unknown }).code;
  return typeof c === "string" ? c : null;
}

/** 把任意抛出物翻译成发给 ChatGPT 的结构化错误信封。 */
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

/** 抹掉错误消息里的宿主绝对路径前缀。 */
export function redact(msg: string, roots: readonly string[]): string {
  return roots.reduce((m, r) => m.replaceAll(r, "<workspace>"), msg);
}
