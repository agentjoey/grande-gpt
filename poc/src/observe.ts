import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ObserveEvent {
  ts: number;
  iso: string;
  kind: "tool_call";
  repoId: string;
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  remoteUa: string;
}

export function observeLogPath(): string {
  return resolve(process.env.POC_LOG ?? "./observe.jsonl");
}

export function logEvent(e: ObserveEvent): void {
  const path = observeLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(e) + "\n", "utf8");
}
