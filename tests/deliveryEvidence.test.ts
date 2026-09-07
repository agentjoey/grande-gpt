import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertEvidenceMatchesAuthorization,
  parseDeploymentEvidence,
  readProfileDeliveryEvidence,
  type DeploymentEvidence,
} from "../src/deliveryEvidence.ts";
import {
  awaitDeploymentHostJobSettled,
  startDeploymentHostJob,
} from "../src/deploymentHostRunner.ts";
import { openDb } from "../src/db.ts";
import { StateError } from "../src/errors.ts";
import { getJob } from "../src/jobs.ts";
import { ensureLayout, loadLayout, type Layout } from "../src/layout.ts";
import { saveRegistry } from "../src/registry.ts";
import { createTask } from "../src/tasks.ts";

const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
const DIGEST_B = `sha256:${"d".repeat(64)}`;

const VALID: DeploymentEvidence = {
  target: "staging",
  deploymentId: "deploy-123",
  sourceSha: SHA,
  artifactDigest: DIGEST,
};

function expectStateError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StateError);
    expect((e as StateError).code).toBe(code);
    return;
  }
  throw new Error(`expected StateError [${code}]`);
}

describe("parseDeploymentEvidence", () => {
  it("accepts valid evidence with all fields", () => {
    expect(parseDeploymentEvidence(VALID)).toEqual(VALID);
  });

  it("accepts valid evidence without artifactDigest", () => {
    const { artifactDigest: _d, ...rest } = VALID;
    expect(parseDeploymentEvidence(rest)).toEqual(rest);
  });

  it("rejects non-object values", () => {
    for (const v of [null, undefined, 42, "x", [], true]) {
      expectStateError(() => parseDeploymentEvidence(v), "EVIDENCE_INVALID");
    }
  });

  it("rejects unknown fields", () => {
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, extra: "nope" }),
      "EVIDENCE_INVALID",
    );
  });

  it("requires nonempty target and deploymentId", () => {
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, target: "" }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, deploymentId: "" }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, target: "  " }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, target: 7 }),
      "EVIDENCE_INVALID",
    );
  });

  it("requires sourceSha to be exactly 40 lowercase hex", () => {
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, sourceSha: SHA.slice(0, 39) }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, sourceSha: SHA + "f" }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, sourceSha: "A" + SHA.slice(1) }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, sourceSha: "g".repeat(40) }),
      "EVIDENCE_INVALID",
    );
  });

  it("requires artifactDigest to be sha256:<64 lowercase hex> when present", () => {
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, artifactDigest: "c".repeat(64) }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, artifactDigest: `sha256:${"C".repeat(64)}` }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, artifactDigest: `sha256:${"c".repeat(63)}` }),
      "EVIDENCE_INVALID",
    );
    expectStateError(
      () => parseDeploymentEvidence({ ...VALID, artifactDigest: "" }),
      "EVIDENCE_INVALID",
    );
  });
});

describe("readProfileDeliveryEvidence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "delivery-evidence-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  it("reads valid evidence from disk", () => {
    const p = write("evidence.json", JSON.stringify(VALID));
    expect(readProfileDeliveryEvidence(p)).toEqual(VALID);
  });

  it("throws EVIDENCE_MISSING for a missing file", () => {
    expectStateError(
      () => readProfileDeliveryEvidence(join(dir, "nope.json")),
      "EVIDENCE_MISSING",
    );
  });

  it("throws EVIDENCE_INVALID when the file exceeds maxBytes", () => {
    const p = write("big.json", `${JSON.stringify(VALID)}${" ".repeat(1024)}`);
    expectStateError(() => readProfileDeliveryEvidence(p, 16), "EVIDENCE_INVALID");
  });

  it("requires maxBytes to be a positive integer", () => {
    const p = write("evidence.json", JSON.stringify(VALID));
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expectStateError(() => readProfileDeliveryEvidence(p, bad), "EVIDENCE_INVALID");
    }
  });

  it("rejects invalid or ambiguous JSON", () => {
    for (const bad of [
      "{not json",
      `${JSON.stringify(VALID)} trailing`,
      `${JSON.stringify(VALID)}\n${JSON.stringify(VALID)}`,
      "[]",
      `"just a string"`,
      "null",
    ]) {
      const p = write("bad.json", bad);
      expectStateError(() => readProfileDeliveryEvidence(p), "EVIDENCE_INVALID");
    }
  });

  it("rejects unknown fields on disk", () => {
    const p = write("extra.json", JSON.stringify({ ...VALID, bogus: 1 }));
    expectStateError(() => readProfileDeliveryEvidence(p), "EVIDENCE_INVALID");
  });
});

