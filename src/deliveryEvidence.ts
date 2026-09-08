import { readFileSync, statSync } from "node:fs";
import { StateError } from "./errors.ts";

export interface DeploymentEvidence {
  target: string;
  deploymentId: string;
  sourceSha: string;
  artifactDigest?: string;
}

const DEFAULT_MAX_BYTES = 16384;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const KNOWN_FIELDS = new Set(["target", "deploymentId", "sourceSha", "artifactDigest"]);

function invalid(message: string): StateError {
  return new StateError("EVIDENCE_INVALID", message);
}

export function parseDeploymentEvidence(value: unknown): DeploymentEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("deployment evidence must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw invalid(`unknown field in deployment evidence: ${key}`);
    }
  }
  const { target, deploymentId, sourceSha, artifactDigest } = obj;
  if (typeof target !== "string" || target.trim() === "") {
    throw invalid("deployment evidence target must be a nonempty string");
  }
  if (typeof deploymentId !== "string" || deploymentId.trim() === "") {
    throw invalid("deployment evidence deploymentId must be a nonempty string");
  }
  if (typeof sourceSha !== "string" || !SHA_RE.test(sourceSha)) {
    throw invalid("deployment evidence sourceSha must be exactly 40 lowercase hex chars");
  }
  if (artifactDigest !== undefined) {
    if (typeof artifactDigest !== "string" || !DIGEST_RE.test(artifactDigest)) {
      throw invalid("deployment evidence artifactDigest must be sha256:<64 lowercase hex>");
    }
  }
  return {
    target,
    deploymentId,
    sourceSha,
    ...(artifactDigest === undefined ? {} : { artifactDigest }),
  };
}

export function readProfileDeliveryEvidence(
  path: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): DeploymentEvidence {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw invalid("maxBytes must be a positive integer");
  }
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new StateError("EVIDENCE_MISSING", `deployment evidence file not found: ${path}`);
  }
  if (size > maxBytes) {
    throw invalid(`deployment evidence file exceeds ${maxBytes} bytes`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new StateError("EVIDENCE_MISSING", `deployment evidence file not readable: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("deployment evidence is not valid JSON");
  }
  return parseDeploymentEvidence(parsed);
}

export function assertEvidenceMatchesAuthorization(
  evidence: DeploymentEvidence,
  expected: { target: string; sourceSha: string; artifactDigest?: string },
): void {
  const mismatch = (field: string): StateError =>
    new StateError("EVIDENCE_MISMATCH", `deployment evidence ${field} does not match authorization`);
  if (evidence.target !== expected.target) throw mismatch("target");
  if (evidence.sourceSha !== expected.sourceSha) throw mismatch("sourceSha");
  if (expected.artifactDigest !== undefined && evidence.artifactDigest !== expected.artifactDigest) {
    throw mismatch("artifactDigest");
  }
}
