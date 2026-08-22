import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import type { Layout } from "../src/layout.ts";
import { TRUSTED_HOST_MANIFEST } from "../src/hostVerification.ts";
import { planOuterTest, resolveOuterTestCwd } from "../src/outerTest.ts";
import { createTask } from "../src/tasks.ts";

let ws: string, ctrl: string, layout: Layout;
let savedWs: string | undefined, savedCtrl: string | undefined;

function writeProfiles(body: string): void {
  writeFileSync(join(layout.configDir, "profiles.yaml"), body, "utf8");
}

const legacyExcluded = [
  "tests/sandbox.test.ts",
  "tests/runner.test.ts",
  "tests/server.test.ts",
  "tests/tools.test.ts",
  "tests/e2e.test.ts",
];

function writeLegacySelfhost(excluded = legacyExcluded): void {
  const argv = ["npx", "vitest", "run"];
  for (const file of excluded) argv.push("--exclude", file);
  writeProfiles(
    "repos:\n  demo:\n" +
    `    unit-selfhost: { argv: ${JSON.stringify(argv)}, timeoutSeconds: 600 }\n`,
  );
}

beforeEach(() => {
  savedWs = process.env.GRANDE_WORKSPACE;
  savedCtrl = process.env.GRANDE_CONTROL;
  ws = mkdtempSync(join(tmpdir(), "ot-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "ot-ctl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
  ensureLayout(layout);
  mkdirSync(join(layout.workspaceRoot, "demo"), { recursive: true });
  writeFileSync(layout.reposConfig, "repos:\n  - repoId: demo\n    registered: true\n", "utf8");
});

afterEach(() => {
  if (savedWs === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = savedWs;
  if (savedCtrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = savedCtrl;
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
});

describe("planOuterTest()", () => {
  it("uses the trusted host manifest while the current control-plane profile remains the drift anchor", () => {
    writeLegacySelfhost();
    const plan = planOuterTest(layout, "demo");
    expect(plan.files).toEqual(TRUSTED_HOST_MANIFEST.map((entry) => entry.file));
    expect(plan.unitSelfhostExcluded).toEqual(legacyExcluded);
    expect(plan.fromProfile).toBe("unit-selfhost");
  });

  it("returns each trusted manifest capability reason", () => {
    writeLegacySelfhost();
    const plan = planOuterTest(layout, "demo");
    for (const entry of TRUSTED_HOST_MANIFEST) {
      expect(plan.reasons.get(entry.file)).toBe(entry.reason);
    }
  });

  it("fails closed if a legacy exclusion is silently removed before trusted profile migration", () => {
    writeLegacySelfhost(legacyExcluded.slice(0, -1));
    expect(() => planOuterTest(layout, "demo")).toThrow(/profile|exclude|coverage|drift/i);
  });

  it("fails closed if an unknown test is added to the trusted profile exclusion set", () => {
    writeLegacySelfhost([...legacyExcluded, "tests/unknown.test.ts"]);
    expect(() => planOuterTest(layout, "demo")).toThrow(/unknown|exclude|coverage/i);
  });

  it("profile without test exclusions fails closed instead of reporting an empty host suite", () => {
    writeProfiles(
      "repos:\n  demo:\n" +
      '    unit-selfhost: { argv: ["npx","vitest","run"], timeoutSeconds: 600 }\n',
    );
    expect(() => planOuterTest(layout, "demo")).toThrow(/exclude|profile|coverage/i);
  });

  it("profile absence fails closed rather than guessing trusted configuration", () => {
    writeProfiles("repos:\n  demo:\n    unit: { argv: [\"pnpm\",\"test\"], timeoutSeconds: 600 }\n");
    expect(() => planOuterTest(layout, "demo")).toThrow();
  });
});

describe("resolveOuterTestCwd()", () => {
  it("without taskId keeps canonical compatibility", () => {
    const db = openDb(layout);
    expect(resolveOuterTestCwd(db, layout, "grande-gpt")).toBe(join(layout.workspaceRoot, "grande-gpt"));
    db.close();
  });

  it("with taskId targets the task worktree rather than canonical", () => {
    const db = openDb(layout);
    const worktreePath = join(ws, ".grande-work", "worktrees", "grande-gpt", "task_phase4");
    createTask(db, {
      taskId: "task_phase4", repoId: "grande-gpt", branch: "grande/phase4",
      baseCommit: "abc123", worktreePath, state: "READY",
    });
    expect(resolveOuterTestCwd(db, layout, "grande-gpt", "task_phase4")).toBe(worktreePath);
    db.close();
  });

  it("fails closed for missing task or wrong repository", () => {
    const db = openDb(layout);
    expect(() => resolveOuterTestCwd(db, layout, "grande-gpt", "task_missing")).toThrow(/TASK_NOT_FOUND|不存在/);
    createTask(db, {
      taskId: "task_other", repoId: "other", branch: "grande/other",
      baseCommit: "abc123", worktreePath: join(ws, "other-worktree"), state: "READY",
    });
    expect(() => resolveOuterTestCwd(db, layout, "grande-gpt", "task_other")).toThrow(/仓库|repo/i);
    db.close();
  });
});
