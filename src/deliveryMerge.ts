import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beginAudit } from "./audit.ts";
import {
  transitionAuthorization,
  type AuthorizationStages,
} from "./deliveryAuthorization.ts";
import { StateError } from "./errors.ts";
import { GitExecError, safeGit } from "./gitExec.ts";
import type { Layout } from "./layout.ts";
import { resolveRepoPath } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { openPinnedWorktree } from "./worktree.ts";

/**
 * Minimal V2 Task 5：authorization-gated exact merge 的 Git 证据与 pinned release source。
 * 设计来源：docs/superpowers/specs/2026-09-04-...-design.md §10.2 / §14.3。
 *
 * 安全不变量：
 * - 绝不因为 GitHub 返回 merged=true 就推断 tree 正确：merge commit 的两个 parent
 *   必须按顺序等于 binding 的 baseSha/headSha，tree 必须等于 expectedMergeTree，
 *   全部用本机 safe Git（argv 数组、hooks 禁用）现查。
 * - release source 是固定在 mergeSha 的 detached worktree（ keyed by
 *   authorizationId/mergeSha ），绝不回退为部署当时的 canonical main——canonical
 *   之后可以被其他任务推进，pinned source 不动。
 * - merge receipt 是 durable 且不可变的控制平面证据（controlRoot 之下，0600），
 *   同一 authorizationId 写入不同内容即 STALE_STATE。
 */

const SHA_RE = /^[0-9a-f]{40}$/;
/** authorizationId 由 Task 2 生成为 authz_<uuid>；它是文件路径的一部分，形状必须锁死。 */
const AUTHORIZATION_ID_RE = /^authz_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECEIPT_BYTES = 16 * 1024;

export interface ExactMergeReceipt {
  authorizationId: string;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  mergeTree: string;
  releaseSourceRealpath: string;
}

function assertSha(value: string, field: string): void {
  if (!SHA_RE.test(value)) {
    throw new StateError(
      "INVALID_INPUT",
      `${field} 不是 40 位十六进制 SHA（收到 ${JSON.stringify(value)}），拒绝不精确的身份。`,
    );
  }
}

function assertAuthorizationId(value: string): void {
  if (!AUTHORIZATION_ID_RE.test(value)) {
    throw new StateError(
      "INVALID_INPUT",
      `authorizationId 形状非法（收到 ${JSON.stringify(value)}）；它会被拼进控制平面路径，形状必须锁死。`,
    );
  }
}

function gitDetail(error: unknown): string {
  if (error instanceof GitExecError) return error.message.replace(/^git failed:\s*/u, "");
  return error instanceof Error ? error.message : String(error);
}

function git(cwd: string, args: string[]): string {
  try {
    return safeGit.local(cwd, args);
  } catch (error) {
    throw new StateError("GIT_FAILED", `git ${args[0]} 失败：${gitDetail(error)}`);
  }
}

/**
 * `git merge-tree --write-tree <baseSha> <headSha>` 的唯一 tree identity。
 * merge 冲突时 git 以非零退出——fail closed，绝不接受带冲突的 tree。
 */
export function computeExpectedMergeTree(repoPath: string, baseSha: string, headSha: string): string {
  assertSha(baseSha, "baseSha");
  assertSha(headSha, "headSha");
  const out = git(repoPath, ["merge-tree", "--write-tree", baseSha, headSha]).trim();
  const tree = out.split("\n")[0]?.trim() ?? "";
  assertSha(tree, "merge-tree output");
  return tree;
}

/**
 * 验证 returned merge SHA 的精确 Git 证据：两个 parent 按顺序为 baseSha/headSha，
 * tree 等于 expectedMergeTree。任一不符即抛错——调用方必须把 authorization 置为
 * UNCERTAIN 并禁止 deploy，绝不能凭 merged=true 放行。
 */
