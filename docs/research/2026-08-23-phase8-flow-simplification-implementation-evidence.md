# Phase 8 Flow Simplification — Implementation Evidence

Date: 2026-08-23
Task: `task-p8-20260823-001`

## Scope

Phase 8 implements the no-tool-epoch portion of the owner-approved flow-simplification design:

- `GG-BL-020`: internal `local | pr | deploy` delivery-target primitive and status projection without changing the public TaskBrief schema;
- `GG-BL-021`: fixed 5-second bounded observation in `grande_run`, preserving stable jobId/recovery semantics for longer jobs;
- `GG-BL-022`: normal status guidance enters `grande_pr_merge` directly, with `grande_pr_status` reserved for diagnostics; verifier continuation remains a second entry into the existing merge gate;
- `GG-BL-023`: formal L1/L2/L3 development-risk classifier aligned with existing host verification levels.

The public `TaskBrief.deliveryTarget` schema field remains intentionally deferred to Phase 9 / the next formal Tool Epoch, matching the approved proposal's Phase A/Phase B split.

## Safety / compatibility boundaries

No public tool is added, removed or renamed. No input schema or annotation is changed. No workflow engine, second lifecycle table, merge worker, verifier merge authority, arbitrary shell, or new production capability is introduced.

`grande_run` still creates and owns jobs through the existing runner. Phase 8 only observes the already-persisted job for at most 5 seconds using the existing `waitForTerminalJob`; if the job is still live, the original stable `jobId + pollAfterSeconds + grande_run_result` recovery path remains.

PR simplification does not modify `src/prLifecycle.ts`. Every merge attempt therefore still re-reads current PR head, CI, current-SHA attestation and host receipt. Existing regressions continue to reject old-SHA CI/attestation and old-SHA outer-test receipts.

Risk mapping is fail-closed:

- L1 → host `none`;
- L2 → host `smoke`;
- L3 → host `full`;
- unknown path → L3/full.

Manual-only host boundaries remain controlled by the existing trusted host manifest and are not downgraded by the new development-risk label.

## TDD evidence

RED evidence was observed before each primitive existed:

1. development-risk tests failed on missing `src/developmentRisk.ts`;
2. delivery-target tests failed on missing `src/deliveryTarget.ts`, then caught direct-running-state and stale `pr_status` semantics;
3. flow wrapper tests failed on missing `src/flowSimplification.ts`;
4. production wiring initially exposed two meaningful regressions: old `CI unknown → pr_status` expectations and accidental hiding of the established `grande gc` ghost-task recovery hint. Both were corrected before GREEN.

Latest pre-commit candidate verification after core implementation:

- `unit-selfhost`: **112 files / 870 tests PASS**;
- `typecheck`: PASS.

A final exact-SHA verification is still required after the documentation/test evidence in this file is committed.

## Required L3 closeout gates

This task changes `src/tools.ts` and the host-sensitive tool execution path, so the existing classifier requires L3/full verification and a manual-only host boundary. Phase 8 is not considered closed until the exact candidate SHA has:

1. fresh `unit-selfhost + typecheck` attestation;
2. independent GitHub CI;
3. independent L3 review evidence;
4. exact-SHA Host outer-test receipt where required by the merge gate;
5. successful exact-SHA merge gate;
6. production activation/readback if this behavior is activated in production.

Until those gates pass, this document is implementation evidence, not a Phase 8 closeout claim.
