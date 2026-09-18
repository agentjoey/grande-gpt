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

// Leave space for the envelope, task context and escaped MCP text serialization.
export const REPO_MAP_MAX_BYTES = 12 * 1024;
const MAX_CURSOR_BYTES = 8 * 1024;
const MAX_PAGE_VISITS = 2000;
const MAX_DIRECTORY_ENTRIES = 16_384;
const MAX_PENDING_DIRECTORIES = 64;
const SKIP_DIRS = new Set([".git", "node_modules", ".grande-work"]);
const KEY_FILE_NAMES = new Set([
  "package.json", "pnpm-lock.yaml", "tsconfig.json", "Cargo.toml",
  "go.mod", "pyproject.toml", "requirements.txt", "Makefile", "README.md",
]);
const KEY_ENTRY_PATHS = ["src/index.ts", "src/main.ts", "src/index.js", "main.py", "src/lib.rs"];
const KEY_DIR_NAMES = new Set(["tests", "test", "__tests__", "spec"]);

interface Frame { dir: string; index: number; signature: string }
interface Cursor { version: 1; root: string; rootSignature: string; frames: Frame[] }
interface Directory { names: string[]; signature: string }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function relativeParts(path: string): string[] {
  if (path === "") return [];
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0") || part.includes("\\") || SKIP_DIRS.has(part))) {
    throw new MapError("INVALID_INPUT", "cursor contains an unsafe directory");
  }
  return parts;
}
function decodeCursor(value: string, root: string): Cursor {
  try {
    if (!value.startsWith("map1:") || Buffer.byteLength(value) > MAX_CURSOR_BYTES) throw new Error("invalid cursor");
    const state = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")) as Cursor;
    if (state.version !== 1 || state.root !== root || typeof state.rootSignature !== "string"
        || !Array.isArray(state.frames) || !state.frames.length || state.frames.length > MAX_PENDING_DIRECTORIES) {
      throw new Error("cursor identity mismatch");
    }
    const dirs = new Set<string>();
    for (const frame of state.frames) {
      if (typeof frame.dir !== "string" || !Number.isSafeInteger(frame.index) || frame.index < 0
          || typeof frame.signature !== "string" || !/^[0-9a-f]{64}$/u.test(frame.signature)
          || dirs.has(frame.dir)) throw new Error("invalid directory frame");
      relativeParts(frame.dir); dirs.add(frame.dir);
    }
    return state;
  } catch { throw new MapError("INVALID_INPUT", "cursor 无效或属于其他仓库；请从首页重新读取。"); }
}
function encodeCursor(state: Cursor): string | null {
  if (!state.frames.length) return null;
  const cursor = `map1:${Buffer.from(JSON.stringify(state)).toString("base64url")}`;
  if (state.frames.length > MAX_PENDING_DIRECTORIES || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) {
    throw new MapError("INVALID_INPUT", "目录续取状态超过有界预算；拒绝生成无法完整返回的 cursor。");
  }
  return cursor;
}

/**
 * Merge the next entry of each pending directory, preserving global lexical order without
 * first walking every descendant. Cursors carry only relative directory offsets/signatures.
 * Each request reads only pending directories and newly visited descendants, never the whole tree.
 * Structural changes to the root or a pending directory require restarting pagination. Completed
 * subtrees are not rescanned: this is live read-only pagination, not a cross-request snapshot.
 */