export function verifyMergedCommit(input: {
  repoPath: string;
  authorizationId: string;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  expectedMergeTree: string;
}): Omit<ExactMergeReceipt, "releaseSourceRealpath"> {
  const { repoPath, authorizationId, baseSha, headSha, mergeSha, expectedMergeTree } = input;
  assertAuthorizationId(authorizationId);
  assertSha(baseSha, "baseSha");
  assertSha(headSha, "headSha");
  assertSha(mergeSha, "mergeSha");
  assertSha(expectedMergeTree, "expectedMergeTree");

  const line = git(repoPath, ["rev-list", "--parents", "-n", "1", mergeSha]).trim();
  const parts = line.split(/\s+/u);
  if (parts[0] !== mergeSha || parts.length !== 3) {
    throw new StateError(
      "STALE_STATE",
      `merge 证据不符：${mergeSha} 不是恰好两个 parent 的 merge commit（rev-list 给出 ${parts.length - 1} 个 parent）。`,
    );
  }
  if (parts[1] !== baseSha || parts[2] !== headSha) {
    throw new StateError(
      "STALE_STATE",
      `merge 证据不符：${mergeSha} 的 parents=[${parts[1]}, ${parts[2]}]，` +
        `期望按顺序为 [baseSha=${baseSha}, headSha=${headSha}]。`,
    );
  }
  const tree = git(repoPath, ["rev-parse", `${mergeSha}^{tree}`]).trim();
  if (tree !== expectedMergeTree) {
    throw new StateError(
      "STALE_STATE",
      `merge 证据不符：${mergeSha} 的 tree=${tree}，不等于 expectedMergeTree=${expectedMergeTree}。`,
    );
  }
  return { authorizationId, baseSha, headSha, mergeSha, mergeTree: tree };
}

function releaseSourcesRoot(layout: Layout): string {
  return join(layout.derivedRoot, "release-sources");
}

function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * 创建或确认一个固定在 mergeSha 的 clean pinned release source（detached worktree，
 * keyed by authorizationId/mergeSha）。已存在时只重新验证 realpath/HEAD/tree/clean，
 * 任何一项不符都 fail closed——绝不重建或复用可疑目录。canonical 之后被其他任务
 * 推进也不影响这个 pinned source。
 */
