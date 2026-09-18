import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_WRITE_TOOLS, PUBLIC_TOOLSET_EPOCH } from "../src/contract.ts";
import { openDb } from "../src/db.ts";
import { ensureLayout, loadLayout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { saveTaskBrief } from "../src/taskBrief.ts";
import { createTask } from "../src/tasks.ts";
import { buildTools, toolsetIdentity, type ToolDeps } from "../src/tools.ts";

const TASK = "task_status_boundaries";
let root: string;
let deps: ToolDeps;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "status-boundaries-"));
  mkdirSync(join(root, "workspace", "demo"), { recursive: true }); mkdirSync(join(root, "control"));
  vi.stubEnv("GRANDE_WORKSPACE", join(root, "workspace")); vi.stubEnv("GRANDE_CONTROL", join(root, "control"));
  const layout = loadLayout(); ensureLayout(layout);
  saveRegistry(layout, [{ repoId: "demo", path: join(layout.workspaceRoot, "demo"), registered: true }]);
  deps = { db: openDb(layout), layout };
  createTask(deps.db, { taskId: TASK, repoId: "demo", branch: "grande/status-boundaries",
    baseCommit: "a".repeat(40), worktreePath: join(layout.worktreesRoot, "demo", TASK), state: "READY" });
});
afterEach(() => { vi.restoreAllMocks(); deps.db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function status(args: Record<string, unknown>) {
  const tool = buildTools(deps).find((entry) => entry.name === "grande_task_status")!;
  const value = (await tool.handler(args)).structuredContent as {
    ok: boolean; nextCursor: string | null; data: { content: string }; error?: { code: string };
  };
  // Measure raw wire encoding: the transport fallback must not hide an oversized original response.
  expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] })))
    .toBeLessThanOrEqual(32 * 1024);
  return value;
}
const brief = (request: string) => ({ source: { type: "text" }, request, findings: [], plan: ["implement"], acceptanceCriteria: ["verify"] });

describe("B2-5 contract and continuation boundaries", () => {
  it("publishes exactly one epoch change for pagination and a distinct cancellation tool", () => {
    const tools = buildTools(deps);
    const identity = toolsetIdentity(tools, "candidate");
    expect(PUBLIC_TOOLSET_EPOCH).toBe(4);
    expect(identity).toMatchObject({ toolsetEpoch: 4, toolsCount: 26 });
    expect(MCP_WRITE_TOOLS).toContain("grande_job_cancel");
    expect(identity.toolsDigest).not.toBe("sha256:d5243888a58a440b05147d8e5baeb3713e92833720c5dd403901493ff555b496");
    expect(tools.find((entry) => entry.name === "grande_task_status")!.annotations.readOnlyHint).toBe(true);
    console.log(`B2 candidate contract epoch=${identity.toolsetEpoch} tools=${identity.toolsCount} digest=${identity.toolsDigest}`);
  });

  it("invalidates a brief cursor even when two edits have the same wall-clock time and length", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
    saveTaskBrief(deps.db, TASK, brief("a".repeat(4000)));
    const first = await status({ taskId: TASK, view: "brief" });
    expect(first.ok).toBe(true); expect(first.nextCursor).not.toBeNull();
    saveTaskBrief(deps.db, TASK, brief("b".repeat(4000)));
    // Existing error mapping exposes internal STALE_STATE as retryable INVALID_INPUT.
    expect(await status({ taskId: TASK, view: "brief", cursor: first.nextCursor }))
      .toMatchObject({ ok: false, error: { code: "INVALID_INPUT", retryable: true, message: expect.stringContaining("TaskBrief 已更新") } });
  });

  it("preserves escaped and multibyte brief content through bounded SQL chunks", async () => {
    const expected = saveTaskBrief(deps.db, TASK, brief('草地🧪"\\\n\t'.repeat(3500)));
    let cursor: string | null = null;
    let content = "";
    let pages = 0;
    do {
      const result = await status({ taskId: TASK, view: "brief", ...(cursor ? { cursor } : {}) });
      expect(result.ok).toBe(true); content += result.data.content; cursor = result.nextCursor;
      expect(++pages).toBeLessThan(100);
    } while (cursor);
    expect(JSON.stringify(JSON.parse(content)) === JSON.stringify(expected)).toBe(true);
  });
});
