import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beginAudit } from "./audit.ts";
import { StateError } from "./errors.ts";
import { listNonterminalJobs } from "./jobs.ts";
import { GATEWAY_LAUNCHD_LABEL } from "./launchd.ts";
import type { Layout } from "./layout.ts";

const LOGS = ["gateway.stdout.log", "gateway.stderr.log"] as const;
const MAX_LOG_BYTES = 64 * 1024 ** 2;

/**
 * CLI-only check. An unloaded LaunchAgent and no open log descriptors are required.
 * Unknown execution/permission/diagnostic outcomes are not proof that a writer stopped.
 * This does not stop, signal or restart any service; the Owner uses the existing Gateway CLI.
 */
function stoppedWriter(layout: Layout): boolean {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return false;
  const listed = spawnSync("/bin/launchctl", ["list"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024,
  });
  if (listed.error || listed.status !== 0 || listed.stderr.trim()) return false;
  if (listed.stdout.split("\n").some((line) => line.trim().split(/\s+/u).at(-1) === GATEWAY_LAUNCHD_LABEL)) return false;
  for (const name of LOGS) {
    const path = join(layout.controlRoot, "logs", name);
    try { lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return false; }
    const open = spawnSync("/usr/sbin/lsof", ["-t", "--", path], {
      encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024,
    });
    if (open.error || open.status !== 1 || open.stdout.trim() || open.stderr.trim()) return false;
  }
  return true;
}

export interface LogRotationOptions {
  /** Internal test seams, never CLI or MCP arguments. */
  assertStopped?: () => boolean;
  maxBytes?: number;
}

/**
 * Explicit maintenance with the Gateway already stopped. Never unlinks a live writer.
 * The next normal Gateway start/restart opens the newly created fixed stdout/stderr files.
 * Closed segments use a separate namespace and age out through the retention dry-run/apply path.
 */
export function rotateStoppedGatewayLogs(
  db: DatabaseSync,
  layout: Layout,
  options: LogRotationOptions = {},
): { rotated: string[] } {
  const threshold = options.maxBytes ?? MAX_LOG_BYTES;
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new StateError("INVALID_INPUT", "invalid log rotation threshold");
  const stopped = options.assertStopped ?? (() => stoppedWriter(layout));
  const root = join(layout.controlRoot, "logs");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new StateError("POLICY_DENIED", "Gateway log root must be a real managed directory");
  }
  const rotated: string[] = [];
  for (const name of LOGS) {
    const path = join(root, name);
    let original;
    try { original = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1
        || (process.getuid && original.uid !== process.getuid())) {
      throw new StateError("POLICY_DENIED", "Gateway log is not an owned regular file");
    }
    if (original.size < threshold) continue;
    const segmentName = `${name}.closed-${Date.now()}-${randomUUID()}`;
    const segment = join(root, segmentName);
    let renamed = false;
    let replacementCreated = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (listNonterminalJobs(db).length || !stopped()) {
        throw new StateError("POLICY_DENIED", "日志轮转要求 Gateway 已停止、无打开的写入句柄且所有 job 已收敛。先用已有 gateway stop，再执行本维护命令。 ");
      }
      const current = lstatSync(path);
      if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino
          || current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
        throw new StateError("STALE_STATE", "log changed before rotation");
      }
      const audit = beginAudit(db, { taskId: null, tool: "grande_gateway_log_rotation",
        input: { name, segmentName, bytes: current.size, writerStopped: true } });
      if (!audit.allowed() || !audit.executing()) throw new Error("log rotation audit unavailable");
      renameSync(path, segment); renamed = true;
      writeFileSync(path, "", { flag: "wx", mode: 0o600 }); replacementCreated = true;
      const now = new Date(); utimesSync(segment, now, now);
      if (!audit.succeeded([path, segment])) throw new Error("log rotation audit failed");
      db.exec("COMMIT");
      rotated.push(segmentName);
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* original failure */ }
      if (renamed) {
        if (replacementCreated) {
          const replacement = lstatSync(path);
          if (replacement.isFile() && replacement.size === 0 && stopped()) rmSync(path);
        }
        try { lstatSync(path); }
        catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") {
            renameSync(segment, path);
            utimesSync(path, original.atime, original.mtime);
          }
        }
      }
      throw error;
    }
  }
  return { rotated };
}
