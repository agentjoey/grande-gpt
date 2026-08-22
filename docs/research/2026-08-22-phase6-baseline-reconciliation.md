# GrandeGPT Phase 6 Baseline Reconciliation

Date: 2026-08-22
Task: `task-p6-20260822-001`
Canonical base at task open: `e33da09f15dab29182ffa93f4be1034312da232a`

## Sources checked

Phase 6 starts from current code and formal evidence, not from chat memory. The reconciliation read:

- `docs/BACKLOG.md`
- `docs/research/2026-08-22-phase5.5-closeout.md`
- `docs/research/2026-08-22-reliability-host-verifier-closeout.md`
- `docs/superpowers/specs/2026-08-21-grande-gpt-reliability-and-automated-host-verifier-design.md`
- `docs/superpowers/plans/2026-08-21-reliability-and-automated-host-verifier.md`
- current `src/hostVerification*.ts`, `src/hostVerifier*.ts`, `src/prHostVerification.ts`, `src/prLifecycle.ts`, `src/taskProgress.ts`, `src/tools.ts`, `src/localLoopTools.ts`, and related tests.

## Canonical backlog result

`GG-BL-001`, `002`, `003`, `004`, and `013` already satisfied their Phase 5.5 Done criteria and were already archived. They remain archived. `GG-BL-013` is now explicitly recorded as superseded by the controlled Automated Host Verifier path rather than interpreted as a requirement for recurring Human-run outer-test.

`GG-BL-010` remains independent P0/MITIGATED. The Human Owner supplied a fresh 2026-08-22 post-activation recurrence in which an existing GrandeGPT conversation returned `The GrandeGPT tool has been disabled.` on direct `grande_task_status`. This is evidence that verification execution and ChatGPT App/session binding are separate planes.

No equivalent S19/S20 backlog item existed. `GG-BL-015` and `GG-BL-016` were unallocated and are therefore the next canonical IDs.

## Activation timeline reconciliation

The Reliability D3 closeout is an **activation-ready historical snapshot**, not an activation receipt: at the time that document was written, it correctly said production mode remained `manual` pending the required soak and Owner approval. Phase 6 starts after the later controlled activation explicitly confirmed by the Human Owner.

This is a timeline progression, not a specification contradiction. Phase 6 must not rewrite D3 history to imply it was already active then.

At Phase 6 discovery time, the production read probe exposed:

- `gatewayBuild=git:e47c4b37ba66a75eaff42d1102f8f5c41a306998`
- `toolsetEpoch=2`
- `toolsCount=25`
- `toolsDigest=sha256:7f9d2a32ae1f0b1982f8f462c5bfe7b994e02d88466edadd74cffd5ca1eee815`

The final Phase 6 exact-SHA merge gate must independently demonstrate that the running production coordinator is in auto mode; if it instead returns `manual_required`, that is a material activation contradiction and a Human stop condition.

## Current architecture facts

The auto verifier is already a same-Gateway restricted execution path. `host-verification.yaml` is trusted control-plane state; missing config defaults to manual and malformed values fail closed. Auto mode creates one production `HostVerifierCoordinator`; it accepts only task/repo/exact SHA/level and does not accept arbitrary argv/cwd/env.

The coordinator permits at most one active verifier. Identical requests coalesce and different requests observe `busy`; there is no queue. Job rows, terminal summaries, bounded artifacts, Receipt V2, task/PR head checks, and runtime identity already exist and are the state sources Phase 6 must reuse.

The merge gate already implements most of the old retry policy: candidate test failure is non-retryable; one infrastructure failure allows one bounded re-dispatch on the next merge-gate invocation; two consecutive infrastructure failures escalate to Human. Exact-SHA filtering already prevents old-SHA retry history from being reused.

The remaining Phase 6 gaps are:

1. no single minimal operational snapshot exposes the required last-attempt/success/failure/runtime fields;
2. failure classification is still represented mainly as `test` vs `infrastructure`, not the approved candidate/infrastructure/integrity taxonomy;
3. integrity conditions such as trusted result/receipt binding mismatch are fail-closed for merge eligibility but are not yet projected as explicit zero-retry Human escalation;
4. activation residue needs a bounded, evidence-based cleanup pass and closeout documentation.

## Clean baseline

Before Phase 6 edits:

- `unit-selfhost`: 97 files / 808 tests PASS
- `typecheck`: PASS

No baseline blocker exists.
