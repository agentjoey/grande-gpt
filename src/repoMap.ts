import { createHash } from "node:crypto";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

export class MapError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = `MapError [${code}]`;
    this.code = code;
  }
}

export interface MapEntry {
  path: string;
  kind: "file" | "dir";
  bytes: number | null;
}
export interface MapResult {
  truncated: boolean;
  nextCursor: string | null;
  entries: MapEntry[];
  keyFiles: string[];
  skippedDirectories?: string[];
}
export interface MapOptions {
  maxEntries?: number;
  cursor?: string | null;
  /** Internal measurement seam; the public tool only supplies maxEntries/cursor. */
  onReadDirectory?: (relativePath: string) => void;
}

export const REPO_MAP_MAX_BYTES = 12 * 1024;
const MAX_CURSOR_BYTES = 8 * 1024;
const MAX_PAGE_VISITS = 2000;
const MAX_DIRECTORY_ENTRIES = 16_384;
const MAX_DEPTH = 64;
const SKIP_DIRS = new Set([".git", "node_modules", ".grande-work"]);
const KEY_FILE_NAMES = new Set([
  "package.json", "pnpm-lock.yaml", "tsconfig.json", "Cargo.toml",
  "go.mod", "pyproject.toml", "requirements.txt", "Makefile", "README.md",
]);
const KEY_ENTRY_PATHS = ["src/index.ts", "src/main.ts", "src/index.js", "main.py", "src/lib.rs"];
const KEY_DIR_NAMES = new Set(["tests", "test", "__tests__", "spec"]);

interface Cursor {
  version: 2;
  root: string;
  after: string;
  afterDirectory: boolean;
  chainDigest: string;
  frontierDigest: string;
}
interface Directory { names: string[]; signature: string }
interface Candidate { path: string; parent: string; name: string }

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function relativeParts(path: string): string[] {
  if (path === "") return [];
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0") || SKIP_DIRS.has(part))) {
    throw new MapError("INVALID_INPUT", "cursor contains an unsafe path");
  }
  return parts;
}
function decodeCursor(value: string, root: string): Cursor {
  try {
    if (!value.startsWith("map2:") || Buffer.byteLength(value) > MAX_CURSOR_BYTES) throw new Error("invalid cursor");
    const state = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")) as Cursor;
    if (state.version !== 2 || state.root !== root || typeof state.after !== "string" || !state.after
        || typeof state.afterDirectory !== "boolean"
        || typeof state.chainDigest !== "string" || !/^[0-9a-f]{64}$/u.test(state.chainDigest)
        || typeof state.frontierDigest !== "string" || !/^[0-9a-f]{64}$/u.test(state.frontierDigest)) {
      throw new Error("cursor identity mismatch");
    }
    relativeParts(state.after);
    return state;
  } catch {
    throw new MapError("INVALID_INPUT", "cursor 无效或属于其他仓库；请从首页重新读取。");
  }
}
function encodeCursor(state: Cursor | null): string | null {
  if (!state) return null;
  const cursor = `map2:${Buffer.from(JSON.stringify(state)).toString("base64url")}`;
  if (Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) {
    throw new MapError("INVALID_INPUT", "目录续取位置本身超过有界 cursor 预算。");
  }
  return cursor;
}

function heapPush(heap: Candidate[], value: Candidate): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]!.path <= value.path) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}
function heapPop(heap: Candidate[]): Candidate | undefined {
  if (!heap.length) return undefined;
  const first = heap[0]!;
  const last = heap.pop()!;
  if (!heap.length) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right]!.path < heap[left]!.path ? right : left;
    if (heap[child]!.path >= last.path) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

/**
 * Byte-bounded, resumable lexical repository map.
 *
 * The cursor stores only the last visited path plus a digest of its ancestor-directory
 * signatures. It therefore grows with path depth, not with tree width. On continuation the
 * frontier is reconstructed from the root and only directories whose lexical range can cross
 * the saved position are opened. Unvisited subtrees are live reads; changes to the root or the
 * saved ancestor chain invalidate the cursor.
 */