export function ensurePinnedReleaseSource(input: {
  layout: Layout;
  repoId: string;
  authorizationId: string;
  mergeSha: string;
  expectedTree: string;
}): { realpath: string; headSha: string; tree: string } {
  const { layout, repoId, authorizationId, mergeSha, expectedTree } = input;
  assertAuthorizationId(authorizationId);
  assertSha(mergeSha, "mergeSha");
  assertSha(expectedTree, "expectedTree");

  const dir = join(releaseSourcesRoot(layout), repoId, `${authorizationId}-${mergeSha}`);
  openPinnedWorktree(layout, repoId, { dir, commit: mergeSha });

  const realpath = realpathSync(dir);
  if (!isUnder(realpathSync(releaseSourcesRoot(layout)), realpath)) {
    throw new StateError(
      "POLICY_DENIED",
      `release source realpath ${realpath} 不在 ${releaseSourcesRoot(layout)} 之下，拒绝使用。`,
    );
  }
  const headSha = git(realpath, ["rev-parse", "HEAD"]).trim();
  if (headSha !== mergeSha) {
    throw new StateError(
      "STALE_STATE",
      `pinned release source 的 HEAD=${headSha}，不是已验证的 merge SHA ${mergeSha}；拒绝复用。`,
    );
  }
  const tree = git(realpath, ["rev-parse", "HEAD^{tree}"]).trim();
  if (tree !== expectedTree) {
    throw new StateError(
      "STALE_STATE",
      `pinned release source 的 tree=${tree}，不等于 expectedMergeTree=${expectedTree}。`,
    );
  }
  const dirty = git(realpath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (dirty.length > 0) {
    throw new StateError(
      "STALE_STATE",
      `pinned release source 不是 clean 状态（有未提交改动或未跟踪文件）；拒绝作为部署来源。`,
    );
  }
  return { realpath, headSha, tree };
}

function receiptPath(layout: Layout, authorizationId: string): string {
  assertAuthorizationId(authorizationId);
  return join(layout.controlRoot, "receipts", "delivery-merge", `${authorizationId}.json`);
}

function assertReceiptShape(value: unknown): ExactMergeReceipt {
  const r = value as Partial<ExactMergeReceipt> | null;
  if (!r || typeof r !== "object") {
    throw new StateError("INVALID_INPUT", "merge receipt 不是 object。");
  }
  if (typeof r.authorizationId !== "string" || !AUTHORIZATION_ID_RE.test(r.authorizationId)) {
    throw new StateError("INVALID_INPUT", "receipt.authorizationId 形状非法。");
  }
  assertSha(r.baseSha as string, "receipt.baseSha");
  assertSha(r.headSha as string, "receipt.headSha");
  assertSha(r.mergeSha as string, "receipt.mergeSha");
  assertSha(r.mergeTree as string, "receipt.mergeTree");
  if (typeof r.releaseSourceRealpath !== "string" || !isAbsolute(r.releaseSourceRealpath)) {
    throw new StateError("INVALID_INPUT", "receipt.releaseSourceRealpath 不是绝对路径。");
  }
  return r as ExactMergeReceipt;
}

/**
 * 持久化 durable merge stage receipt（控制平面、0600）。同一 authorizationId 重复
 * 写入相同内容是幂等 no-op（响应丢失重放不该被罚）；写入不同内容即 STALE_STATE——
 * receipt 是不可变证据，不允许覆盖。
 */
export function persistExactMergeReceipt(layout: Layout, receipt: ExactMergeReceipt): void {
  const checked = assertReceiptShape(receipt);
  const path = receiptPath(layout, checked.authorizationId);
  const serialized = `${JSON.stringify(checked, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES) {
    throw new StateError("INVALID_INPUT", "merge receipt 超过大小上限。");
  }
  if (existsSync(path)) {
    const existing = readExactMergeReceipt(layout, checked.authorizationId);
    if (JSON.stringify(existing) !== JSON.stringify(checked)) {
      throw new StateError(
        "STALE_STATE",
        `authorization ${checked.authorizationId} 的 merge receipt 已存在且内容不同；证据不可变，拒绝覆盖。`,
      );
    }
    return;
  }
  mkdirSync(join(layout.controlRoot, "receipts", "delivery-merge"), { recursive: true });
  writeFileSync(path, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

/** 读取 durable merge stage receipt；没有返回 null，形状非法即抛错（fail closed）。 */
export function readExactMergeReceipt(layout: Layout, authorizationId: string): ExactMergeReceipt | null {
  const path = receiptPath(layout, authorizationId);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) {
    throw new StateError("INVALID_INPUT", `merge receipt ${authorizationId} 超过大小上限。`);
  }
  return assertReceiptShape(JSON.parse(text));
}

/**
 * merge 后的 exact 证据检查失败（规格 §10.2）：CAS EXECUTING → UNCERTAIN 并落账。
 * UNCERTAIN 是终态——后续 deploy 读不到有效 receipt，也推进不了状态机。
 */
export function markMergeAuthorizationUncertain(
  db: DatabaseSync,
  authorization: {
    authorizationId: string;
    bindingDigest: string;
    taskId: string;
    stages: AuthorizationStages;
  },
  reason: string,
): void {
  const audit = beginAudit(db, {
    taskId: authorization.taskId,
    tool: "grande_delivery_merge",
    input: {
      authorizationId: authorization.authorizationId,
      bindingDigest: authorization.bindingDigest,
      outcome: "UNCERTAIN",
      taskId: authorization.taskId,
    },
  });
  audit.allowed();
  if (!audit.executing()) {
    throw new StateError("STALE_STATE", `任务 ${authorization.taskId} 的 delivery merge 审计句柄无法推进到 EXECUTING。`);
  }
  try {
    transitionAuthorization(
      db,
      authorization.authorizationId,
      authorization.bindingDigest,
      "EXECUTING",
      "UNCERTAIN",
      authorization.stages,
      reason,
    );
    audit.succeeded([]);
  } catch (error) {
    audit.failed(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** canonical repo 的本机路径（verify/pin 都在它上面做，worktree 可能已被清理）。 */
export function canonicalRepoPath(layout: Layout, repoId: string): string {
  return resolveRepoPath(layout, repoId, registeredIds(layout));
}
