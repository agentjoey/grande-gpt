import { describe, expect, it } from "vitest";
import { startTaskLifecycleReconciler } from "../src/taskLifecycleScheduler.ts";

describe("task lifecycle startup + periodic reconciliation", () => {
  it("runs once at startup, schedules periodic recovery, and stops cleanly", async () => {
    let calls = 0;
    let periodic: (() => void) | undefined;
    let unrefCalled = false;
    let cleared = false;
    const fakeTimer = { unref: () => { unrefCalled = true; } } as unknown as ReturnType<typeof setInterval>;

    const controller = await startTaskLifecycleReconciler({} as never, {} as never, {
      intervalMs: 60_000,
      reconcile: async () => {
        calls++;
        return { creatingReady: 0, creatingClosed: 0, closingClosed: 0, unresolved: 0 };
      },
      setIntervalFn: (callback, ms) => {
        expect(ms).toBe(60_000);
        periodic = callback;
        return fakeTimer;
      },
      clearIntervalFn: (timer) => {
        expect(timer).toBe(fakeTimer);
        cleared = true;
      },
    });

    expect(calls).toBe(1);
    expect(unrefCalled).toBe(true);
    periodic!();
    await Promise.resolve();
    expect(calls).toBe(2);
    controller.stop();
    expect(cleared).toBe(true);
  });
});
