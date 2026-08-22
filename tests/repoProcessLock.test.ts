import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRepoProcessLock } from "../src/repoProcessLock.ts";
import { loadLayout, type Layout } from "../src/layout.ts";

let ws: string;
let ctrl: string;
let layout: Layout;
const children: ChildProcess[] = [];
const saved = { ws: process.env.GRANDE_WORKSPACE, ctrl: process.env.GRANDE_CONTROL };

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "grande-lock-ws-"));
  ctrl = mkdtempSync(join(tmpdir(), "grande-lock-ctrl-"));
  process.env.GRANDE_WORKSPACE = ws;
  process.env.GRANDE_CONTROL = ctrl;
  layout = loadLayout();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  rmSync(ws, { recursive: true, force: true });
  rmSync(ctrl, { recursive: true, force: true });
  if (saved.ws === undefined) delete process.env.GRANDE_WORKSPACE; else process.env.GRANDE_WORKSPACE = saved.ws;
  if (saved.ctrl === undefined) delete process.env.GRANDE_CONTROL; else process.env.GRANDE_CONTROL = saved.ctrl;
});

function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`child did not print ${expected}; got ${output}`)), 3000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child exited before lock signal: code=${code} signal=${signal}; output=${output}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function spawnLockHolder(repoId: string): ChildProcess {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "repoProcessLock.ts")).href;
  const script = `
    import { acquireRepoProcessLock } from ${JSON.stringify(moduleUrl)};
    const layout = { controlRoot: process.env.LOCK_CONTROL_ROOT };
    const lock = acquireRepoProcessLock(layout, process.env.LOCK_REPO_ID);
    console.log("LOCKED");
    setInterval(() => {}, 1000);
    process.on("SIGTERM", () => { lock.release(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, LOCK_CONTROL_ROOT: layout.controlRoot, LOCK_REPO_ID: repoId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

describe("GG-BL-017 cross-process repo lock", () => {
  it("fails closed when another live Node process owns the same repo, while a different repo remains independent", async () => {
    const holder = spawnLockHolder("demo");
    await waitForLine(holder, "LOCKED");

    expect(() => acquireRepoProcessLock(layout, "demo")).toThrow(/busy|REPO_BUSY|live/i);

    const other = acquireRepoProcessLock(layout, "other");
    other.release();

    holder.kill("SIGTERM");
    await waitForExit(holder);
  });

  it("recovers one stale lock after the owner is SIGKILLed", async () => {
    const holder = spawnLockHolder("demo");
    await waitForLine(holder, "LOCKED");
    holder.kill("SIGKILL");
    await waitForExit(holder);

    const recovered = acquireRepoProcessLock(layout, "demo");
    expect(recovered.recoveredStale).toBe(true);
    recovered.release();
  });

  it("does not auto-delete malformed lock metadata", () => {
    acquireRepoProcessLock(layout, "demo");
    const root = join(layout.controlRoot, "locks", "repos");
    const [name] = readdirSync(root);
    expect(name).toBeDefined();
    const lockPath = join(root, name!);
    writeFileSync(lockPath, "not-json", "utf8");

    expect(() => acquireRepoProcessLock(layout, "demo")).toThrow(/malformed|不可信|metadata/i);
    expect(readFileSync(lockPath, "utf8")).toBe("not-json");
  });

  it("release checks the ownership nonce before unlinking", () => {
    const held = acquireRepoProcessLock(layout, "demo");
    const root = join(layout.controlRoot, "locks", "repos");
    const [name] = readdirSync(root);
    const lockPath = join(root, name!);
    const metadata = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    const replacementNonce = "00000000-0000-4000-8000-000000000000";
    writeFileSync(lockPath, JSON.stringify({ ...metadata, nonce: replacementNonce }), "utf8");

    expect(() => held.release()).toThrow(/owner|nonce|ownership|所有权/i);
    expect(readFileSync(lockPath, "utf8")).toContain(replacementNonce);
  });
});
