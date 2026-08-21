import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeGit } from "../../src/gitExec.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grande-host-git-hook-probe-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rawGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("load-bearing Safe Git hook suppression", () => {
  it("executes a real raw Git hook and suppresses the same hook through Safe Git", () => {
    const repo = join(root, "repo");
    const marker = join(root, "hook-marker");
    mkdirSync(repo, { recursive: true });
    rawGit(repo, "init", "-q", "-b", "main");
    rawGit(repo, "config", "user.name", "Verifier Probe");
    rawGit(repo, "config", "user.email", "verifier@example.invalid");
    const gitDir = rawGit(repo, "rev-parse", "--git-dir").trim();
    const hook = join(repo, gitDir, "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nprintf hook > ${JSON.stringify(marker)}\n`, "utf8");
    chmodSync(hook, 0o755);

    rawGit(repo, "commit", "--allow-empty", "-q", "-m", "raw hook");
    expect(readFileSync(marker, "utf8")).toBe("hook");
    rmSync(marker);

    safeGit.local(repo, ["commit", "--allow-empty", "-q", "-m", "safe git"]);
    expect(existsSync(marker)).toBe(false);
  });
});
