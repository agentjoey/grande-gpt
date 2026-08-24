import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProfile, type SandboxPaths } from "../../src/sbpl.ts";
import { defaultExecRoots, runSandboxed } from "../../src/sandbox.ts";

let root: string;
let paths: SandboxPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-toolchain-sandbox-"));
  paths = {
    worktree: join(root, "worktree"),
    canonicalGit: join(root, "canonical", ".git"),
    jobTmp: join(root, "jobtmp"),
    controlRoot: join(root, "control"),
    worktreesRoot: join(root, "worktrees"),
    execRoots: defaultExecRoots(),
  };
  for (const dir of [paths.worktree, paths.canonicalGit, paths.jobTmp, paths.controlRoot, paths.worktreesRoot]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeProbe(): { source: string; output: string } {
  const source = join(paths.worktree, "probe.c");
  const output = join(paths.worktree, "probe");
  writeFileSync(source, "int main(void) { return 0; }\n", "utf8");
  return { source, output };
}

function clangArgv(source: string, output: string): string[] {
  return ["/usr/bin/clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", source, "-o", output];
}

function runWithoutVarSelectAlias(source: string, output: string) {
  const canonical: SandboxPaths = {
    worktree: realpathSync(paths.worktree),
    canonicalGit: realpathSync(paths.canonicalGit),
    jobTmp: realpathSync(paths.jobTmp),
    controlRoot: realpathSync(paths.controlRoot),
    worktreesRoot: realpathSync(paths.worktreesRoot),
    execRoots: paths.execRoots.map((value) => realpathSync(value)),
  };
  const profile = buildProfile(canonical)
    .split("\n")
    .filter((line) => line.trim() !== '(allow file-read* (subpath "/var/select"))')
    .join("\n");
  const profilePath = join(paths.jobTmp, "without-var-select.sb");
  writeFileSync(profilePath, profile, "utf8");
  return spawnSync("/usr/bin/sandbox-exec", ["-f", profilePath, ...clangArgv(source, output)], {
    cwd: paths.worktree,
    env: {
      PATH: canonical.execRoots.join(":"),
      HOME: join(paths.jobTmp, "home"),
      LANG: "en_US.UTF-8",
      TMPDIR: paths.jobTmp,
    },
    encoding: "utf8",
  });
}

describe("GG-BL-029 controlled macOS native toolchain execution", () => {
  it("lets fixed /usr/bin/clang resolve Developer Tools and compile repo-owned source/output", async () => {
    const { source, output } = writeProbe();

    const result = await runSandboxed({
      argv: clangArgv(source, output),
      cwd: paths.worktree,
      paths,
      timeoutMs: 20_000,
      maxOutputBytes: 65_536,
    });

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("load-bearing reverse proof: removing /var/select alias reintroduces xcode-select EPERM", () => {
    const { source, output } = writeProbe();

    const result = runWithoutVarSelectAlias(source, output);

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/\/var\/select\/developer_dir|operation not permitted/i);
  });
});
