import { createHash, randomUUID } from "node:crypto";
import { lstatSync, opendirSync, realpathSync, renameSync, rmSync, type Stats } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beginAudit } from "./audit.ts";
import { StateError } from "./errors.ts";
import { getJob, TERMINAL } from "./jobs.ts";
import type { Layout } from "./layout.ts";
import { assertTaskId } from "./paths.ts";
import { registeredIds } from "./registry.ts";
import { readTaskPrReceipt } from "./taskPrReceipt.ts";
import { getTask } from "./tasks.ts";

export type RetentionKind = "job-temp" | "dependency-cache" | "artifact" | "log";
const DAY = 86_400_000;
const AGES: Readonly<Record<RetentionKind, number>> = Object.freeze({
  "job-temp": 7 * DAY, "dependency-cache": 30 * DAY, artifact: 30 * DAY, log: 14 * DAY,
});
const MAX_SCAN = 20_000;
const MAX_ITEMS = 128;
const MAX_PURGE = 16;
const MAX_PURGE_BYTES = 2 * 1024 ** 3;
const MAX_CLOSED_LOGS = 10;
const RETIRED = /\.retired-[0-9a-f-]{36}$/u;
const CACHE_NAME = /^[0-9a-f]{64}(?:\.(?:tmp|retired)-[0-9a-f-]{36})?$/u;
const LOG_NAME = /^gateway\.(?:stdout|stderr)\.log\.closed-\d{13}-[0-9a-f-]{36}(?:\.retired-[0-9a-f-]{36})?$/u;

export interface RetentionItem {
  kind: RetentionKind;
  key: string;
  fingerprint: string;
  logicalBytes: number;
  latestMtime: number;
}
export interface RetentionPlan {
  version: 1;
  roots: string;
  digest: string;
  items: RetentionItem[];
  held: Array<{ kind: RetentionKind; key: string; reason: string }>;
  scannedEntries: number;
  truncated: boolean;
  /** Keyset continuation of historical jobs, not an arbitrary filesystem path. */
  nextCursor: string | null;
}
export interface RetentionOptions {
  now?: number;
  cursor?: string;
  /** Internal deterministic seam. CLI callers never supply paths or deletion functions. */
  maxScanEntries?: number;
}
export interface RetentionApplyResult {
  purged: number;
  logicalBytesPurged: number;
  skipped: Array<{ kind: RetentionKind; key: string; reason: string }>;
}
interface Budget { remaining: number; scanned: number; exhausted: boolean }
interface JobCursor { roots: string; endedAt: number; jobId: string }

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function rootsIdentity(layout: Layout): string {
  return hash([layout.workspaceRoot, layout.controlRoot].map((path) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
      throw new StateError("POLICY_DENIED", "retention requires canonical managed roots");
    }
    return [path, stat.dev, stat.ino];
  }));
}
function readCursor(input: string | undefined, roots: string): JobCursor {
  if (input === undefined) return { roots, endedAt: 0, jobId: "" };
  try {
    if (input.length > 1024 || !input.startsWith("retention1:")) throw new Error("invalid prefix");
    const value = JSON.parse(Buffer.from(input.slice(11), "base64url").toString("utf8")) as JobCursor;
    if (value.roots !== roots || !Number.isSafeInteger(value.endedAt) || value.endedAt < 0) throw new Error("wrong roots/time");
    assertTaskId(value.jobId);
    return value;
  } catch { throw new StateError("INVALID_INPUT", "retention cursor is malformed or belongs to different managed roots"); }
}
function planDigest(roots: string, items: RetentionItem[]): string { return hash({ version: 1, roots, items }); }
function take(budget: Budget): void {
  if (budget.remaining <= 0) { budget.exhausted = true; throw new Error("scan budget exhausted"); }
  budget.remaining--; budget.scanned++;
}
function scanLimit(input: number | undefined): number {
  const result = input ?? MAX_SCAN;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_SCAN) throw new StateError("INVALID_INPUT", "invalid retention scan limit");
  return result;
}
function statIdentity(stat: Stats): unknown[] {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
}

