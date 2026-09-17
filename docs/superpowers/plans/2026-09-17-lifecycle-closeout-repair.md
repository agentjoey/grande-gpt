# Lifecycle closeout repair

Status: implementation candidate, independent review and production acceptance pending.

Task: `task-gg-lifecycle-closeout-repair-20260917-001`  
Branch: `grande/lifecycle-closeout-repair-7001`  
Review base: `041cdf27f16f7f7792421a2db2706c7ce7dea177`  
Worktree: `/Users/xtation/AgentWorks/GPT_Workspace/.grande-work/worktrees/grande-gpt/task-gg-lifecycle-closeout-repair-20260917-001`

## Approved scope and implementation

The Owner approved repairing production-default lifecycle projection and evidence-only reconciliation of historical CLOSED PR tasks. This is L3 because it writes trusted merge evidence. It does not authorize self-acceptance, a new public tool contract, a generic execution channel, or second-batch resource governance.

`taskProgress.ts` now observes actual filesystem and Safe Git state. The same dirty-state observation feeds the existing core projection; read failures are not interpreted as clean. Eligibility checks all nonterminal job rows, exact current head against the durable merge receipt, and persisted deployment/authorization obligations even when local deploy configuration is absent. Eligibility remains a candidate for controlled reconciliation, not permission to delete. Removed archived code is unknown rather than blocked; tests are done only when exact-head historical attestation exists, explicitly labeled historical rather than freshly rerun. The status response no longer describes proven successful cleanup as a ghost requiring GC.

`prMergeD2.ts` routes an already-CLOSED task to `closedTaskReconcile.ts` before the worktree-dependent base handler. The new path resolves the registered canonical repository and its origin, reads the PR for the trusted task branch, and validates PR number/URL/state/head/base plus the latest trusted local attestation and its passed job. A real two-parent merge must contain that exact head as its second parent; the first parent supplies historical base evidence, not the moving GitHub base SHA. The merge must be included in canonical history and the original task base must be an ancestor of its first parent. No fetch, remote merge, branch mutation, worktree recreation, or cleanup occurs.

The existing outer merge-tool repo write lock still applies. After remote reads, task/repository identity and worktree absence are checked again. The original task stateVersion is retained. `recordClosedTaskPrMerged` then rechecks CLOSED/version/jobs/latest attestation/delivery obligations inside one SQLite write transaction, preserving immutable receipt identity. Receipt updates and their successful audit commit together; audit failure rolls back both. Identical replay leaves receipt timestamps and audit count unchanged. Normal active-task merge and deployment code in the core modules is not rewritten.

## Verification sequence and recorded evidence

1. Reproduce default-path and historical CLOSED failures with a real temporary Git repository, linked worktree, merge, removal and SQLite database. Only the remote API is substituted for historical reconciliation.
2. Implement projection and recovery, then add production `buildTools` status-path coverage.
3. Test persisted delivery obligations independently of config and prove the version guard through mutation.
4. Restore default Vitest selection, run complete selfhost/typecheck, commit and publish a review candidate. Independent review and exact-head CI/Host gates precede merge; production activation and historical reconciliation follow merge.

| Check | Job | Observed result |
| --- | --- | --- |
| Default-path / historical regression RED | `job_f28f864f-1a03-4da7-9538-34725c209dfb` | Failed on missing/default projection and worktree-dependent historical path; one fixture column typo was subsequently corrected. |
| Focused GREEN | `job_db1c5898-b1ed-47ec-9e1e-9a073821e6f7` | 29 tests passed. |
| Initial proportional regression | `job_157f68b2-2040-41b4-aafb-db26b136fe1b` | 21 files / 153 tests passed. |
| Missing-config persisted-delivery RED | `job_cf678e4f-4519-4303-8a6e-2dd4b0cf8d5a` | Four new tests exposed incorrect eligible=true. |
| Version-guard mutation | `job_35b9e38e-8b5d-41ce-ae0e-59db9d92df7d` | Replacing the original task version with the post-read version caused exactly one failure; 156 other tests passed. |
| Restored proportional GREEN | `job_ea681a10-dab0-486b-bb5f-619be3ba8232` | 22 files / 157 tests passed, including all 35 new tests. |

Temporary test selection was required because `grande_run` accepts profiles, not test arguments. Filtered unit results are not full-suite evidence. Before final verification, `vitest.config.ts` was restored to SHA-256 `c8b2864c57e8fab20401a2f0eadc5b5fab533f643d3f3d6e4766cbcb43f51993`; the version mutation was restored to helper SHA-256 `cf5803e5f547be0c4978aa6fbfc8ea72bc324af8d4f8789c2170339adbb8c93e`. Final full-suite jobs and the exact candidate SHA belong in the PR/controlled attestation; do not infer them from filtered results.

## Bounded independent review request

Review this branch relative to the review base, plus the direct callers only. Focus on real default-path I/O, nonterminal jobs masked by stage projection, persisted delivery evidence, prevention of duplicate external writes, canonical/PR/task identity binding, merge-parent proof, stale-version refusal and atomic audit rollback. Verify that `buildTools` still supplies repo locking and argument validation and that the public tool schema remains unchanged. Existing successful tests may be reused for unchanged code; findings that change behavior require targeted revalidation before final gates.

Relevant tests are the three `tests/lifecycleCloseout*.test.ts` files and existing taskPrReceipt, prLifecycle, D2, taskProgress, deliveryTarget and flowSimplification suites. Author inspection is not independent review. The connected capability registry has no reviewer or Pact action; no independent acceptance is claimed here.

## Limits and production acceptance

Recovery deliberately refuses local/deploy targets, any persisted deployment or authorization row, missing/latest-conflicting attestation, live jobs, dirty canonical state, reappeared worktree, unknown local commit objects, or non-two-parent merge history. These cases require explicit evidence resolution, never guessed receipt data. Recovered receipt timestamps are observation timestamps, not invented historical merge times. An existing conflicting receipt is preserved.

After independent acceptance, CI and the required exact-SHA Host gate, merge through the controlled tool and activate the resulting canonical build using the established Owner path. Then explicitly invoke the existing `grande_pr_merge` reconciliation entrypoint for:

- `task-gg-lifecycle-governance-20260916-001` (PR 53)
- `task-gg-lifecycle-governance-20260917-004` (PR 54)
- `task-gg-lifecycle-integration-fix-20260917-001` (PR 55, existing receipt)

Read back exact receipt/completed/blocker/archived stages and repeat recovery to verify idempotence. Preserve all historical task records. Do not run GC, rebuild worktrees, modify production SQLite through an alternate channel, or mark the first batch accepted before these readbacks. As of this candidate preparation, production remains at the review base and no historical production receipt has been repaired by this task.
