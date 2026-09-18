import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import { createJob, finishJob, getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { planResourceRetention, applyResourceRetention } from "../src/resourceRetention.ts";
import { jobReport } from "../src/runner.ts";
import { createTask } from "../src/tasks.ts";

let root: string;
let layout: Layout;
let db: ReturnType<typeof openDb>;
const TASK = "task_resource_maintenance";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resource-maint-"));
  mkdirSync(join(root, "workspace")); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  layout = loadLayout(); ensureLayout(layout); db = openDb(layout);
  saveRegistry(layout, []);
  createTask(db, { taskId: TASK, repoId: "demo", branch: "grande/maintenance", baseCommit: "base",
    worktreePath: join(layout.worktreesRoot, "demo", TASK), state: "READY" });
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("B2-3 maintenance reporting", () => {
  it("reports an intentionally pruned artifact without changing the job result", () => {
    createJob(db, { jobId: "job_pruned", taskId: TASK, profile: "unit", argv: [], pgid: null });
    finishJob(db, "job_pruned", { state: "passed", exitCode: 0,
      artifactPath: join(layout.artifactsDir, TASK, "job_pruned", "output.log"),
      summary: { artifactRetention: { state: "pruned", retiredAt: 1, key: "unused" } } });
    const result = jobReport(db, "job_pruned");
    expect(result.state).toBe("passed");
    expect(result.summary).toMatch(/retention|保留策略|已清理/);
    expect(result.summary).not.toContain("不可读");
    expect(getJob(db, "job_pruned")?.exitCode).toBe(0);
  });

  it("rejects unknown maintenance actions and raw paths", async () => {
    const { runResourceMaintenance } = await import("../src/resourceMaintenanceCli.ts");
    const output: string[] = [];
    expect(await runResourceMaintenance(["delete", "/tmp/arbitrary"], (line) => output.push(line))).toBe(1);
    expect(output.join("\n")).toMatch(/用法|usage/i);
  });
});

describe("B2-3 stopped-writer log rotation", () => {
  function logPath() {
    const path = join(layout.controlRoot, "logs", "gateway.stdout.log");
    mkdirSync(join(layout.controlRoot, "logs"), { recursive: true });
    writeFileSync(path, "a".repeat(80));
    return path;
  }

  it("refuses rotation if the Gateway or any writer is still live", async () => {
    const { rotateStoppedGatewayLogs } = await import("../src/gatewayLogRotation.ts");
    const path = logPath();
    const probe = vi.fn(() => false);
    expect(() => rotateStoppedGatewayLogs(db, layout, { assertStopped: probe, maxBytes: 32 })).toThrow();
    expect(readFileSync(path, "utf8")).toHaveLength(80);
  });

  it("refuses rotation while jobs have not settled", async () => {
    const { rotateStoppedGatewayLogs } = await import("../src/gatewayLogRotation.ts");
    const path = logPath();
    createJob(db, { jobId: "job_live", taskId: TASK, profile: "unit", argv: [], pgid: null });
    expect(() => rotateStoppedGatewayLogs(db, layout, { assertStopped: () => true, maxBytes: 32 })).toThrow();
    expect(existsSync(path)).toBe(true);
  });

  it("moves only fixed stopped-writer logs and recreates an empty writer path", async () => {
    const { rotateStoppedGatewayLogs } = await import("../src/gatewayLogRotation.ts");
    const path = logPath();
    const result = rotateStoppedGatewayLogs(db, layout, { assertStopped: () => true, maxBytes: 32 });
    expect(result.rotated).toHaveLength(1);
    expect(result.rotated[0]).toMatch(/gateway\.stdout\.log\.closed-\d{13}-/);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(readFileSync(join(layout.controlRoot, "logs", result.rotated[0]!), "utf8")).toHaveLength(80);
  });

  it("never follows a symlink that claims to be a Gateway log", async () => {
    const { rotateStoppedGatewayLogs } = await import("../src/gatewayLogRotation.ts");
    const path = logPath();
    const outside = join(root, "outside"); writeFileSync(outside, "keep");
    rmSync(path); symlinkSync(outside, path);
    expect(() => rotateStoppedGatewayLogs(db, layout, { assertStopped: () => true, maxBytes: 1 })).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  it("restores the original log if durable audit fails", async () => {
    const { rotateStoppedGatewayLogs } = await import("../src/gatewayLogRotation.ts");
    const path = logPath();
    db.exec("CREATE TRIGGER fail_rotation BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'audit failed'); END");
    expect(() => rotateStoppedGatewayLogs(db, layout, { assertStopped: () => true, maxBytes: 32 })).toThrow();
    expect(readFileSync(path, "utf8")).toHaveLength(80);
  });

  it("caps closed log segments while retaining the ten newest and the active log", () => {
    const active = logPath();
    const now = Date.now();
    const dir = join(layout.controlRoot, "logs");
    for (let i = 0; i < 14; i++) {
      const path = join(dir, `gateway.stdout.log.closed-${now - i * 1000}-${randomUUID()}`);
      writeFileSync(path, "segment");
      utimesSync(path, (now - i * 1000) / 1000, (now - i * 1000) / 1000);
    }
    const plan = planResourceRetention(db, layout, { now });
    expect(plan.items.filter((item) => item.kind === "log")).toHaveLength(4);
    expect(applyResourceRetention(db, layout, plan, { now }).purged).toBe(4);
    expect(readdirSync(dir).filter((name) => name.includes(".closed-")).length).toBe(10);
    expect(readFileSync(active, "utf8")).toHaveLength(80);
  });
});
