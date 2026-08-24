import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { buildNativeExecSbplRules, resolveNativeExecTargets } from "../src/nativeExecTargets.ts";
import { loadProfiles } from "../src/profiles.ts";
import { buildProfile, type SandboxPaths } from "../src/sbpl.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

function writeConfig(body: string) {
  const layout = loadLayout();
  ensureLayout(layout);
  writeFileSync(join(layout.configDir, "profiles.yaml"), body, "utf8");
  return layout;
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "native-exec-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "native-exec-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("trusted profile nativeExecTargets", () => {
  it("loads fixed repo-relative exact native executable targets only on darwin-clang profiles", () => {
    const layout = writeConfig(
      'repos:\n  demo:\n    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300, toolchain: "darwin-clang", nativeExecTargets: ["native/bin/rename-excl"] }\n',
    );
    expect(loadProfiles(layout, "demo").get("unit")?.nativeExecTargets).toEqual(["native/bin/rename-excl"]);
  });

  it("rejects nativeExecTargets on a profile that did not opt into darwin-clang", () => {
    const layout = writeConfig(
      'repos:\n  demo:\n    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300, nativeExecTargets: ["native/bin/rename-excl"] }\n',
    );
    expect(() => loadProfiles(layout, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it.each([
    "/tmp/rename-excl",
    "../rename-excl",
    "native/../rename-excl",
    "native/bin/*",
    "native/bin/evil?",
    "",
  ])("rejects non-exact or non-repo-relative native exec target: %s", (target) => {
    const layout = writeConfig(
      `repos:\n  demo:\n    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300, toolchain: "darwin-clang", nativeExecTargets: [${JSON.stringify(target)}] }\n`,
    );
    expect(() => loadProfiles(layout, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it.each([
    '"native/bin/rename-excl"',
    '[123]',
  ])("rejects nativeExecTargets unless it is a string array: %s", (value) => {
    const layout = writeConfig(
      `repos:\n  demo:\n    unit: { argv: ["pnpm", "test"], timeoutSeconds: 300, toolchain: "darwin-clang", nativeExecTargets: ${value} }\n`,
    );
    expect(() => loadProfiles(layout, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });
});

describe("nativeExecTargets SBPL boundary", () => {
  const basePaths: SandboxPaths = {
    worktree: "/W/.grande-work/worktrees/demo/task_1",
    canonicalGit: "/W/demo/.git",
    jobTmp: "/tmp/job_1",
    controlRoot: "/Users/u/.grande-control",
    worktreesRoot: "/W/.grande-work/worktrees",
    execRoots: ["/usr/bin", "/bin", "/usr/sbin"],
  };

  it("emits only an exact literal for an approved repo-owned native executable", () => {
    const approved = `${basePaths.worktree}/native/bin/rename-excl`;
    const targets = resolveNativeExecTargets(basePaths.worktree, ["native/bin/rename-excl"]);
    const profile = buildProfile(basePaths) + buildNativeExecSbplRules(basePaths.worktree, targets);
    expect(profile).toContain(`(allow process-exec (literal "${approved}"))`);
    expect(profile).not.toContain(`(allow process-exec (subpath "${basePaths.worktree}/native/bin"))`);
    expect(profile).not.toContain(`(allow process-exec (subpath "${basePaths.worktree}"))`);
  });

  it("rejects native exec targets outside the current task worktree", () => {
    expect(() => buildNativeExecSbplRules(basePaths.worktree, ["/tmp/evil-probe"]))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});
