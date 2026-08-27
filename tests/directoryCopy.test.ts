import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyDirectory } from "../src/directoryCopy.ts";

let root: string | null = null;

afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("copyDirectory", () => {
  it("recursively copies a directory and preserves its symbolic links", () => {
    root = mkdtempSync(join(tmpdir(), "grande-directory-copy-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(join(source, "nested"), { recursive: true });
    writeFileSync(join(source, "nested", "package.json"), '{"name":"fixture"}\n', "utf8");
    symlinkSync("nested/package.json", join(source, "manifest-link"));

    copyDirectory(source, destination);

    expect(readFileSync(join(destination, "nested", "package.json"), "utf8")).toBe('{"name":"fixture"}\n');
    expect(lstatSync(join(destination, "manifest-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(destination, "manifest-link"))).toBe("nested/package.json");
    expect(existsSync(join(destination, "manifest-link"))).toBe(true);
  });
});
