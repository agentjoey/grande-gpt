import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRepoPolicy,
  mergePolicy,
  type RepoPolicy,
} from "../src/repoPolicy.ts";

const roots: string[] = [];

function makeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), "grande-repo-policy-"));
  roots.push(root);
  return root;
}

function writePolicy(worktreeRoot: string, yaml: string): void {
  const dir = join(worktreeRoot, ".grande");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "policy.yaml"), yaml, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("mergePolicy()", () => {
  it("AC-S15-1：repo 没有列出全局 readOnlyPaths 时，全局规则仍全部保留", () => {
    const globalPolicy: RepoPolicy = {
      readOnlyPaths: [".github/workflows/**", "infra/prod/**"],
      pairedEdits: [{ when: "src/**", require: "tests/**" }],
    };
    const repoPolicy: RepoPolicy = { readOnlyPaths: [], pairedEdits: [] };

    expect(mergePolicy(globalPolicy, repoPolicy)).toEqual(globalPolicy);
  });

  it("AC-S15-2：repo 新增的 readOnlyPaths 与 pairedEdits 会并入，重复项只保留一次", () => {
    const sharedPair = { when: "src/**", require: "tests/**" };
    const merged = mergePolicy(
      { readOnlyPaths: [".github/workflows/**"], pairedEdits: [sharedPair] },
      {
        readOnlyPaths: [".github/workflows/**", "generated/**"],
        pairedEdits: [sharedPair, { when: "schema/**", require: "generated/**" }],
      },
    );

    expect(merged).toEqual({
      readOnlyPaths: [".github/workflows/**", "generated/**"],
      pairedEdits: [
        sharedPair,
        { when: "schema/**", require: "generated/**" },
      ],
    });
  });
});

describe("loadRepoPolicy()", () => {
  it("读取有效 policy.yaml，并保留 glob 与配对规则", () => {
    const worktree = makeWorktree();
    writePolicy(
      worktree,
      [
        "readOnlyPaths:",
        "  - .github/workflows/**",
        "  - '**/*.generated.ts'",
        "pairedEdits:",
        "  - when: src/**",
        "    require: tests/**",
        "",
      ].join("\n"),
    );

    expect(loadRepoPolicy(worktree)).toEqual({
      readOnlyPaths: [".github/workflows/**", "**/*.generated.ts"],
      pairedEdits: [{ when: "src/**", require: "tests/**" }],
    });
  });

  it("policy.yaml 不存在时返回空规则，不抛错", () => {
    expect(loadRepoPolicy(makeWorktree())).toEqual({ readOnlyPaths: [], pairedEdits: [] });
  });

  it("AC-S15-6：YAML 语法错误时抛 BAD_CONFIG，而不是静默返回空规则", () => {
    const worktree = makeWorktree();
    writePolicy(worktree, "readOnlyPaths: [unterminated\n");

    expect(() => loadRepoPolicy(worktree)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("字段结构错误时 fail closed", () => {
    const worktree = makeWorktree();
    writePolicy(worktree, "readOnlyPaths: src/**\n");

    expect(() => loadRepoPolicy(worktree)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it(".grande/policy.yaml 是目录时抛 BAD_CONFIG，不崩溃", () => {
    const worktree = makeWorktree();
    mkdirSync(join(worktree, ".grande", "policy.yaml"), { recursive: true });

    expect(() => loadRepoPolicy(worktree)).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });
});
