# GrandeGPT Phase 6 — Post-Activation Hardening Closeout

Date: 2026-08-22
Task: `task-p6-20260822-001`
Status: implementation complete; final exact-SHA automatic Host Verifier receipt is the authoritative host proof for this candidate.

## Scope

Phase 6 starts after controlled Automated Host Verifier activation. It does not redesign host execution. The delivered hardening is limited to operational visibility, bounded failure classification/escalation, activation-residue reconciliation, and an explicit reliability boundary between host verification and ChatGPT App/session binding.

No generic `host_exec`, `shell_exec`, arbitrary host argv/cwd/env, generic unsandboxed profile, workflow engine, multi-agent orchestration, metrics/observability platform, new CI/CD platform, or Connector bypass was added. Existing exact-SHA, Receipt V2, Gateway policy, tool annotations, and single-verifier concurrency remain intact.

## S19 — Auto Verifier Operational Visibility

The existing `grande_task_status` response now carries a bounded `hostVerifier` operational snapshot derived from persisted trusted job state plus current runtime identity. No new MCP tool, metrics store, log scraper, or queue was introduced.

The snapshot exposes:

- `mode`, `enabled`, `state` (`idle | running | blocked`)
- `lastAttemptAt`, `lastAttemptSha`, `lastResult`, `lastDurationMs`
- `lastSuccessAt`, `lastSuccessSha`
- `lastFailureAt`, `lastFailureClass`, `lastFailureReason`
- `activeJobId`, `queueDepth`
- `verifierBuild`, `verifierVersion`
- task-detail correlation via `currentSha` / `currentResult`

`queueDepth` is always `0` because the production coordinator still coalesces an identical active request and reports busy for a different request rather than maintaining a queue.

Behavior tests prove that a trusted PASS reports its SHA and duration, a running verifier is visible, a candidate RED reports class/reason, and a historical old-SHA PASS remains historical while `currentResult` for a different current SHA stays null.

## S20 — Failure Classification and Escalation

The trusted failure taxonomy is now explicit:

- `candidate`: verifier test/invariant RED. Zero automatic retry; merge remains blocked until code changes to a new SHA.
- `infrastructure`: execution-environment failure. At most one automatic retry for the same exact SHA; a second consecutive infrastructure failure escalates to Human.
- `integrity`: trusted result/receipt/SHA/policy identity failure. Zero automatic retry; immediate fail-closed Human escalation.

The trusted runtime now persists `failureClass` and bounded `reason` for normal candidate and infrastructure failures while retaining legacy booleans for compatibility. Receipt V2 validation projects current-SHA binding/policy/identity mismatch as explicit integrity failure. Old-SHA receipts or attempts remain audit history and are not escalated or reused for a new exact SHA.

A RED-first load-bearing test exposed a real pre-fix defect: an integrity attempt was recognized by inspection but `grande_pr_merge` had no integrity branch, so it fell through to a new verifier dispatch. The merge gate now handles integrity before dispatch and returns `human_gate`, `retryable=false`, with no coordinator launch.

Load-bearing behavioral proofs cover:

1. candidate RED -> no retry -> merge blocked;
2. transient infrastructure RED -> exactly one bounded retry -> recovery can later merge after a valid trusted receipt;
3. two consecutive infrastructure REDs -> Human escalation, no further retry;
4. integrity RED -> zero retry -> immediate fail closed;
5. candidate SHA change -> old candidate/infrastructure/integrity verification state is not reused.

The final S20 selfhost gate is **97 test files / 817 tests PASS** and `typecheck` PASS.

## S21 — Activation Residue Reconciliation

Cleanup used only the existing task/worktree lifecycle and was intentionally a reconciliation pass, not a new GC subsystem.

The known completed implementation tasks were checked directly from control-plane state:

- `task-p55-20260819-001`: `CLOSED`, worktree absent, `cleanupRequired=false`.
- `task-reliability-hostverifier-20260821-001`: `CLOSED`, worktree absent, `cleanupRequired=false`.

The active-task inventory contains the current Phase 6 task plus unrelated Urbanbricks work; it contains no active GrandeGPT verifier activation/migration residue. Trusted attestations, audit history, verifier evidence, production config, and closeout documentation were preserved.

A repeated reconciliation therefore requires no destructive action. No `CLOSED + residual worktree` systemic sample was found, so Phase 6 adds no new evidence to `GG-BL-005` and does not build a GC framework.

## S22 — Reliability Boundary

Two reliability planes are now explicitly separate:

```text
Verification execution plane:
GrandeGPT
  -> controlled Automated Host Verifier
  -> exact-SHA trusted verification / Receipt V2
  -> merge gate

ChatGPT control plane:
ChatGPT conversation
  -> App/tool binding
  -> GrandeGPT MCP
```

The verification execution plane is automated and hardened by Phase 6.

The ChatGPT control plane still has independent P0 `GG-BL-010`. On 2026-08-22, after Automated Host Verifier activation, an existing GrandeGPT conversation again returned `The GrandeGPT tool has been disabled.` on direct `grande_task_status`. That recurrence is not a Host Verifier failure and is not evidence that the Gateway/verifier execution plane failed. Conversely, an automatic verifier PASS is not evidence that `GG-BL-010` is fixed.

`GG-BL-013` remains DONE/Archive: its old Human-run outer-test execution concept has been superseded by controlled automatic Host Verifier execution while retaining the same exact-SHA trusted merge boundary.

Automated Host Verifier activation remains COMPLETE as the Phase 6 baseline. `GG-BL-010` remains independently P0/MITIGATED according to its own evidence and is not forced to DONE for phase closeout.

## Verification discipline

The Phase 6 task preserved RED -> minimal implementation -> `unit-selfhost` -> `typecheck` discipline. The final code-level regression gate before closeout documentation is:

- `unit-selfhost`: **97 files / 817 tests PASS**
- `typecheck`: **PASS**

A fresh final gate is run again after this closeout candidate is complete. The authoritative host-only proof is intentionally not copied into this file after execution: the controlled Host Verifier receipt is bound to the exact committed PR head. Editing this document after that PASS would create a new SHA and invalidate the proof.

## Final exact-SHA release condition

For the final committed candidate, `grande_pr_merge` must demonstrate the already-activated production path:

```text
eligible exact SHA
  -> auto verifier starts / is observed
  -> trusted PASS + Receipt V2 for the same SHA
  -> merge gate re-reads PR / CI / mergeability / SHA
  -> merge allowed
```

If production instead reports `manual_required`, Phase 6 does not reinterpret that as success: it is a material contradiction with the approved activation baseline and triggers the Human Owner stop condition.

After exact-SHA PASS and merge, no post-proof repository edit is required; the trusted receipt/audit/PR state remains the authoritative final evidence.
