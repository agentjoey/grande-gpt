import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoMap } from "../src/repoMap.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bounded-map-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function file(path: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), "x");
}

describe("B2-4 byte-bounded resumable repo map", () => {
  it("fits actual JSON UTF-8 bytes and returns every long/escaped path across pages", () => {
    const wanted: string[] = [];
    for (let i = 0; i < 600; i++) {
      const path = `${String(i).padStart(4, "0")}-${'草地"\\'.repeat(18)}.ts`;
      wanted.push(path); file(path);
    }
    let cursor: string | null = null;
    const actual: string[] = [];
    let pages = 0;
    do {
      const page = repoMap(root, { maxEntries: 500, cursor });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024);
      expect(page.entries.length).toBeGreaterThan(0);
      actual.push(...page.entries.map((entry) => entry.path));
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(100);
    } while (cursor);
    expect(actual).toEqual(wanted.sort());
    expect(new Set(actual).size).toBe(600);
    expect(pages).toBeGreaterThan(1);
  });

  it("does not walk the entire tree to produce one small page", () => {
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 20; j++) file(`dir${String(i).padStart(3, "0")}/${j}.ts`);
    }
    const reads: string[] = [];
    const page = repoMap(root, { maxEntries: 10, onReadDirectory: (path: string) => reads.push(path) });
    expect(page.entries).toHaveLength(10);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThan(5);
    expect(reads).not.toContain("dir099");
  });

  it("keeps global lexical order when directory names interleave with punctuation siblings", () => {
    for (const path of ["src/a.ts", "src.ts", "src!/inside", "src-foo", "src/z.ts", "A/file"]) file(path);
    const actual: string[] = [];
    let cursor: string | null = null;
    do {
      const page = repoMap(root, { maxEntries: 2, cursor });
      actual.push(...page.entries.map((entry) => entry.path)); cursor = page.nextCursor;
    } while (cursor);
    expect(actual).toEqual([...actual].sort());
    expect(new Set(actual).size).toBe(actual.length);
    expect(actual).toContain("src/a.ts");
  });

  it.each(["1junk", "-1", "../outside", "map1:invalid"])("rejects a malformed cursor: %s", (cursor) => {
    file("a");
    expect(() => repoMap(root, { cursor })).toThrow();
  });

  it("binds cursors to the actual repository root", () => {
    file("a"); file("b");
    const first = repoMap(root, { maxEntries: 1 });
    const other = join(root, "other"); mkdirSync(other);
    expect(() => repoMap(other, { cursor: first.nextCursor })).toThrow();
  });

  it("rejects structural changes instead of silently continuing a stale directory offset", () => {
    file("a"); file("b");
    const first = repoMap(root, { maxEntries: 1 });
    file("aa");
    expect(() => repoMap(root, { cursor: first.nextCursor })).toThrow(/changed|stale|变化/i);
  });

  it("never follows a pending directory substituted with a symlink", () => {
    file("dir/a"); file("dir/b");
    const first = repoMap(root, { maxEntries: 1 });
    rmSync(join(root, "dir"), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "map-secret-"));
    try {
      writeFileSync(join(outside, "secret"), "private"); symlinkSync(outside, join(root, "dir"));
      expect(() => repoMap(root, { cursor: first.nextCursor })).toThrow();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects non-positive or non-integer page sizes: %s", (maxEntries) => {
    expect(() => repoMap(root, { maxEntries })).toThrow();
  });
});
