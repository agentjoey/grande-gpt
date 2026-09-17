import { describe, expect, it } from "vitest";
import { startTaskLifecycleReconciler } from "../src/taskLifecycleScheduler.ts";

describe("task lifecycle startup + periodic reconciliation", () => {
  it("runs task recovery and authorization expiry at startup and periodically, then stops cleanly", async () => {
    let taskCalls = 0;
    let authorizationCalls = 0;
    let periodic: (() => void) | undefined;
    let unrefCalled = false;
    let cleared = false;
    const observed: Array<{ phase: string; authorizationsExpired: number }> = [];
    const fakeTimer = { unref: () => { unrefCalled = true; } } as unknown as ReturnType<typeof setInterval>;

    const controller = await startTaskLifecycleReconciler({} as never, {} as never, {
      intervalMs: 60_000,
      reconcile: async () => {
        taskCalls++;
        return { creatingReady: 0, creatingClosed: 0, closingClosed: 0, unresolved: 0 };
      },
      reconcileAuthorizations: () => {
        authorizationCalls++;
        return { expired: 2 };
      },
      onResult: (phase, result) => {
        observed.push({ phase, authorizationsExpired: result.authorizationsExpired });
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

    expect(taskCalls).toBe(1);
    expect(authorizationCalls).toBe(1);
    expect(observed).toEqual([{ phase: "startup", authorizationsExpired: 2 }]);
    expect(unrefCalled).toBe(true);

    periodic!();
    await Promise.resolve();
    expect(taskCalls).toBe(2);
    expect(authorizationCalls).toBe(2);
    expect(observed).toEqual([
      { phase: "startup", authorizationsExpired: 2 },
      { phase: "periodic", authorizationsExpired: 2 },
    ]);

    controller.stop();
    expect(cleared).toBe(true);
  });
});
