import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveNativeToolchainClosure } from "../../src/nativeToolchain.ts";
import { buildProfile, type SandboxPaths } from "../../src/sbpl.ts";
import { defaultExecRoots, runSandboxed } from "../../src/sandbox.ts";

let root: string;
let paths: SandboxPaths;
let hostPrerequisiteError: string | null = null;
let hostPrerequisiteRoot: string | null = null;

beforeAll(() => {
  hostPrerequisiteRoot = mkdtempSync(join(tmpdir(), "native-toolchain-host-preflight-"));
  const source = join(hostPrerequisiteRoot, "probe.c");
  const output = join(hostPrerequisiteRoot, "probe");
  writeFileSync(source, "int main(void) { return 0; }\n", "utf8");
  const result = spawnSync("/usr/bin/clang", clangArgv(source, output).slice(1), { encoding: "utf8" });
  if (result.status !== 0) hostPrerequisiteError = result.stderr + result.stdout;
});

afterAll(() => {
  if (hostPrerequisiteRoot) rmSync(hostPrerequisiteRoot, { recursive: true, force: true });
});

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

function requireHostToolchainPrerequisites(): void {
  if (!hostPrerequisiteError) return;
  throw new Error(
    "HOST_PREREQUISITE_FAILED: unsandboxed /usr/bin/clang cannot compile a minimal C program on this host. " +
      hostPrerequisiteError.trim(),
  );
}

function writeProbe(): { source: string; output: string } {
  const source = join(paths.worktree, "probe.c");
  const output = join(paths.worktree, "probe");
  writeFileSync(source, "int main(void) { return 0; }\n", "utf8");
  return { source, output };
}

function clangArgv(source: string, output: string): string[] {
  return ["/usr/bin/clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", source, "-o", output];
}

function canonicalPaths(): SandboxPaths {
  const closure = resolveNativeToolchainClosure("darwin-clang");
  return {
    worktree: realpathSync(paths.worktree),
    canonicalGit: realpathSync(paths.canonicalGit),
    jobTmp: realpathSync(paths.jobTmp),
    controlRoot: realpathSync(paths.controlRoot),
    worktreesRoot: realpathSync(paths.worktreesRoot),
    execRoots: paths.execRoots.map((value) => realpathSync(value)),
    toolchainReadRoots: [...closure.readRoots],
    toolchainReadFiles: [...closure.readFiles],
    toolchainExecTargets: [...closure.execTargets],
  };
}

function runWithProfileTransform(source: string, output: string, transform: (profile: string, paths: SandboxPaths) => string) {
  const canonical = canonicalPaths();
  const profile = transform(buildProfile(canonical), canonical);
  const profilePath = join(paths.jobTmp, "native-toolchain-reverse.sb");
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

function xcodeContentsRoot(canonical: SandboxPaths): string | null {
  return canonical.toolchainReadRoots!.find((rootPath) => basename(rootPath) === "Contents" && basename(dirname(rootPath)).endsWith(".app")) ?? null;
}

describe("GG-BL-029 controlled macOS native toolchain execution", () => {
  it("host prerequisite: unsandboxed /usr/bin/clang can compile a minimal C program", () => {
    requireHostToolchainPrerequisites();
  });

  it("lets an approved darwin-clang profile compile repo-owned source/output", async () => {
    requireHostToolchainPrerequisites();
    const { source, output } = writeProbe();

    const result = await runSandboxed({
      argv: clangArgv(source, output),
      cwd: paths.worktree,
      paths,
      toolchain: "darwin-clang",
      timeoutMs: 20_000,
      maxOutputBytes: 65_536,
    });

    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("full Xcode closure does not retain redundant /var/select or child Developer roots", () => {
    requireHostToolchainPrerequisites();
    const canonical = canonicalPaths();
    if (!xcodeContentsRoot(canonical)) return;
    expect(canonical.toolchainReadRoots).not.toContain("/var/select");
    expect(canonical.toolchainReadRoots!.some((rootPath) => basename(rootPath) === "Developer")).toBe(false);
  });

  it("load-bearing reverse proof: removing Xcode Contents read root blocks Info.plist/shared-framework resolution", () => {
    requireHostToolchainPrerequisites();
    const canonical = canonicalPaths();
    const contents = xcodeContentsRoot(canonical);
    if (!contents) return;
    const { source, output } = writeProbe();
    const result = runWithProfileTransform(source, output, (profile) => profile
      .split("\n")
      .filter((line) => line.trim() !== `(allow file-read* (subpath "${contents}"))`)
      .join("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Info\.plist|SharedFrameworks|blocked by sandbox|operation not permitted|developer directory/i);
  });

  it("load-bearing reverse proof: CommandLineTools selector/developer roots are required when no Xcode Contents root exists", () => {
    requireHostToolchainPrerequisites();
    const canonical = canonicalPaths();
    if (xcodeContentsRoot(canonical)) return;
    const { source, output } = writeProbe();
    const removed = new Set(canonical.toolchainReadRoots);
    const result = runWithProfileTransform(source, output, (profile) => profile
      .split("\n")
      .filter((line) => ![...removed].some((rootPath) => line.trim() === `(allow file-read* (subpath "${rootPath}"))`))
      .join("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/operation not permitted|developer directory|xcode-select/i);
  });

  it("load-bearing reverse proof: removing exact Xcode license-state read reintroduces license denial", () => {
    requireHostToolchainPrerequisites();
    const canonical = canonicalPaths();
    const license = canonical.toolchainReadFiles!.find((file) => file === "/Library/Preferences/com.apple.dt.Xcode.plist");
    if (!license || !existsSync(license)) return;
    const { source, output } = writeProbe();
    const result = runWithProfileTransform(source, output, (profile) => profile
      .split("\n")
      .filter((line) => line.trim() !== `(allow file-read* (literal "${license}"))`)
      .join("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Xcode license agreements|xcodebuild -license/i);
  });

  it("load-bearing reverse proof: removing exact toolchain exec targets prevents the compile", () => {
    requireHostToolchainPrerequisites();
    const { source, output } = writeProbe();
    const result = runWithProfileTransform(source, output, (profile, canonical) => {
      const exactAllows = new Set(canonical.toolchainExecTargets!.map(
        (target) => `(allow process-exec (literal "${target}"))`,
      ));
      return profile
        .split("\n")
        .filter((line) => !exactAllows.has(line.trim()))
        .join("\n");
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/operation not permitted|not permitted/i);
  });
});
