import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { loadProfiles } from "../src/profiles.ts";
import { loadRegistry, saveRegistry } from "../src/registry.ts";
import { applyRepoOnboarding, inspectRepoOnboarding } from "../src/onboarding.ts";

let ws: string;
let ctrl: string;
let savedWs: string | undefined;
let savedCtrl: string | undefined;

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "onboard-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "onboard-ctrl-"));
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

function makeRepo(repoId = "fresh"): string {
  const repo = join(ws, repoId);
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(join(repo, ".grande"), { recursive: true });
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\n", "utf8");
  writeFileSync(join(repo, ".grande", "deploy.yaml"), "deploy:\n  profile: deploy\n", "utf8");
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.33.0",
    scripts: { test: "vitest run", typecheck: "tsc --noEmit", build: "vite build" },
  }, null, 2), "utf8");
  return repo;
}

describe("project onboarding", () => {
  it("只检测普通轻量 repo 的常见事实，并把执行命令限制为现有 package scripts", () => {
    makeRepo();
    const proposal = inspectRepoOnboarding(loadLayout(), "fresh", {
      readRemote: () => "https://github.com/acme/fresh.git",
    });

    expect(proposal.packageManager).toBe("pnpm");
    expect(proposal.githubRepo).toBe("acme/fresh");
    expect(proposal.ciConfigured).toBe(true);
    expect(proposal.deployConfigured).toBe(true);
    expect(proposal.cloneNodeModules).toBe(true);
    expect(proposal.profiles.map((p) => [p.name, p.argv])).toEqual([
      ["test", ["pnpm", "run", "test"]],
      ["typecheck", ["pnpm", "run", "typecheck"]],
      ["build", ["pnpm", "run", "build"]],
    ]);
  });

  it("inspect 是纯 proposal：没有 Human apply 时不注册 repo、也不写任何控制平面 profile", () => {
    makeRepo();
    const layout = loadLayout();
    inspectRepoOnboarding(layout, "fresh", { readRemote: () => null });

    expect(loadRegistry(layout).has("fresh")).toBe(false);
    expect(loadProfiles(layout, "fresh").size).toBe(0);
  });

  it("显式 apply 才写可信控制平面；不向 repo 写 profiles/secrets，并保留已有仓库配置", () => {
    const repo = makeRepo();
    const layout = loadLayout();
    const packageBefore = readFileSync(join(repo, "package.json"), "utf8");
    saveRegistry(layout, [{ repoId: "existing", path: join(ws, "existing"), registered: true }]);

    const proposal = inspectRepoOnboarding(layout, "fresh", {
      readRemote: () => "https://github.com/acme/fresh.git",
    });
    applyRepoOnboarding(layout, proposal);

    expect(loadRegistry(layout).get("fresh")?.registered).toBe(true);
    expect(loadRegistry(layout).get("existing")?.registered).toBe(true);
    expect(loadProfiles(layout, "fresh").get("test")?.argv).toEqual(["pnpm", "run", "test"]);
    expect(readFileSync(join(repo, "package.json"), "utf8")).toBe(packageBefore);
    expect(() => readFileSync(join(repo, "profiles.yaml"), "utf8")).toThrow();
    expect(() => readFileSync(join(repo, "secrets"), "utf8")).toThrow();
  });
});
