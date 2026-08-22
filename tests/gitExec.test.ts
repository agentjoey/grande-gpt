import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeGit } from "../src/gitExec.ts";

const rawGit = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const roots: string[] = [];

function makeRepo(prefix = "gitexec-"): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  roots.push(repo);
  rawGit(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "one\n", "utf8");
  rawGit(repo, "add", "tracked.txt");
  rawGit(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
  return repo;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("safeGit", () => {
  it("local mode disables repository hooks", () => {
    const repo = makeRepo();
    const hooks = join(repo, ".githooks");
    mkdirSync(hooks);
    const marker = join(repo, "hook-marker");
    const hook = join(hooks, "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nprintf escaped > ${JSON.stringify(marker)}\n`, "utf8");
    chmodSync(hook, 0o755);
    rawGit(repo, "config", "core.hooksPath", hooks);

    writeFileSync(join(repo, "tracked.txt"), "two\n", "utf8");
    safeGit.local(repo, ["add", "tracked.txt"]);
    safeGit.local(repo, ["-c", "user.name=Safe", "-c", "user.email=safe@example.com", "commit", "-q", "-m", "safe"]);

    expect(existsSync(marker)).toBe(false);
  });

  it("github mode never falls back to repository credential helpers and redacts the token", () => {
    const repo = makeRepo();
    const marker = join(repo, "credential-marker");
    const helper = join(repo, "credential-helper.sh");
    writeFileSync(helper, `#!/bin/sh\nprintf helper > ${JSON.stringify(marker)}\nprintf 'username=leaked\\npassword=leaked\\n'\n`, "utf8");
    chmodSync(helper, 0o755);
    rawGit(repo, "config", "credential.helper", `!${helper}`);
    const token = "ghp_SAFE_GIT_TEST_TOKEN_123456";

    expect(() => safeGit.github(repo, ["credential", "fill"], token, {
      input: "protocol=https\nhost=example.invalid\n\n",
    })).toThrowError(expect.not.stringContaining(token));
    expect(existsSync(marker)).toBe(false);
  });

  it("diff mode disables external diff and textconv helpers", () => {
    const repo = makeRepo();
    const externalMarker = join(repo, "external-marker");
    const external = join(repo, "external-diff.sh");
    writeFileSync(external, `#!/bin/sh\nprintf external > ${JSON.stringify(externalMarker)}\nexit 91\n`, "utf8");
    chmodSync(external, 0o755);
    rawGit(repo, "config", "diff.external", external);
    writeFileSync(join(repo, "tracked.txt"), "two\n", "utf8");

    const externalOutput = safeGit.diff(repo, ["diff", "HEAD", "--", "tracked.txt"]);
    expect(externalOutput).toContain("+two");
    expect(existsSync(externalMarker)).toBe(false);

    rawGit(repo, "config", "--unset", "diff.external");
    const textconvMarker = join(repo, "textconv-marker");
    const textconv = join(repo, "textconv.sh");
    writeFileSync(textconv, `#!/bin/sh\nprintf textconv > ${JSON.stringify(textconvMarker)}\ncat "$1"\n`, "utf8");
    chmodSync(textconv, 0o755);
    writeFileSync(join(repo, ".gitattributes"), "tracked.txt diff=custom\n", "utf8");
    rawGit(repo, "config", "diff.custom.textconv", textconv);

    const textconvOutput = safeGit.diff(repo, ["diff", "HEAD", "--", "tracked.txt"]);
    expect(textconvOutput).toContain("+two");
    expect(existsSync(textconvMarker)).toBe(false);
  });

  it("revalidates expected branch before a write side effect", () => {
    const repo = makeRepo();
    rawGit(repo, "checkout", "-q", "-b", "other");

    expect(() => safeGit.local(repo, ["tag", "unsafe-branch"], { expectedBranch: "main" })).toThrow(/branch/i);
    expect(rawGit(repo, "tag", "--list", "unsafe-branch").trim()).toBe("");
  });

  it("revalidates expected HEAD before a write side effect", () => {
    const repo = makeRepo();
    const expectedHead = rawGit(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "tracked.txt"), "drifted\n", "utf8");
    rawGit(repo, "add", "tracked.txt");
    rawGit(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "drift");

    expect(() => safeGit.local(repo, ["tag", "unsafe-head"], { expectedHead })).toThrow(/HEAD/i);
    expect(rawGit(repo, "tag", "--list", "unsafe-head").trim()).toBe("");
  });

  it("bounds stdout and redacts cwd from errors", () => {
    const repo = makeRepo("gitexec-secret-path-");
    for (let i = 0; i < 20; i++) writeFileSync(join(repo, `untracked-${i}-${"x".repeat(20)}.txt`), "x\n", "utf8");
    const output = safeGit.local(repo, ["status", "--porcelain=v1"], { maxOutputBytes: 64 });
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(64);

    let message = "";
    try {
      safeGit.local(repo, ["show", join(repo, "missing-secret-file")]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(repo);
    expect(message).toContain("<repo>");
  });

  it("does not retry a failing local git execution", () => {
    const repo = makeRepo();
    const trace = join(repo, "trace.jsonl");
    const previousTrace = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    try {
      expect(() => safeGit.local(repo, ["rev-parse", "refs/heads/definitely-missing"])).toThrow();
    } finally {
      process.env.GIT_TRACE2_EVENT = previousTrace;
    }
    const starts = readFileSync(trace, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string })
      .filter((event) => event.event === "start");
    expect(starts).toHaveLength(1);
  });
});
