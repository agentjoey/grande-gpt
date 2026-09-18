import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessSupervisionError, superviseOwnedProcess } from "../src/processSupervision.ts";

const children: ChildProcess[] = [];
function child(script: string) {
  const process = spawn(globalThis.process.execPath, ["-e", script], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(process); return process;
}
function ready(process: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child readiness timeout")), 3000);
    process.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
    process.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const process of children.splice(0)) {
    if (process.pid && process.exitCode === null && process.signalCode === null) {
      try { globalThis.process.kill(-process.pid, "SIGKILL"); } catch { /* fixture already gone */ }
    }
  }
});

describe("B2-2 real process-group supervision", () => {
  it("cancels a cooperative owned child and leaves an unrelated group alive", async () => {
    const owned = child("process.on('SIGTERM',()=>process.exit(0)); console.log('ready'); setInterval(()=>{},1000)");
    const unrelated = child("console.log('ready'); setInterval(()=>{},1000)");
    const controller = new AbortController();
    const settled = superviseOwnedProcess(owned, { timeoutMs: 3000, maxOutputBytes: 1024, signal: controller.signal, killGraceMs: 100 });
    await Promise.all([ready(owned), ready(unrelated)]);
    controller.abort();
    expect(await settled).toMatchObject({ killedBy: "cancel", exitCode: 0 });
    expect(unrelated.exitCode).toBeNull();
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
  });

  it("escalates only while the resistant group leader is still owned", async () => {
    const owned = child("process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)");
    const controller = new AbortController();
    const settled = superviseOwnedProcess(owned, { timeoutMs: 3000, maxOutputBytes: 1024, signal: controller.signal, killGraceMs: 50 });
    await ready(owned); controller.abort();
    expect(await settled).toMatchObject({ killedBy: "cancel", exitCode: null });
    expect(owned.signalCode).toBe("SIGKILL");
  });

  it("does not leave a delayed kill after natural completion or a late abort", async () => {
    const owned = child("console.log('done')");
    const kill = vi.spyOn(process, "kill");
    const controller = new AbortController();
    expect(await superviseOwnedProcess(owned, { timeoutMs: 1000, maxOutputBytes: 1024,
      signal: controller.signal, killGraceMs: 25 })).toMatchObject({ exitCode: 0, killedBy: null });
    const calls = kill.mock.calls.length;
    controller.abort(); await new Promise((resolve) => setTimeout(resolve, 60));
    expect(kill.mock.calls).toHaveLength(calls);
  });

  it("confirms process extinction before reporting onSpawn callback failure", async () => {
    const owned = child("setInterval(()=>{},1000)");
    await expect(superviseOwnedProcess(owned, { timeoutMs: 1000, maxOutputBytes: 1024, killGraceMs: 25,
      onSpawn: () => { throw new Error("database pgid write failed"); } })).rejects.toMatchObject({ safeToFinalize: true });
    expect(owned.signalCode).not.toBeNull();
  });

  it("truncates output without terminating a successful process", async () => {
    const owned = child("console.log('测'.repeat(10000))");
    const result = await superviseOwnedProcess(owned, { timeoutMs: 3000, maxOutputBytes: 120 });
    expect(result).toMatchObject({ exitCode: 0, killedBy: null, truncated: true });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(122);
  });

  it("retains uncertainty instead of signalling a departed leader's stored pgid", async () => {
    const fake = Object.assign(new EventEmitter(), {
      pid: 2_000_001, exitCode: null as number | null, signalCode: null,
      stdout: new PassThrough(), stderr: new PassThrough(),
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const observed = superviseOwnedProcess(fake as unknown as ChildProcess, {
      timeoutMs: 1000, maxOutputBytes: 100, extinctionGraceMs: 30,
    });
    fake.exitCode = 0; fake.emit("exit", 0); fake.emit("close", 0);
    await expect(observed).rejects.toBeInstanceOf(ProcessSupervisionError);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });
});
