import { describe, expect, it } from "vitest";
import { withRepoWriteLock } from "../src/repoWriteLock.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

describe("withRepoWriteLock", () => {
  it("serializes same-repo critical sections in FIFO order", async () => {
    const firstRelease = deferred();
    const events: string[] = [];

    const first = withRepoWriteLock("demo", async () => {
      events.push("first-enter");
      await firstRelease.promise;
      events.push("first-exit");
    });
    const second = withRepoWriteLock("demo", async () => {
      events.push("second-enter");
      events.push("second-exit");
    });

    await waitFor(() => events.includes("first-enter"));
    expect(events).toEqual(["first-enter"]);

    firstRelease.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter", "second-exit"]);
  });

  it("allows different repos to enter their critical sections concurrently", async () => {
    const releaseA = deferred();
    const releaseB = deferred();
    const entered = new Set<string>();

    const a = withRepoWriteLock("repo-a", async () => {
      entered.add("a");
      await releaseA.promise;
    });
    const b = withRepoWriteLock("repo-b", async () => {
      entered.add("b");
      await releaseB.promise;
    });

    await waitFor(() => entered.size === 2);
    expect([...entered].sort()).toEqual(["a", "b"]);

    releaseA.resolve();
    releaseB.resolve();
    await Promise.all([a, b]);
  });

  it("releases a repo lock when an operation rejects", async () => {
    await expect(withRepoWriteLock("demo", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    let entered = false;
    await withRepoWriteLock("demo", () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });

  it("never retries a failing operation", async () => {
    let attempts = 0;
    await expect(withRepoWriteLock("demo", () => {
      attempts++;
      throw new Error("fail once");
    })).rejects.toThrow("fail once");
    expect(attempts).toBe(1);
  });
});
