# Lifecycle Task 3 — Authorization expiry convergence

Implementation candidate; independent review and human acceptance remain pending.

- Task: `task-gg-lifecycle-governance-20260916-001`
- Branch: `grande/lifecycle-governance-6001`
- Task 3 review base: `336366d66fd0d50dc029fb5c4b71fb7bea5696ff`
- Initial Task 3 candidate: `8792be08a81b8c2fec4f81461df95f9f59c7631d`
- Worktree: `/Users/xtation/AgentWorks/GPT_Workspace/.grande-work/worktrees/grande-gpt/task-gg-lifecycle-governance-20260916-001`

## Scope

Only expired READY/APPROVED authorizations converge to EXPIRED. The status/binding-digest CAS and successful audit share one SQLite write transaction; a CAS miss or audit failure rolls both back. Repeated or competing reconciliation produces no duplicate successful event. EXECUTING remains outside approval-TTL expiry; its separate execution deadline is unchanged.

Startup/periodic lifecycle reconciliation and delivery prepare use the expiry helper. Revalidation preserves its existing audit identity while using the same atomic expiry path. Direct `createAuthorization` now converges only its own task's expired slot before admission and rechecks the active unique slot inside the insert transaction. Fresh READY/APPROVED and EXECUTING authorizations still block replacement.

Production files: `src/authorizationExpiry.ts`, `src/deliveryAuthorization.ts`, `src/deliveryReadiness.ts`, `src/taskLifecycleScheduler.ts`.

The existing uncommitted Task 3 implementation was preserved. The initial closeout added the direct-create fix and six tests, including two real Worker threads with separate SQLite connections released through a shared barrier. No task/worktree recreation, reset, rollback, cleanup, push, merge, or deployment was performed.

## Verification evidence

| Check | Evidence | Result |
| --- | --- | --- |
| Direct-create RED | `job_e99836d9-3463-4640-b87b-ef3334002ca2` | Expired READY and APPROVED each incorrectly blocked a new proposal. |
| Initial focused GREEN | `job_9fd9adfb-a065-45aa-9964-95d31819e9b2` | 2 files / 12 tests passed. |
| Initial proportional regression | `job_9a0d513a-d276-4333-a53b-4f0a9cf1ea82` | 7 files / 96 tests passed; exitCode 0. Applies to the initial candidate, before the scheduler correction below. |
| Scheduler failure-isolation RED | `job_c5bc25a0-9157-41d6-9ada-4b4f24d0b1a7` | 2 failures: task recovery errors at startup and periodic phases left expired authorizations APPROVED. |
| Scheduler correction GREEN | `job_714d663e-563b-417c-bf03-9ec7a681c3f2` | 2 files / 10 tests passed; exitCode 0. Includes real SQLite expiry, audit-failure rollback/retry, concurrency, and the existing scheduler happy path. |

Initial regression files: `authorizationExpiryCloseout`, `authorizationExpiryReconciliation`, `authorizationExpiryPrepareIntegration`, `authorizationExpiryRevalidate`, `taskLifecycleScheduler`, `deliveryAuthorization`, and `deliveryReadiness` under `tests/*.test.ts`. The scheduler correction reran only `authorizationExpiryCloseout` and `taskLifecycleScheduler`; the earlier 96-test result is not represented as a fresh run on the corrected candidate.

`grande_run` accepts profiles only. The unit jobs above used a temporary task-local Vitest include and are not full-suite/selfhost evidence. Before each final typecheck and commit, `vitest.config.ts` was restored byte-for-byte to SHA-256 `c8b2864c57e8fab20401a2f0eadc5b5fab533f643d3f3d6e4766cbcb43f51993`. The default-config typecheck result and candidate SHA are recorded in the controlled commit attestation, not inferred from these filtered unit jobs.

## Author-review correction

A task-recovery exception previously skipped the approval-TTL sweep in the same startup/periodic cycle. The scheduler now catches the two operations separately while retaining the existing timer, execution order, and non-overlap guard. Each error is reported through the existing callback; a combined success result is emitted only when both operations succeed. No new scheduler or lifecycle state was introduced.

Three added regression cases verify durable expiry after startup/periodic recovery failures and rollback/retry after an expiry audit failure. This correction changes only `src/taskLifecycleScheduler.ts`, `tests/authorizationExpiryCloseout.test.ts`, and this record relative to the initial candidate.

## Review boundary

Review only Task 3 relative to the review base above and its direct callers: atomic state/audit rollback, stale-candidate CAS, active-slot admission, concurrent expiry, exclusion of EXECUTING, and scheduler error isolation. Author checks and test results are not independent acceptance. The capability registry was checked again on September 17, 2026: only native capabilities are available; no independent reviewer is registered. Independent review must be performed by a separate reviewer, for example in Codex, before recording acceptance.

Task 1/2 are not redesigned; Task 4 and second-batch resource governance are not started. The full selfhost/CI/Host gate remains deferred until the first batch forms a complete candidate. Keep the original task, branch, and worktree for review.