export function repoMap(root: string, opts: MapOptions = {}): MapResult {
  const requested = opts.maxEntries ?? 500;
  if (!Number.isSafeInteger(requested) || requested < 1) throw new MapError("INVALID_INPUT", "maxEntries 必须是正整数。");
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
    for (const part of relativeParts(relativePath)) {
      path = join(path, part);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MapError("STALE_STATE", "pending directory changed or became a symlink");
    }
    if (path !== canonical && !path.startsWith(canonical + sep)) throw new MapError("INVALID_INPUT", "directory escaped repository");
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
        if (names.length >= MAX_DIRECTORY_ENTRIES) throw new MapError("INVALID_INPUT", "单目录条目超过有界遍历预算。");
        names.push(entry.name);
      }
    } finally { dir.closeSync(); }
    const after = lstatSync(absolute, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs || after.isSymbolicLink()) {
      throw new MapError("STALE_STATE", "directory changed during enumeration");
    }
    names.sort();
    const value = { names, signature: hash([String(after.dev), String(after.ino), String(after.mtimeNs), String(after.ctimeNs), names]) };
    directories.set(path, value);
    return value;
  };
  const initial = readDirectory("");
  const state: Cursor = opts.cursor ? decodeCursor(opts.cursor, rootId) : {
    version: 1, root: rootId, rootSignature: initial.signature,
    frames: initial.names.length ? [{ dir: "", index: 0, signature: initial.signature }] : [],
  };
  if (state.rootSignature !== initial.signature) throw new MapError("STALE_STATE", "repository directory structure changed; restart pagination");
  for (const frame of state.frames) {
    const directory = readDirectory(frame.dir);
    if (directory.signature !== frame.signature || frame.index > directory.names.length) {
      throw new MapError("STALE_STATE", "pending directory changed; restart pagination");
    }
  }

  const entries: MapEntry[] = [];
  const keyFiles: string[] = [];
  const skippedDirectories: string[] = [];
  if (!opts.cursor) {
    // Root candidates and a handful of known entrypoints need no full recursive traversal.
    for (const path of [...KEY_FILE_NAMES, ...KEY_ENTRY_PATHS, ...KEY_DIR_NAMES]) {
      try {
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const stat = lstatSync(join(checked(parent), path.slice(path.lastIndexOf("/") + 1)));
        if (!stat.isSymbolicLink() && ((KEY_DIR_NAMES.has(path) && stat.isDirectory())
            || (!KEY_DIR_NAMES.has(path) && stat.isFile()))) keyFiles.push(path);
      } catch { /* Missing/unreadable entrypoints grant no metadata disclosure. */ }
    }
    keyFiles.sort();
  }
  const output = (): MapResult => ({
    truncated: state.frames.length > 0,
    nextCursor: encodeCursor(state),
    entries,
    keyFiles,
    ...(skippedDirectories.length ? { skippedDirectories } : {}),
  });
  for (let visits = 0; state.frames.length && entries.length < maxEntries && visits < MAX_PAGE_VISITS; visits++) {
    state.frames = state.frames.filter((frame) => frame.index < readDirectory(frame.dir).names.length);
    if (!state.frames.length) break;
    let chosen = state.frames[0]!;
    const nextPath = (frame: Frame): string => {
      const name = readDirectory(frame.dir).names[frame.index]!;
      return frame.dir ? `${frame.dir}/${name}` : name;
    };
    for (const frame of state.frames) if (nextPath(frame) < nextPath(chosen)) chosen = frame;
    const beforeFrames = state.frames.map((frame) => ({ ...frame }));
    const path = nextPath(chosen);
    const name = readDirectory(chosen.dir).names[chosen.index]!;
    chosen.index++;
    state.frames = state.frames.filter((frame) => frame.index < readDirectory(frame.dir).names.length);
    if (SKIP_DIRS.has(name)) continue;
    let stat;
    try { stat = lstatSync(join(checked(chosen.dir), name)); }
    catch { continue; }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
    const skippedBefore = skippedDirectories.length;
    if (stat.isDirectory()) {
      try {
        const child = readDirectory(path);
        if (child.names.length) state.frames.push({ dir: path, index: 0, signature: child.signature });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "ENOENT") {
          if (skippedDirectories.length < 16) skippedDirectories.push(path);
        } else { throw error; }
      }
    }
    entries.push({ path, kind: stat.isDirectory() ? "dir" : "file", bytes: stat.isFile() ? stat.size : null });
    let fits = false;
    try { fits = Buffer.byteLength(JSON.stringify(output())) <= REPO_MAP_MAX_BYTES; }
    catch (error) { if (!(error instanceof MapError)) throw error; }
    if (!fits) {
      entries.pop(); skippedDirectories.length = skippedBefore; state.frames = beforeFrames;
      if (!entries.length) throw new MapError("INVALID_INPUT", "单个目录条目/cursor 超出结果预算，未静默跳过。");
      break;
    }
  }
  const result = output();
  if (Buffer.byteLength(JSON.stringify(result)) > REPO_MAP_MAX_BYTES) throw new MapError("INVALID_INPUT", "map metadata exceeds result budget");
  return result;
}