describe("assertEvidenceMatchesAuthorization", () => {
  const expected = { target: "staging", sourceSha: SHA, artifactDigest: DIGEST };

  it("passes when evidence matches exactly", () => {
    expect(() => assertEvidenceMatchesAuthorization(VALID, expected)).not.toThrow();
  });

  it("passes without digest when expected has none", () => {
    const { artifactDigest: _d, ...ev } = VALID;
    const { artifactDigest: _e, ...exp } = expected;
    expect(() => assertEvidenceMatchesAuthorization(ev, exp)).not.toThrow();
  });

  it("throws EVIDENCE_MISMATCH on target mismatch", () => {
    expectStateError(
      () => assertEvidenceMatchesAuthorization({ ...VALID, target: "prod" }, expected),
      "EVIDENCE_MISMATCH",
    );
  });

  it("throws EVIDENCE_MISMATCH on sourceSha mismatch", () => {
    expectStateError(
      () => assertEvidenceMatchesAuthorization({ ...VALID, sourceSha: SHA_B }, expected),
      "EVIDENCE_MISMATCH",
    );
  });

  it("throws EVIDENCE_MISMATCH on digest mismatch or missing digest", () => {
    expectStateError(
      () => assertEvidenceMatchesAuthorization({ ...VALID, artifactDigest: DIGEST_B }, expected),
      "EVIDENCE_MISMATCH",
    );
    const { artifactDigest: _d, ...ev } = VALID;
    expectStateError(
      () => assertEvidenceMatchesAuthorization(ev, expected),
      "EVIDENCE_MISMATCH",
    );
  });
});

describe("deployment host runner evidence channel", () => {
  let root: string;
  let layout: Layout;
  let db: ReturnType<typeof openDb>;
  let canonicalRepo: string;
  const taskId = "task_delivery_evidence_probe";
  const saved = { workspace: process.env.GRANDE_WORKSPACE, control: process.env.GRANDE_CONTROL };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "delivery-evidence-runner-"));
    process.env.GRANDE_WORKSPACE = join(root, "workspace");
    process.env.GRANDE_CONTROL = join(root, "control");
    mkdirSync(process.env.GRANDE_WORKSPACE, { recursive: true });
    mkdirSync(process.env.GRANDE_CONTROL, { recursive: true });

    layout = loadLayout();
    ensureLayout(layout);
    canonicalRepo = join(layout.workspaceRoot, "demo");
    const worktree = join(layout.worktreesRoot, "demo", taskId);
    mkdirSync(canonicalRepo, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    saveRegistry(layout, [{ repoId: "demo", path: canonicalRepo, registered: true }]);

    db = openDb(layout);
    createTask(db, {
      taskId,
      repoId: "demo",
      branch: "grande/delivery-evidence-probe",
      baseCommit: "base",
      worktreePath: worktree,
      state: "READY",
    });
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
    if (saved.workspace === undefined) delete process.env.GRANDE_WORKSPACE;
    else process.env.GRANDE_WORKSPACE = saved.workspace;
    if (saved.control === undefined) delete process.env.GRANDE_CONTROL;
    else process.env.GRANDE_CONTROL = saved.control;
  });

  function writeProfile(script: string): void {
    writeFileSync(
      join(layout.configDir, "profiles.yaml"),
      `repos:\n  demo:\n    deploy-production:\n      argv: [${JSON.stringify(process.execPath)}, "-e", ${JSON.stringify(script)}]\n      timeoutSeconds: 30\n      execution: deployment-host\n`,
      "utf8",
    );
  }

  async function runJob(): Promise<Record<string, unknown>> {
    const started = startDeploymentHostJob(
      { db, layout },
      { taskId, repoId: "demo", profileName: "deploy-production" },
    );
    await awaitDeploymentHostJobSettled(started.jobId);
    const job = getJob(db, started.jobId)!;
    return { state: job.state, ...(job.summary as Record<string, unknown>) };
  }

  it("injects GRANDE_DELIVERY_EVIDENCE_FILE and persists file evidence in the job summary", async () => {
    writeProfile([
      'const fs = require("node:fs");',
      "if (!process.env.GRANDE_DELIVERY_EVIDENCE_FILE) process.exit(3);",
      `fs.writeFileSync(process.env.GRANDE_DELIVERY_EVIDENCE_FILE, ${JSON.stringify(JSON.stringify(VALID))});`,
    ].join(""));
    const summary = await runJob();
    expect(summary.state).toBe("passed");
    expect(summary.evidence).toEqual(VALID);
    expect(summary.evidenceError).toBeUndefined();
  });

  it("ignores evidence-looking stdout and reports the missing file", async () => {
    writeProfile(`process.stdout.write(${JSON.stringify(JSON.stringify(VALID))});`);
    const summary = await runJob();
    expect(summary.state).toBe("passed");
    expect(summary.evidence).toBeUndefined();
    expect(summary.evidenceError).toMatchObject({ code: "EVIDENCE_MISSING" });
  });

  it("reports invalid evidence file content as a structured error", async () => {
    writeProfile([
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.GRANDE_DELIVERY_EVIDENCE_FILE, "{not json");',
    ].join(""));
    const summary = await runJob();
    expect(summary.evidence).toBeUndefined();
    expect(summary.evidenceError).toMatchObject({ code: "EVIDENCE_INVALID" });
  });
});
