# Resource & Performance Governance Implementation Plan

> Execute the approved B2-1 through B2-5 scope in the existing controlled task. Preserve hard review, Host and production activation gates; do not restart design for reversible implementation details.

**Goal:** Bound managed execution, disposable storage and read-path cost without weakening lifecycle evidence or introducing a scheduler platform.

**Architecture:** Existing TypeScript, SQLite job/task records, macOS Seatbelt and controlled tool assembly. Reserve before consuming resources; supervisors own cancellation and settlement; retain evidence while pruning disposable data. Query observations live for one request only.

**Spec:** `docs/superpowers/specs/2026-09-16-grande-gpt-lifecycle-resource-governance-design.md`.

**Approved detail:** Owner-approved September 17 batch-2 plan and autonomous execution authorization. The original seven items are retained in five reviewable slices: admission includes low disk; directory pagination and query deduplication precede status pagination.

**Task:** `task-gg-resource-governance-20260917-001` on `grande/resource-performance-governance-7001`.
**Review base:** `93693b68102e27cb98f77b0db797e32853d588b7`.
**Production baseline:** epoch 3 / 25 tools / digest `sha256:d5243888a58a440b05147d8e5baeb3713e92833720c5dd403901493ff555b496`.

## Global constraints

- No generic shell, raw PID/signal input, secondary workflow engine or second Task state machine.
- Control policy comes only from fixed trusted control-plane paths, never repository configuration or MCP arguments.
- Active, dirty, unpushed, uncertain or unresolved-delivery worktrees are not TTL garbage.
- Task/job/audit/attestation/PR/Host/activation records, checkpoints, backups and pinned release sources are not ordinary retention targets.
- Preserve first-batch CLOSED/default-path and exact-evidence semantics. Status never writes lifecycle state or invents historical PASS.
- Reuse relevant verified results. Run focused RED/GREEN while iterating, full candidate checks at review/release boundaries.
- Independent L3 review is not author review, CI or a Host test. At task creation the capability registry contained no independent reviewer or activation capability; these remain real release dependencies.
- Publish cancel and status pagination together in one intentional contract release. Do not silently expose new inputs under epoch 3 or include unrelated GG-BL-024 convergence.

## B2-1: Admission and low-disk protection

**Files:** `resourcePolicy.ts`, `resourceAdmission.ts`, `jobs.ts`, `runner.ts`, `dependencyBootstrapTools.ts`, `hostVerifierLauncher.ts`, `hostVerifierRuntime.ts`, `hostVerifierRecovery.ts`, task-open/tool wiring and error mapping.

The existing running job row is the reservation. A SQLite `BEGIN IMMEDIATE` transaction validates READY/no close intent and checks per-task/global capacity before inserting the owner-bound preparation row. Dependency materialization is a short-lived managed job; installation and product execution hand off sequentially. Matching bootstrap requests continue to coalesce. Verifiers retain a single-verifier limit in addition to the shared budget.

Trusted `config/resource-policy.json` has `globalJobs`, `perTaskJobs`, `minFreeBytes`; absent file uses provisional 2/1/2 GiB defaults. Validate bounded positive values, reject unknown fields and symlinks. Check actual workspace/derived/control/artifact/additional destination volumes before fetch/worktree creation, install/copy or spawn. The check is not a filesystem quota. Never block recovery reads merely for low disk.

Ownership metadata survives summary replacement. A live owner still preparing or persisting evidence is not dead work. A dead-owner launch window without a recorded pgid stays occupied and requires recovery inspection; no TTL fabricates extinction. A recorded old live pgid alone does not authorize a kill. Public run preparation uses the existing repository lock, released before bounded result waiting.

- [ ] Verify pre-spawn reservation, same-task/global races, two real SQLite connections, bootstrap/verifier overlap and failed insertion.
- [ ] Verify low-disk/unknown destination/invalid policy and real `buildTools` task-open/run paths.
- [ ] Preserve terminal CAS, bootstrap reuse, first-batch recovery and Host behavior in proportional/full regression.

**Initial evidence:** ordinary RED `job_cbccead2-1f47-4e97-ab0a-e6188a03e1cb`; recovery RED `job_0cad2f90-6e3d-4542-8bbd-16e67dfcba43`; entrypoint RED `job_955c0a3d-e1ee-4e60-b599-babc5a9ce1ae`. The fixture volume reported approximately 64.5 GB available, not a host capacity/throughput benchmark or measurement of every production volume. Full selfhost exposed an old artifact-failure fixture which now fails too early at disk admission; move its simulated writer failure after admission to preserve the intended settlement test.

## B2-2: Controlled cancellation

