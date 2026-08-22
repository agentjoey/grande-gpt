import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRepoProcessLock } from "../src/repoProcessLock.ts";
import { withRepoWriteLock } from "../src/repoWriteLock.ts";

let controlRoot: string;
let layout: { controlRoot: string };

beforeEach(() => {
  controlRoot = mkdtempSync(join(tmpdir(), "repo-write-lock-ctl-"));
  layout = { controlRoot };
});

afterEach(() => {
  rmSync(controlRoot, { recursive: true, force: true });
});

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
    }, layout);
    const second = withRepoWriteLock("demo", async () => {
      events.push("second-enter");
      events.push("second-exit");
    }, layout);

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
    }, layout);
    const b = withRepoWriteLock("repo-b", async () => {
      entered.add("b");
      await releaseB.promise;
    }, layout);

    await waitFor(() => entered.size === 2);
    expect([...entered].sort()).toEqual(["a", "b"]);

    releaseA.resolve();
    releaseB.resolve();
    await Promise.all([a, b]);
  });

  it("releases a repo lock when an operation rejects", async () => {
    await expect(withRepoWriteLock("demo", async () => {
      throw new Error("boom");
    }, layout)).rejects.toThrow("boom");

    let entered = false;
    await withRepoWriteLock("demo", () => {
      entered = true;
    }, layout);
    expect(entered).toBe(true);
  });

  it("never retries a failing operation", async () => {
    let attempts = 0;
    await expect(withRepoWriteLock("demo", () => {
      attempts++;
      throw new Error("fail once");
    }, layout)).rejects.toThrow("fail once");
    expect(attempts).toBe(1);
  });

  it("fails before entering the operation when a live process lock already owns the repo", async () => {
    const held = acquireRepoProcessLock(layout, "demo");
    let entered = false;
    try {
      await expect(withRepoWriteLock("demo", () => {
        entered = true;
      }, layout)).rejects.toThrow(/busy|REPO_BUSY|live/i);
      expect(entered).toBe(false);
    } finally {
      held.release();
    }
  });
});
