import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Layout } from "./layout.ts";

export type HostVerificationMode = "manual" | "auto";

export interface HostVerificationConfig {
  mode: HostVerificationMode;
  concurrency: 1;
}

export class HostVerificationConfigError extends Error {
  readonly code: "BAD_CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "HostVerificationConfigError [BAD_CONFIG]";
    this.code = "BAD_CONFIG";
  }
}

const DEFAULT_CONFIG: HostVerificationConfig = { mode: "manual", concurrency: 1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/**
 * Load the Host Verifier activation switch only from the trusted control plane.
 * Repository content is intentionally never inspected here. Missing config keeps
 * production in manual mode; once the trusted file exists, malformed or unknown
 * values fail closed instead of silently changing activation semantics.
 */
export function loadHostVerificationConfig(layout: Layout): HostVerificationConfig {
  const file = join(layout.configDir, "host-verification.yaml");
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };

  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new HostVerificationConfigError(`无法解析 host-verification config：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(doc) || !exactKeys(doc, ["hostVerification"])) {
    throw new HostVerificationConfigError("host-verification config 顶层必须且只能包含 hostVerification");
  }
  const hostVerification = doc.hostVerification;
  if (!isRecord(hostVerification) || !exactKeys(hostVerification, ["grande-gpt"])) {
    throw new HostVerificationConfigError("hostVerification 必须且只能配置 grande-gpt");
  }
  const repo = hostVerification["grande-gpt"];
  if (!isRecord(repo) || !exactKeys(repo, ["mode", "concurrency"])) {
    throw new HostVerificationConfigError("hostVerification.grande-gpt 必须且只能包含 mode 与 concurrency");
  }
  if (repo.mode !== "manual" && repo.mode !== "auto") {
    throw new HostVerificationConfigError("hostVerification.grande-gpt.mode 只能是 manual 或 auto");
  }
  if (repo.concurrency !== 1) {
    throw new HostVerificationConfigError("hostVerification.grande-gpt.concurrency 当前必须严格等于 1");
  }

  return { mode: repo.mode, concurrency: 1 };
}
