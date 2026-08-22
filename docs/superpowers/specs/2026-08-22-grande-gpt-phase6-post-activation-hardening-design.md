# GrandeGPT Phase 6 — Post-Activation Hardening Design

Date: 2026-08-22
Status: APPROVED by Human Owner instruction
Baseline: `docs/research/2026-08-22-phase6-baseline-reconciliation.md`
Upstream verifier design: `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md`

## 1. Goal

Automated Host Verifier is already activated. Phase 6 hardens the production operating boundary so the verifier is observable, failures are classified and escalated correctly, bounded transient recovery remains safe, and activation residue is cleaned without creating a new platform.

The phase does **not** redesign how host verification executes.

## 2. Architectural invariant

The execution path remains:

```text
eligible exact SHA
  -> trusted same-Gateway coordinator
  -> restricted one-shot Host Verifier
  -> trusted job/result + Receipt V2
  -> merge gate re-reads PR/CI/SHA
```

No generic `host_exec`, `shell_exec`, arbitrary host argv/cwd/env, generic unsandboxed profile, workflow engine, second connector path, or new CI/observability platform may be introduced.

## 3. S19 — Operational visibility

Add a small pure projection over existing trusted `job` / receipt / runtime identity. The status surface must expose at least:

- `mode`, `enabled`, `state: idle | running | blocked`
- `lastAttemptAt`, `lastAttemptSha`, `lastResult`, `lastDurationMs`
- `lastSuccessAt`, `lastSuccessSha`
- `lastFailureAt`, `lastFailureClass`, `lastFailureReason`
- `activeJobId`, `queueDepth`
- `verifierBuild`, `verifierVersion`

`queueDepth` is `0` because the coordinator does not queue; it coalesces identical work and returns busy for a different request.

The projection must use persisted/control-plane state and current runtime identity, never grep logs. It may add safe response fields to existing `grande_task_status`; it must not add a new MCP tool or change input schema/annotations.

Task-specific status may include current-SHA correlation so a historical successful job can be shown as historical without being represented as the current SHA's verification result.

## 4. S20 — Failure taxonomy and escalation

Trusted failure classes are:

```ts
type HostVerifierFailureClass = "candidate" | "infrastructure" | "integrity";
```

Candidate failures are verifier test/invariant RED. They receive bounded diagnostics, zero automatic retry, and block merge until code changes to a new SHA.

Infrastructure failures are execution-environment failures such as temporary launcher/runner failure, process crash, timeout/resource termination, or Gateway restart interruption. The existing bounded policy remains: at most one automatic re-dispatch for the same exact SHA; the next consecutive infrastructure failure escalates and stops automatic retry.

Integrity failures include trusted SHA/result/receipt binding mismatch, verifier-result identity mismatch, policy/safety rejection, or equivalent fail-closed conditions. They receive zero automatic retry and immediately return Human escalation. They must never be converted to merge-ready.

A SHA change starts a fresh verification identity. Old candidate/infra/integrity attempts remain audit history but cannot supply current retry count or current verification readiness.

## 5. S21 — Activation residue cleanup

This is an operational reconciliation, not a GC project. Inspect known Phase 5.5, Reliability/Verifier, migration/activation tasks and current active task inventory. Remove only safely identifiable obsolete worktrees/branches/artifacts through existing lifecycle operations.

Preserve active tasks, current trusted production verifier config, trusted receipts/results, audits, and closeout documentation. If a systemic `CLOSED` task + residual worktree condition is found, append evidence to `GG-BL-005`; do not implement a new garbage collector in Phase 6.

Cleanup must be safe to repeat.

## 6. S22 — Reliability boundary

Closeout documentation must maintain two distinct planes:

```text
Verification execution plane:
GrandeGPT -> controlled Automated Host Verifier -> exact-SHA trusted verification

ChatGPT control plane:
ChatGPT conversation -> App/tool binding -> GrandeGPT MCP
```

The first is automated. The second still has independent `GG-BL-010` P0 session/App binding drift. A verifier PASS is not evidence that ChatGPT binding is fixed.

## 7. Verification discipline

For behavior changes:

1. write a failing behavioral/failure test;
2. verify the RED reason;
3. implement the minimum change;
4. run `unit-selfhost`;
5. run `typecheck`.

Host-only invariants that selfhost cannot establish use the already-approved exact-SHA Host Verifier. No generic host execution is permitted.

Final proof must cover PASS, candidate failure, transient/persistent infrastructure failure, integrity failure, SHA drift isolation, operational visibility, and residue reconciliation.

## 8. Stop conditions

Stop only if implementation needs a broader verifier/host safety boundary, generic unsandboxed execution, materially contradicts formal verifier design/closeout, requires new production privilege/credential, still fails a load-bearing proof after two reasonable fixes, or discovers a new data/security/outage P0.