**Files:** existing sandbox/runner/bootstrap/verifier supervision, a narrow owner-bound cancellation primitive and its tests. Reuse the primitive in the public cancel tool in B2-5.

Consume only taskId/jobId. Same-process trusted ownership plus the current job binding is required before asking the owning supervisor to abort. Persist request/audit before signal; keep state running until actual settlement. Preparing cancellation prevents later spawn/cache publication. Already terminal results are immutable and repeat cancellation is idempotent. Ordinary cancellation cannot touch production deploy/rollback. Unknown ownership after restart fails closed, never signals a stored integer blindly.

- [ ] Real child/group tests for cooperative and escalated termination; no stale timers after natural completion.
- [ ] Cancel during preparation, execution and settlement; wrong task, duplicate cancel, natural completion race, unavailable owner.
- [ ] Keep artifacts/audit/reservation aligned; retain capacity if process extinction is unknown.

## B2-3: Bounded retention

**Files:** narrow managed resource inventory/plan/apply, cache reference/usage integration, artifact report semantics and trusted maintenance CLI/log rotation.

Dry-run before apply. Bound scanned entries, deletion count and bytes; revalidate ownership, references, path identity and terminal state at apply. Expire only reproducible caches, terminal job temporary data and eligible diagnostic output. Do not remove evidence needed by open tasks, pending review/verification/deployment or rollback. Run-log rotation must reopen the active writer; do not unlink a live log descriptor. Cleanup failures cannot suppress task/authorization recovery.

- [ ] Dry-run has no deletion; unreadable/protected items are reported.
- [ ] Stale plan, symlink substitution, resource becoming active and partial deletion all fail closed.
- [ ] Deleted optional artifacts are explicitly reported as retained metadata/content pruned, not job failure.
- [ ] Production rollout starts with inventory/dry-run; no invented reclaimed-byte claim.

## B2-4: Request-local observations and byte-aware directory pages

**Files:** `repoMap.ts`, existing status/context/progress assembly and narrow observation/query helpers.

Share HEAD/branch/dirty/changed-files/jobs/attestations/evidence only within a read request. No cached status result may authorize merge, cleanup or deployment. Proven archived tasks never spawn Git against removed worktrees. Avoid another core-wrapper layer; consolidate existing observation work at its current assembly points.

Bound serialized bytes and entries with room for envelope/context. A safe cursor walks a static tree completely without duplicates or a full-tree traversal on every page. Validate cursor structure, bind it to the managed root, preserve symlink/.git/node_modules/.grande-work exclusions, and define changed-tree continuation semantics. An oversize item is a bounded explicit error, never an endlessly repeated cursor.

- [ ] Count actual Git/DB/file work through `buildTools`; next request sees fresh changes.
- [ ] Multibyte/escaped/long/deep paths stay within complete MCP response budget.
- [ ] No traversal outside managed roots; malformed/stale cursor is rejected or restarted explicitly.

## B2-5: Compact/paginated status and one contract release

**Files:** task/job queries and status assembly, narrow cancellation ToolDef, public contract/consumption tests and compatibility runbook updates.

Default bounded overview contains task/repo/state/phase/wait/blocker/nextAction/live job information. Detail/history are explicit bounded pages. SQL page selection precedes expensive projection. Bind cursors to query conditions and stable ordering; preserve uncertainty and fail-closed cleanup. Runtime/activation identity remains at response level.

Expose a cancel tool with taskId/jobId only and honest destructive/read-only annotations. Add the minimum status view/page/cursor inputs; preserve existing taskId calls. Bump the candidate epoch once, determine count/digest from actual tool definitions, and test full tool assembly. No deployment activation, App refresh or fresh-conversation readback is claimed from unit tests.

- [ ] Paginate large task/job/attestation histories without reading/projecting everything first.
- [ ] Confirm strict input validation, exact tool identity, unchanged existing authorization and target isolation.
- [ ] Independent review, candidate selfhost/typecheck/CI/Host gate, controlled merge, activation, App refresh and live readback before release completion.

## Verification and handoff

Use registered `unit` with a temporary focused include during RED/GREEN only; restore `vitest.config.ts` byte-for-byte to SHA-256 `c8b2864c57e8fab20401a2f0eadc5b5fab533f643d3f3d6e4766cbcb43f51993` before a candidate commit/full gate. `unit-selfhost` is the canonical sandbox-safe regression selection; Host-sensitive cases use the trusted Host path. Do not label filtered unit runs full selfhost evidence.

Keep reviewable commits on the original batch-2 task. Preserve worktree and branch until all acceptance/release dependencies are satisfied. No unrequested resource deletion, first-batch reopening, unrelated project cleanup or production configuration mutation.