export function repoMap(root: string, opts: MapOptions = {}): MapResult {
  const requested = opts.maxEntries ?? 500;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new MapError("INVALID_INPUT", "maxEntries 必须是正整数。");
  }
  const maxEntries = Math.min(requested, 500);

  let canonical: string;
  try { canonical = realpathSync(root); }
  catch { throw new MapError("INVALID_INPUT", "无法读取仓库根目录。"); }
  const rootStat = lstatSync(canonical);
  if (!rootStat.isDirectory()) throw new MapError("INVALID_INPUT", "仓库根不是目录。");
  const rootId = hash([canonical, rootStat.dev, rootStat.ino]);

  const directories = new Map<string, Directory>();
  const checked = (relativePath: string): string => {
    let path = canonical;
    const parts = relativeParts(relativePath);
    if (parts.length > MAX_DEPTH) throw new MapError("INVALID_INPUT", "目录深度超过有界遍历预算。");
    for (const part of parts) {
      path = join(path, part);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new MapError("STALE_STATE", "pending directory changed or became a symlink");
      }
    }
    if (path !== canonical && !path.startsWith(canonical + sep)) {
      throw new MapError("INVALID_INPUT", "directory escaped repository");
    }
    return path;
  };
  const readDirectory = (path: string): Directory => {
    const cached = directories.get(path);
    if (cached) return cached;
    const absolute = checked(path);
    const before = lstatSync(absolute, { bigint: true });
    opts.onReadDirectory?.(path);
    const dir = opendirSync(absolute);
    const names: string[] = [];
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (names.length >= MAX_DIRECTORY_ENTRIES) {
          throw new MapError("INVALID_INPUT", "单目录条目超过有界遍历预算。");
        }
        names.push(entry.name);
      }
    } finally { dir.closeSync(); }
    const after = lstatSync(absolute, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs || after.isSymbolicLink()) {
      throw new MapError("STALE_STATE", "directory changed during enumeration");
    }
    names.sort();
    const value = {
      names,
      signature: hash([String(after.dev), String(after.ino), String(after.mtimeNs), String(after.ctimeNs), names]),
    };
    directories.set(path, value);
    return value;
  };

  const cursor = opts.cursor ? decodeCursor(opts.cursor, rootId) : null;
  const chainDigest = (after: string, afterDirectory: boolean): string => {
    const rows: Array<[string, string]> = [["", readDirectory("").signature]];
    const parts = relativeParts(after);
    const count = Math.max(0, parts.length - (afterDirectory ? 0 : 1));
    let path = "";
    for (let i = 0; i < count; i++) {
      path = path ? `${path}/${parts[i]!}` : parts[i]!;
      rows.push([path, readDirectory(path).signature]);
    }
    return hash(rows);
  };
  if (cursor && chainDigest(cursor.after, cursor.afterDirectory) !== cursor.chainDigest) {
    throw new MapError("STALE_STATE", "repository directory structure changed; restart pagination");
  }

  const after = cursor?.after ?? "";
  const heap: Candidate[] = [];
  const seedDirectory = (dirPath: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new MapError("INVALID_INPUT", "目录深度超过有界遍历预算。");
    const directory = readDirectory(dirPath);
    for (const name of directory.names) {
      if (SKIP_DIRS.has(name)) continue;
      const path = dirPath ? `${dirPath}/${name}` : name;
      if (path > after) {
        heapPush(heap, { path, parent: dirPath, name });
        continue;
      }
      const childPrefix = `${path}/`;
      const mayContainLater = path === after || childPrefix > after || after.startsWith(childPrefix);
      if (!mayContainLater) continue;
      let stat;
      try { stat = lstatSync(join(checked(dirPath), name)); }
      catch { continue; }
      if (!stat.isSymbolicLink() && stat.isDirectory()) seedDirectory(path, depth + 1);
    }
  };
  seedDirectory("", 0);

  const frontierDigest = (): string => {
    const parents = [...new Set(heap.map((candidate) => candidate.parent))].sort();
    return hash(parents.map((parent) => [parent, readDirectory(parent).signature]));
  };
  if (cursor && frontierDigest() !== cursor.frontierDigest) {
    throw new MapError("STALE_STATE", "pending directory changed; restart pagination");
  }

  const entries: MapEntry[] = [];
  const keyFiles: string[] = [];
  const skippedDirectories: string[] = [];
  if (!opts.cursor) {
    for (const path of [...KEY_FILE_NAMES, ...KEY_ENTRY_PATHS, ...KEY_DIR_NAMES]) {
      try {
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const name = path.slice(path.lastIndexOf("/") + 1);
        const stat = lstatSync(join(checked(parent), name));
        if (!stat.isSymbolicLink() && ((KEY_DIR_NAMES.has(path) && stat.isDirectory())
            || (!KEY_DIR_NAMES.has(path) && stat.isFile()))) keyFiles.push(path);
      } catch { /* Missing/unreadable entrypoints grant no metadata disclosure. */ }
    }
    keyFiles.sort();
  }

  let lastVisited = after;
  let lastVisitedDirectory = cursor?.afterDirectory ?? false;
  const makeCursor = (): Cursor | null => {
    if (!heap.length) return null;
    if (!lastVisited) return null;
    return {
      version: 2,
      root: rootId,
      after: lastVisited,
      afterDirectory: lastVisitedDirectory,
      chainDigest: chainDigest(lastVisited, lastVisitedDirectory),
      frontierDigest: frontierDigest(),
    };
  };
  const output = (): MapResult => ({
    truncated: heap.length > 0,
    nextCursor: encodeCursor(makeCursor()),
    entries,
    keyFiles,
    ...(skippedDirectories.length ? { skippedDirectories } : {}),
  });

  let visits = 0;
  while (heap.length && entries.length < maxEntries && visits < MAX_PAGE_VISITS) {
    const candidate = heapPop(heap)!;
    visits++;

    let stat;
    try { stat = lstatSync(join(checked(candidate.parent), candidate.name)); }
    catch {
      lastVisited = candidate.path;
      lastVisitedDirectory = false;
      continue;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      lastVisited = candidate.path;
      lastVisitedDirectory = false;
      continue;
    }

    let child: Directory | null = null;
    let childReadable = false;
    const skippedBefore = skippedDirectories.length;
    if (stat.isDirectory()) {
      try {
        child = readDirectory(candidate.path);
        childReadable = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "ENOENT") {
          if (skippedDirectories.length < 16) skippedDirectories.push(candidate.path);
        } else { throw error; }
      }
    }

    const previousAfter = lastVisited;
    const previousAfterDirectory = lastVisitedDirectory;
    lastVisited = candidate.path;
    lastVisitedDirectory = stat.isDirectory() && childReadable;
    entries.push({
      path: candidate.path,
      kind: stat.isDirectory() ? "dir" : "file",
      bytes: stat.isFile() ? stat.size : null,
    });

    let fits = false;
    try { fits = Buffer.byteLength(JSON.stringify(output())) <= REPO_MAP_MAX_BYTES; }
    catch (error) { if (!(error instanceof MapError)) throw error; }
    if (!fits) {
      entries.pop();
      skippedDirectories.length = skippedBefore;
      lastVisited = previousAfter;
      lastVisitedDirectory = previousAfterDirectory;
      heapPush(heap, candidate);
      if (!entries.length) {
        throw new MapError("INVALID_INPUT", "单个目录条目/cursor 超出结果预算，未静默跳过。");
      }
      break;
    }

    if (childReadable && child) {
      for (const name of child.names) {
        if (SKIP_DIRS.has(name)) continue;
        heapPush(heap, {
          path: `${candidate.path}/${name}`,
          parent: candidate.path,
          name,
        });
      }
    }
  }

  const result = output();
  if (Buffer.byteLength(JSON.stringify(result)) > REPO_MAP_MAX_BYTES) {
    throw new MapError("INVALID_INPUT", "map metadata exceeds result budget");
  }
  return result;
}