/** Every ancestor below the trusted root must remain a real directory, never a symlink. */
function checkedPath(layout: Layout, kind: RetentionKind, key: string): string {
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    throw new StateError("POLICY_DENIED", "invalid managed retention key");
  }
  let boundary: string;
  let root: string;
  if (kind === "job-temp") {
    if (parts.length !== 1) throw new Error("invalid temporary key");
    assertTaskId(parts[0]!.replace(RETIRED, ""));
    if (!parts[0]!.startsWith("job_")) throw new Error("invalid job key");
    boundary = layout.workspaceRoot; root = join(layout.derivedRoot, "tmp");
  } else if (kind === "dependency-cache") {
    if (parts.length !== 2 || !CACHE_NAME.test(parts[1]!)) throw new Error("invalid cache key");
    assertTaskId(parts[0]!);
    if (!registeredIds(layout).has(parts[0]!)) throw new Error("unregistered cache repository");
    boundary = layout.workspaceRoot; root = join(layout.derivedRoot, "dependency-cache");
  } else if (kind === "artifact") {
    if (parts.length !== 3 || !/^output\.log(?:\.retired-[0-9a-f-]{36})?$/u.test(parts[2]!)) throw new Error("invalid artifact key");
    assertTaskId(parts[0]!); assertTaskId(parts[1]!);
    boundary = layout.controlRoot; root = layout.artifactsDir;
  } else if (kind === "log") {
    if (parts.length !== 1 || !LOG_NAME.test(parts[0]!)) throw new Error("not an explicitly closed log segment");
    boundary = layout.controlRoot; root = join(layout.controlRoot, "logs");
  } else { throw new Error("unknown retention kind"); }
  const path = join(root, ...parts);
  if (!path.startsWith(boundary + sep)) throw new Error("retention path escaped its managed root");
  let parent = dirname(path);
  while (parent !== boundary) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("retention parent is not a real managed directory");
    parent = dirname(parent);
    if (!parent.startsWith(boundary + sep) && parent !== boundary) throw new Error("invalid retention ancestor");
  }
  return path;
}

function deliveryObligation(db: DatabaseSync, taskId: string): boolean {
  return db.prepare("SELECT 1 FROM deployment_receipt WHERE taskId=?").get(taskId) !== undefined
    || db.prepare("SELECT 1 FROM delivery_authorization WHERE taskId=? LIMIT 1").get(taskId) !== undefined
    || db.prepare("SELECT 1 FROM task_delivery_target WHERE taskId=? AND target='deploy'").get(taskId) !== undefined;
}
function protection(db: DatabaseSync, layout: Layout, kind: RetentionKind, key: string): string | null {
  if (kind === "log") return null;
  if (kind === "dependency-cache") {
    const repoId = key.split("/")[0]!;
    // Conservative first rollout: do not prune a repo's cache while any of its tasks or
    // executions may still use it. Dependency copies remain local to their worktrees.
    if (db.prepare("SELECT 1 FROM task WHERE repoId=? AND state!='CLOSED' LIMIT 1").get(repoId)
        || db.prepare("SELECT 1 FROM job j JOIN task t ON t.taskId=j.taskId WHERE t.repoId=? AND j.state='running' LIMIT 1").get(repoId)
        || db.prepare("SELECT 1 FROM task t WHERE t.repoId=? AND (EXISTS (SELECT 1 FROM deployment_receipt d WHERE d.taskId=t.taskId) OR EXISTS (SELECT 1 FROM delivery_authorization a WHERE a.taskId=t.taskId)) LIMIT 1").get(repoId)) {
      return "repository has active or protected delivery references";
    }
    return null;
  }
  const parts = key.split("/");
  const jobId = kind === "job-temp" ? parts[0]!.replace(RETIRED, "") : parts[1]!;
  const job = getJob(db, jobId);
  const task = job ? getTask(db, job.taskId) : undefined;
  if (!job || !task || !TERMINAL.has(job.state) || task.state !== "CLOSED"
      || !readTaskPrReceipt(db, task.taskId)?.mergeSha || deliveryObligation(db, task.taskId)
      || db.prepare("SELECT 1 FROM job WHERE taskId=? AND state='running' LIMIT 1").get(task.taskId)) {
    return "task/job completion or absence of live references is unproven";
  }
  if (kind === "artifact") {
    const expected = join(layout.artifactsDir, task.taskId, jobId, "output.log");
    if (parts[0] !== task.taskId || job.artifactPath !== expected || job.profile === "host-verifier"
        || db.prepare("SELECT 1 FROM attestation WHERE jobId=? LIMIT 1").get(jobId)) {
      return "diagnostic output is referenced or not owned by this job";
    }
  }
  return null;
}

/** Count policy is re-evaluated at apply time; only explicitly closed segments participate. */
function oldEnough(layout: Layout, kind: RetentionKind, key: string, mtime: number, now: number, budget: Budget): boolean {
  if (now - mtime >= AGES[kind]) return true;
  if (kind !== "log") return false;
  const dirPath = join(layout.controlRoot, "logs");
  const dir = opendirSync(dirPath);
  let newer = 0;
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      take(budget);
      if (!LOG_NAME.test(entry.name) || entry.name === key) continue;
      const stat = lstatSync(join(dirPath, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.mtimeMs > mtime || (stat.mtimeMs === mtime && entry.name > key)) newer++;
      if (newer >= MAX_CLOSED_LOGS) return true;
    }
  } finally { dir.closeSync(); }
  return false;
}

