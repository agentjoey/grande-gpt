import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { inspectProjectReadiness } from "../src/readiness.ts";
import { saveRegistry } from "../src/registry.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "ready-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "ready-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  ensureLayout(loadLayout());
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

function makeReadyRepo(withDeploy = true): void {
  const layout = loadLayout();
  const repo = join(ws, "demo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(join(ctrl, "secrets"), { recursive: true });
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\n", "utf8");
  if (withDeploy) {
    mkdirSync(join(repo, ".grande"), { recursive: true });
    writeFileSync(join(repo, ".grande", "deploy.yaml"), [
      "deploy:",
      "  profile: deploy-production",
      "verify:",
      "  profile: verify-production",
      "rollback:",
      "  profile: rollback-production",
      "",
    ].join("\n"), "utf8");
  }
  saveRegistry(layout, [{ repoId: "demo", path: repo, registered: true }]);
  writeFileSync(join(layout.configDir, "profiles.yaml"), [
    "repos:",
    "  demo:",
    "    test: { argv: [pnpm, test], timeoutSeconds: 60 }",
    "    deploy-production: { argv: [pnpm, deploy], timeoutSeconds: 600 }",
    "    verify-production: { argv: [pnpm, verify], timeoutSeconds: 60 }",
    "    rollback-production: { argv: [pnpm, rollback], timeoutSeconds: 600 }",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(ctrl, "secrets", "github-token"), "github_pat_fixture_abcdefghijklmnopqrstuvwxyz\n", "utf8");
}

const probes = {
  sandboxAvailable: () => true,
  readRemote: () => "https://github.com/acme/demo.git",
  readHead: () => "abc123",
  githubProbe: async () => "Checks/Statuses access OK",
  gatewayProbe: async () => "tools/list HTTP 200",
};

describe("project Golden Path readiness", () => {
  it("把 development / PR-CI / deploy / gateway 分组为真实 readiness，而不是仅检查文件存在", async () => {
    makeReadyRepo(true);
    const result = await inspectProjectReadiness(loadLayout(), "demo", probes);

    expect(result.development.ready).toBe(true);
    expect(result.prCi.ready).toBe(true);
    expect(result.deploy.ready).toBe(true);
    expect(result.gateway.ok).toBe(true);
    expect(result.prCi.checks.some((c) => c.label === "GitHub credential/access" && c.ok)).toBe(true);
    expect(result.deploy.checks.some((c) => c.label === "deploy profile" && c.ok)).toBe(true);
    expect(result.deploy.checks.some((c) => c.label === "verify profile" && c.ok)).toBe(true);
  });

  it("没有 deploy spec 时只把 Deploy 判为未就绪，不拖累 Development 与 PR/CI", async () => {
    makeReadyRepo(false);
    const result = await inspectProjectReadiness(loadLayout(), "demo", probes);

    expect(result.development.ready).toBe(true);
    expect(result.prCi.ready).toBe(true);
    expect(result.deploy.ready).toBe(false);
    expect(result.deploy.checks.some((c) => c.detail.includes("未配置"))).toBe(true);
  });

  it("deploy spec 引用了不存在的可信 profile 时 Deploy 必须失败，不能因为 YAML 能解析就报绿", async () => {
    makeReadyRepo(true);
    const layout = loadLayout();
    writeFileSync(join(layout.configDir, "profiles.yaml"), [
      "repos:",
      "  demo:",
      "    test: { argv: [pnpm, test], timeoutSeconds: 60 }",
      "",
    ].join("\n"), "utf8");

    const result = await inspectProjectReadiness(layout, "demo", probes);
    expect(result.development.ready).toBe(true);
    expect(result.deploy.ready).toBe(false);
    expect(result.deploy.checks.some((c) => c.label === "deploy profile" && !c.ok)).toBe(true);
  });
});
