import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubAuthError, loadGithubToken, redactToken } from "../src/githubAuth.ts";
import type { Layout } from "../src/layout.ts";

let root: string;
let layout: Layout;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "github-auth-"));
  const workspaceRoot = join(root, "workspace");
  const controlRoot = join(root, "control");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  layout = {
    workspaceRoot,
    controlRoot,
    stateDb: join(controlRoot, "state", "grande.db"),
    configDir: join(controlRoot, "config"),
    reposConfig: join(controlRoot, "config", "repos.yaml"),
    artifactsDir: join(controlRoot, "artifacts"),
    derivedRoot: join(workspaceRoot, ".grande-work"),
    worktreesRoot: join(workspaceRoot, ".grande-work", "worktrees"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function tokenPath(): string {
  return join(layout.controlRoot, "secrets", "github-token");
}

function writeToken(value: string, mode = 0o600): void {
  mkdirSync(join(layout.controlRoot, "secrets"), { recursive: true });
  writeFileSync(tokenPath(), value, { encoding: "utf8", mode });
}

describe("loadGithubToken", () => {
  it("AC-S3-1：文件缺失时 fail closed，并给出 MISSING_TOKEN", () => {
    try {
      loadGithubToken(layout);
      throw new Error("expected loadGithubToken to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GithubAuthError);
      expect((error as GithubAuthError).code).toBe("MISSING_TOKEN");
      expect((error as Error).message).toMatch(/github-token|PAT/);
    }
  });

  it.each(["", "   \n\t"])("AC-S3-1：空或纯空白 token（%j）同样拒绝", (value) => {
    writeToken(value);
    expect(() => loadGithubToken(layout)).toThrowError(
      expect.objectContaining({ code: "MISSING_TOKEN" }),
    );
  });

  it("读取后 trim 尾换行", () => {
    writeToken("github_pat_example_secret\n");
    expect(loadGithubToken(layout)).toEqual({ token: "github_pat_example_secret" });
  });

  it("权限为 0644 时不把可修复权限问题升级成硬故障", () => {
    writeToken("github_pat_example_secret\n", 0o644);
    expect(loadGithubToken(layout).token).toBe("github_pat_example_secret");
  });
});

describe("redactToken", () => {
  const token = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";

  it("AC-S3-3：完整 token 被替换，结果不保留可识别前缀", () => {
    const result = redactToken(`boom: ${token} tail`, token);
    expect(result).toBe("boom: <redacted> tail");
    expect(result).not.toContain(token);
    expect(result).not.toContain(token.slice(0, 20));
  });

  it("上游只回显 token 前 30 字符时也脱敏", () => {
    const prefix = token.slice(0, 30);
    const result = redactToken(`boom: ${prefix}...`, token);
    expect(result).toBe("boom: <redacted>...");
    expect(result).not.toContain(prefix);
    expect(result).not.toContain(token.slice(0, 20));
  });

  it("空 token 不做危险的空字符串替换", () => {
    expect(redactToken("plain error", "")).toBe("plain error");
  });
});