function inspect(path: string, budget: Budget): { fingerprint: string; logicalBytes: number; latestMtime: number } {
  const rows: unknown[][] = [];
  let logicalBytes = 0;
  let latestMtime = 0;
  const visit = (current: string, depth: number): void => {
    take(budget);
    if (depth > 64) throw new Error("resource exceeds inspection depth");
    const stat = lstatSync(current);
    if (depth === 0 && stat.isSymbolicLink()) throw new Error("resource root changed to a symlink");
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("resource contains a special filesystem object");
    rows.push([relative(path, current), ...statIdentity(stat)]);
    latestMtime = Math.max(latestMtime, stat.mtimeMs);
    if (!stat.isDirectory()) { logicalBytes += stat.size; return; }
    const dir = opendirSync(current);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) visit(join(current, entry.name), depth + 1);
    } finally { dir.closeSync(); }
  };
  visit(path, 0);
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { fingerprint: hash(rows), logicalBytes, latestMtime };
}

/** Fixed-root inventory. No task state, receipt, audit, file or cache is mutated by dry-run. */
export function planResourceRetention(db: DatabaseSync, layout: Layout, options: RetentionOptions = {}): RetentionPlan {
  const now = options.now ?? Date.now();
  const roots = rootsIdentity(layout);
  const after = readCursor(options.cursor, roots);
  const budget: Budget = { remaining: scanLimit(options.maxScanEntries), scanned: 0, exhausted: false };
  const items: RetentionItem[] = [];
  const held: RetentionPlan["held"] = [];
  const consider = (kind: RetentionKind, key: string) => {
    if (budget.exhausted || items.length >= MAX_ITEMS) { budget.exhausted = true; return; }
    try {
      const path = checkedPath(layout, kind, key);
      const reason = protection(db, layout, kind, key);
      if (reason) { if (held.length < MAX_ITEMS) held.push({ kind, key, reason }); return; }
      const info = inspect(path, budget);
      if (!oldEnough(layout, kind, key, info.latestMtime, now, budget)) return;
      if (info.logicalBytes > MAX_PURGE_BYTES) {
        if (held.length < MAX_ITEMS) held.push({ kind, key, reason: "resource exceeds per-apply logical byte budget" });
        return;
      }
      items.push({ kind, key, ...info });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && held.length < MAX_ITEMS) {
        held.push({ kind, key, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  const jobs = db.prepare(`SELECT j.jobId,j.taskId,j.summary,j.endedAt FROM job j JOIN task t ON t.taskId=j.taskId
    WHERE t.state='CLOSED' AND j.state!='running' AND j.endedAt<=?
      AND (j.endedAt>? OR (j.endedAt=? AND j.jobId>?))
    ORDER BY j.endedAt,j.jobId LIMIT ?`).all(now - Math.min(...Object.values(AGES)),
      after.endedAt, after.endedAt, after.jobId, MAX_ITEMS + 1) as
    Array<{ jobId: string; taskId: string; summary: string | null; endedAt: number }>;
  let visited = 0;
  let last = after;
  for (const job of jobs.slice(0, MAX_ITEMS)) {
    if (budget.exhausted) break;
    consider("job-temp", job.jobId);
    consider("artifact", `${job.taskId}/${job.jobId}/output.log`);
    try {
      const summary = job.summary ? JSON.parse(job.summary) as Record<string, unknown> : {};
      for (const [kind, value] of [["job-temp", summary.tempRetention], ["artifact", summary.artifactRetention]] as const) {
        const record = value as { key?: unknown } | undefined;
        if (typeof record?.key === "string") consider(kind, record.key);
      }
    } catch { /* Unreadable metadata grants no deletion authority. */ }
    visited++;
    last = { roots, endedAt: job.endedAt, jobId: job.jobId };
  }
  const nextCursor = jobs.length > visited && visited > 0
    ? `retention1:${Buffer.from(JSON.stringify(last)).toString("base64url")}` : null;
  const enumerate = (dirPath: string, kind: "dependency-cache" | "log", prefix = "") => {
    if (budget.exhausted) return;
    let dir;
    try {
      const st = lstatSync(dirPath);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("inventory root is not a real directory");
      dir = opendirSync(dirPath);
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        take(budget);
        const key = prefix + entry.name;
        if ((kind === "log" ? LOG_NAME : CACHE_NAME).test(entry.name)) consider(kind, key);
        if (budget.exhausted) break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && held.length < MAX_ITEMS) {
        held.push({ kind, key: prefix, reason: error instanceof Error ? error.message : String(error) });
      }
    } finally { dir?.closeSync(); }
  };
  for (const repo of registeredIds(layout)) {
    if (budget.exhausted) break;
    enumerate(join(layout.derivedRoot, "dependency-cache", repo), "dependency-cache", `${repo}/`);
  }
  enumerate(join(layout.controlRoot, "logs"), "log");
  items.sort((a, b) => a.latestMtime - b.latestMtime || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  return { version: 1, roots, digest: planDigest(roots, items), items, held, nextCursor,
    scannedEntries: budget.scanned, truncated: budget.exhausted || nextCursor !== null };
}

/**
 * Retire under the SQLite admission lock, then purge only the uniquely renamed object.
 * A failed audit restores the original name. A failed purge is reported and left retryable;
 * logical byte counts are not physical/APFS reclaimed-space claims.
 */
export function applyResourceRetention(db: DatabaseSync, layout: Layout, plan: RetentionPlan, options: RetentionOptions = {}): RetentionApplyResult {
  if (plan.version !== 1 || plan.items.length > MAX_ITEMS || plan.roots !== rootsIdentity(layout)
      || plan.digest !== planDigest(plan.roots, plan.items)) throw new StateError("STALE_STATE", "retention plan identity changed");
  const result: RetentionApplyResult = { purged: 0, logicalBytesPurged: 0, skipped: [] };
  const now = options.now ?? Date.now();
  const budget: Budget = { remaining: MAX_SCAN, scanned: 0, exhausted: false };
  let attempted = 0;
  for (const item of plan.items) {
    if (attempted >= MAX_PURGE || budget.exhausted || result.logicalBytesPurged + item.logicalBytes > MAX_PURGE_BYTES) {
      result.skipped.push({ kind: item.kind, key: item.key, reason: "apply budget reached" }); continue;
    }
    attempted++;
    let path: string | undefined;
    let retired: string | undefined;
    let committed = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      if (plan.roots !== rootsIdentity(layout)) throw new Error("managed roots changed");
      path = checkedPath(layout, item.kind, item.key);
      const reason = protection(db, layout, item.kind, item.key);
      if (reason) throw new Error(reason);
      const current = inspect(path, budget);
      if (current.fingerprint !== item.fingerprint || !oldEnough(layout, item.kind, item.key, current.latestMtime, now, budget)) {
        throw new Error("resource changed since dry-run");
      }
      const original = lstatSync(path);
      const audit = beginAudit(db, { taskId: null, tool: "grande_resource_retention",
        input: { kind: item.kind, key: item.key, fingerprint: item.fingerprint, phase: "retire", logicalBytes: current.logicalBytes } });
      if (!audit.allowed() || !audit.executing()) throw new Error("retention audit unavailable");
      retired = `${path.replace(RETIRED, "")}.retired-${randomUUID()}`;
      renameSync(path, retired);
      const moved = lstatSync(retired);
      if (moved.isSymbolicLink() || moved.dev !== original.dev || moved.ino !== original.ino) {
        throw new Error("retired object identity changed");
      }
      const key = item.key.replace(RETIRED, "") + retired.slice(path.replace(RETIRED, "").length);
      if (item.kind === "artifact" || item.kind === "job-temp") {
        const jobId = item.kind === "artifact" ? item.key.split("/")[1]! : item.key.replace(RETIRED, "");
        const job = getJob(db, jobId)!;
        const field = item.kind === "artifact" ? "artifactRetention" : "tempRetention";
        db.prepare("UPDATE job SET summary=? WHERE jobId=? AND state!='running'")
          .run(JSON.stringify({ ...job.summary, [field]: { state: "pruned", key, retiredAt: now } }), jobId);
      }
      if (!audit.succeeded([path])) throw new Error("retention audit could not commit");
      db.exec("COMMIT"); committed = true;
      rmSync(retired, { recursive: true });
      result.purged++; result.logicalBytesPurged += current.logicalBytes;
    } catch (error) {
      if (!committed) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
        if (retired && path) {
          try { lstatSync(path); } catch (missing) {
            if ((missing as NodeJS.ErrnoException).code === "ENOENT") {
              try { renameSync(retired, path); } catch { /* leave the unique retired object for inspection */ }
            }
          }
        }
      }
      result.skipped.push({ kind: item.kind, key: item.key,
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
