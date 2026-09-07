import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeExpectedMergeTree,
  ensurePinnedReleaseSource,
  persistExactMergeReceipt,
  readExactMergeReceipt,
  verifyMergedCommit,
  type ExactMergeReceipt,
} from "../src/deliveryMerge.ts";
import { createGithubApi } from "../src/githubApi.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";

/**
 * Minimal V2 Task 5：exact merge 证据与 pinned release source。
 * 设计来源：docs/superpowers/specs/2026-09-04-...-design.md §10.2 / §14.3。
 * 这些测试全部用真实 git 仓库承重——parents/tree 的精确性不能用字符串 mock 冒充。
 */

const git = (cwd: string, ...args: string[]) => execFileSync(
  "git",
  ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();

const AUTHORIZATION_ID = "authz_123e4567-e89b-42d3-a456-426614174000";

let root: string;
let layout: Layout;
let canonical: string;
let baseSha: string;
let headSha: string;
let mergeSha: string;
let expectedTree: string;

function commitFile(dir: string, name: string, content: string, message: string): string {
  writeFileSync(join(dir, name), content, "utf8");
  git(dir, "add", name);
  git(dir, "-c", "user.name=GrandeGPT", "-c", "user.email=grande@example.com", "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "delivery-merge-"));
  process.env.GRANDE_WORKSPACE = join(root, "workspace");
  process.env.GRANDE_CONTROL = join(root, "control");
  mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
  mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });
  layout = loadLayout();
  ensureLayout(layout);

  canonical = join(layout.workspaceRoot, "demo");
  mkdirSync(canonical, { recursive: true });
  git(canonical, "init", "-q", "-b", "main");
  baseSha = commitFile(canonical, "base.txt", "base\n", "base");
  saveRegistry(layout, [{ repoId: "demo", path: canonical, registered: true }]);

  // head：从 base 派生一个 feature commit（真实进入 canonical 的 odb）。
  git(canonical, "switch", "-q", "-c", "grande/feature");
  headSha = commitFile(canonical, "feature.txt", "feature\n", "feature");
  git(canonical, "switch", "-q", "main");

  expectedTree = git(canonical, "merge-tree", "--write-tree", baseSha, headSha);
  // 真实 merge commit：parents = [baseSha, headSha]，tree = expectedTree。
  git(canonical, "merge", "--no-ff", "-q", "-m", "merge feature", headSha);
  mergeSha = git(canonical, "rev-parse", "HEAD");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("computeExpectedMergeTree", () => {
  it("返回 git merge-tree --write-tree 的唯一 tree identity", () => {
    expect(computeExpectedMergeTree(canonical, baseSha, headSha)).toBe(expectedTree);
    expect(expectedTree).toMatch(/^[0-9a-f]{40}$/);
  });

  it("merge 冲突是 blocker（fail closed），不返回带冲突的 tree", () => {
    // 两边都改同一个文件同一行 → merge-tree 以非零退出。
    git(canonical, "switch", "-q", "-c", "grande/conflict", baseSha);
    const conflictHead = commitFile(canonical, "base.txt", "ours\n", "conflict");
    git(canonical, "switch", "-q", "main");
    const otherBase = commitFile(canonical, "base.txt", "theirs\n", "other base");
    expect(() => computeExpectedMergeTree(canonical, otherBase, conflictHead)).toThrow();
  });

  it("垃圾 SHA 直接拒绝，不调用 git", () => {
    expect(() => computeExpectedMergeTree(canonical, "not-a-sha", headSha)).toThrowError(/INVALID_INPUT|40/);
    expect(() => computeExpectedMergeTree(canonical, baseSha, "z".repeat(40))).toThrowError(/INVALID_INPUT|40/);
  });
});

describe("verifyMergedCommit", () => {
  const input = () => ({
    repoPath: canonical,
    authorizationId: AUTHORIZATION_ID,
    baseSha,
    headSha,
    mergeSha,
    expectedMergeTree: expectedTree,
  });

  it("parents=[base,head] 且 tree=expectedMergeTree 时返回精确 receipt（无 releaseSourceRealpath）", () => {
    const receipt = verifyMergedCommit(input());
    expect(receipt).toEqual({
      authorizationId: AUTHORIZATION_ID,
      baseSha,
      headSha,
      mergeSha,
      mergeTree: expectedTree,
    });
  });

  it("非 merge commit（单 parent）被拒绝", () => {
    expect(() => verifyMergedCommit({ ...input(), mergeSha: headSha })).toThrowError(/parent|merge/i);
  });

  it("parent 顺序颠倒（head 在前）被拒绝", () => {
    // 真实 merge commit 的 parents=[baseSha, headSha]；把 binding 期望颠倒过来必须失败——
    // 顺序本身就是证据的一部分。
    expect(() => verifyMergedCommit({ ...input(), baseSha: headSha, headSha: baseSha }))
      .toThrowError(/parent/i);
  });

  it("tree 与 expectedMergeTree 不符被拒绝", () => {
    const wrongTree = git(canonical, "rev-parse", `${baseSha}^{tree}`);
    expect(wrongTree).not.toBe(expectedTree);
    expect(() => verifyMergedCommit({ ...input(), expectedMergeTree: wrongTree })).toThrowError(/tree/i);
  });

  it("不存在的 mergeSha 被拒绝", () => {
    expect(() => verifyMergedCommit({ ...input(), mergeSha: "f".repeat(40) })).toThrow();
  });

  it("authorizationId 形状非法（路径逃逸嫌疑）被拒绝", () => {
    expect(() => verifyMergedCommit({ ...input(), authorizationId: "../../etc" })).toThrowError(/INVALID_INPUT|形状非法/);
  });
});

describe("ensurePinnedReleaseSource", () => {
  const input = () => ({
    layout,
    repoId: "demo",
    authorizationId: AUTHORIZATION_ID,
    mergeSha,
    expectedTree,
  });

  it("创建固定在 mergeSha 的 detached worktree：realpath/HEAD/tree 全部精确", () => {
    const pinned = ensurePinnedReleaseSource(input());
    expect(pinned.headSha).toBe(mergeSha);
    expect(pinned.tree).toBe(expectedTree);
    expect(existsSync(pinned.realpath)).toBe(true);
    // detached：--abbrev-ref 在 detached HEAD 下解析为字面量 "HEAD"，而不是分支名。
    expect(readFileSync(join(pinned.realpath, ".git"), "utf8")).toMatch(/^gitdir: /);
    expect(git(pinned.realpath, "rev-parse", "HEAD")).toBe(mergeSha);
    expect(git(pinned.realpath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  });

  it("canonical 之后继续前进，pinned release source 仍钉在 mergeSha", () => {
    const pinned = ensurePinnedReleaseSource(input());
    commitFile(canonical, "later.txt", "later\n", "canonical advances");
    expect(git(canonical, "rev-parse", "HEAD")).not.toBe(mergeSha);
    expect(git(pinned.realpath, "rev-parse", "HEAD")).toBe(mergeSha);
    // 重复调用是确认而不是重建：同一 realpath，HEAD 不变。
    const again = ensurePinnedReleaseSource(input());
    expect(again).toEqual(pinned);
  });

  it("pinned worktree 被弄脏时 fail closed", () => {
    const pinned = ensurePinnedReleaseSource(input());
    writeFileSync(join(pinned.realpath, "tampered.txt"), "x\n", "utf8");
    expect(() => ensurePinnedReleaseSource(input())).toThrowError(/clean|dirty|改动/i);
  });

  it("已存在目录的 HEAD 漂移时拒绝复用", () => {
    const pinned = ensurePinnedReleaseSource(input());
    git(pinned.realpath, "reset", "--hard", "-q", baseSha);
    expect(() => ensurePinnedReleaseSource(input())).toThrowError();
  });

  it("release source 落在 derivedRoot/release-sources 之下", () => {
    const pinned = ensurePinnedReleaseSource(input());
    expect(pinned.realpath.startsWith(join(layout.derivedRoot, "release-sources"))).toBe(true);
  });

  it("垃圾 mergeSha / 路径逃逸 authorizationId 被拒绝", () => {
    expect(() => ensurePinnedReleaseSource({ ...input(), mergeSha: "g".repeat(40) })).toThrowError(/INVALID_INPUT|40 位十六进制/);
    expect(() => ensurePinnedReleaseSource({ ...input(), authorizationId: "authz_../../x" })).toThrowError(/INVALID_INPUT|形状非法/);
  });
});

describe("exact merge receipt 持久化", () => {
  const receipt = (): ExactMergeReceipt => ({
    authorizationId: AUTHORIZATION_ID,
    baseSha,
    headSha,
    mergeSha,
    mergeTree: expectedTree,
    releaseSourceRealpath: join(layout.derivedRoot, "release-sources", "demo", `${AUTHORIZATION_ID}-${mergeSha}`),
  });

  it("写入后可读回；重复写入相同内容幂等", () => {
    persistExactMergeReceipt(layout, receipt());
    expect(readExactMergeReceipt(layout, AUTHORIZATION_ID)).toEqual(receipt());
    persistExactMergeReceipt(layout, receipt());
    expect(readExactMergeReceipt(layout, AUTHORIZATION_ID)).toEqual(receipt());
  });

  it("同一 authorizationId 写入不同 receipt 被拒绝（不可变证据）", () => {
    persistExactMergeReceipt(layout, receipt());
    expect(() => persistExactMergeReceipt(layout, { ...receipt(), mergeSha: baseSha }))
      .toThrowError(/STALE_STATE|不可变/);
  });

  it("没有 receipt 时读回 null", () => {
    expect(readExactMergeReceipt(layout, AUTHORIZATION_ID)).toBeNull();
  });
});

describe("githubApi merge 请求绑定", () => {
  it("merge 调用同时发送 sha=headSha 与 merge_method=merge", async () => {
    const bodies: unknown[] = [];
    const api = createGithubApi("github_pat_test", async (url, init) => {
      expect(String(url)).toContain("/pulls/7/merge");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ merged: true, sha: "abc", message: "ok" }), { status: 200 });
    });
    await api.mergePullRequest("o", "r", 7, "e".repeat(40));
    expect(bodies).toEqual([{ sha: "e".repeat(40), merge_method: "merge" }]);
  });
});
