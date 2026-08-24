import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { getProfile, loadProfiles } from "../src/profiles.ts";

let workspace: string;
let control: string;
let savedWorkspace: string | undefined;
let savedControl: string | undefined;

beforeEach(() => {
  savedWorkspace = process.env.GRANDE_WORKSPACE;
  savedControl = process.env.GRANDE_CONTROL;
  workspace = mkdtempSync(join(tmpdir(), "deployment-host-profile-ws-"));
  control = mkdtempSync(join(tmpdir(), "deployment-host-profile-ctrl-"));
  process.env.GRANDE_WORKSPACE = workspace;
  process.env.GRANDE_CONTROL = control;
});

afterEach(() => {
  if (savedWorkspace === undefined) delete process.env.GRANDE_WORKSPACE;
  else process.env.GRANDE_WORKSPACE = savedWorkspace;
  if (savedControl === undefined) delete process.env.GRANDE_CONTROL;
  else process.env.GRANDE_CONTROL = savedControl;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(control, { recursive: true, force: true });
});

function config(body: string) {
  const layout = loadLayout();
  ensureLayout(layout);
  writeFileSync(join(layout.configDir, "profiles.yaml"), body, "utf8");
  return layout;
}

describe("deployment-only trusted host profile authorization", () => {
  it("only accepts the explicit deployment-host execution mode from control-plane profiles.yaml", () => {
    const layout = config(
      'repos:\n  demo:\n    deploy-production: { argv: ["pnpm", "launchd:install"], timeoutSeconds: 300, execution: "deployment-host" }\n',
    );
    expect(loadProfiles(layout, "demo").get("deploy-production")?.execution).toBe("deployment-host");
  });

  it("fails closed on unknown execution modes instead of silently treating them as sandbox profiles", () => {
    const layout = config(
      'repos:\n  demo:\n    deploy-production: { argv: ["pnpm", "launchd:install"], timeoutSeconds: 300, execution: "host" }\n',
    );
    expect(() => loadProfiles(layout, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });

  it("ordinary getProfile used by grande_run refuses a deployment-host profile", () => {
    const layout = config(
      'repos:\n  demo:\n    deploy-production: { argv: ["pnpm", "launchd:install"], timeoutSeconds: 300, execution: "deployment-host" }\n',
    );
    expect(() => getProfile(layout, "demo", "deploy-production")).toThrow(
      expect.objectContaining({ code: "POLICY_DENIED" }),
    );
  });

  it("deployment-host cannot stack sandbox-only toolchain/native exec permissions", () => {
    const layout = config(
      'repos:\n  demo:\n    deploy-production: { argv: ["pnpm", "launchd:install"], timeoutSeconds: 300, execution: "deployment-host", toolchain: "darwin-clang" }\n',
    );
    expect(() => loadProfiles(layout, "demo")).toThrow(expect.objectContaining({ code: "BAD_CONFIG" }));
  });
});
